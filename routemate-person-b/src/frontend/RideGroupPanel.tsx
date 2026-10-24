/* RouteSync Phase 4 — the ride-group surface for a pooled ride.
   Everything here is keyed by ride_id and talks to the Phase 3 endpoints:
     GET  /api/rides/:id/participants  → masked roster (masking is server-side)
     GET  /api/rides/:id/messages      → the ride's shared group chat
     POST /api/rides/:id/messages      → send (field name: body)
     GET  /api/rides/:id/locations     → who is live-sharing right now

   Access + unlocking are enforced by the backend (RLS + requireRideMembership),
   never here: a caller who isn't an accepted rider simply gets 403 and the
   panel shows a locked notice. A 503 means the migration isn't applied yet.
   No new dependencies, no Tailwind — CSS variables from tokens.css + inline. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";
import { buildGoogleMapsLink } from "../safety";

interface RideGroupPanelProps {
  rideId: string;
  currentUserId?: string;
}

interface RideParticipant {
  user_id: string;
  role: string;
  display_name: string | null;
  is_verified: boolean;
  seats_requested: number | null;
  pickup_label: string | null;
  dropoff_label: string | null;
  details_visible: boolean;
}

interface RideChatMessage {
  id: string;
  sender_id: string;
  sender_name: string | null;
  body: string;
  created_at: string;
  mine: boolean;
}

interface RideLocation {
  user_id: string;
  display_name: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  heading: number | null;
  updated_at: string;
  mine: boolean;
}

const CHAT_POLL_MS = 4_000;
const LOCATIONS_POLL_MS = 8_000;
const PARTICIPANTS_POLL_MS = 15_000;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "driver":
    case "host_driver":
      return "Driver";
    case "host_rider":
    case "primary_rider":
      return "Lead rider";
    case "passenger":
    case "joiner":
      return "Rider";
    default:
      return role ? role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ") : "Rider";
  }
}

type Gate = "loading" | "open" | "locked" | "unavailable";

export default function RideGroupPanel({ rideId, currentUserId }: RideGroupPanelProps) {
  const [open, setOpen] = useState(true);
  const [gate, setGate] = useState<Gate>("loading");

  const [participants, setParticipants] = useState<RideParticipant[]>([]);
  const [messages, setMessages] = useState<RideChatMessage[]>([]);
  const [locations, setLocations] = useState<RideLocation[]>([]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  // A stable liveness flag so in-flight polls never setState after unmount.
  const aliveRef = useRef(true);

  // Turn a non-ok response into a gate state (once) and stop the noise.
  function applyGate(status: number): void {
    if (!aliveRef.current) return;
    if (status === 503) setGate("unavailable");
    else if (status === 403 || status === 401) setGate("locked");
    else if (status === 404) setGate("locked");
  }

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    async function loadParticipants() {
      try {
        const res = await authedFetch(`${API_URL}/api/rides/${encodeURIComponent(rideId)}/participants`);
        if (!res.ok) {
          if (!cancelled) applyGate(res.status);
          return;
        }
        const data = (await res.json()) as { participants?: RideParticipant[] };
        if (cancelled) return;
        setParticipants(data.participants ?? []);
        setGate((g) => (g === "loading" ? "open" : g));
      } catch {
        /* transient — keep whatever we already have */
      }
    }

    async function loadMessages() {
      try {
        const res = await authedFetch(`${API_URL}/api/rides/${encodeURIComponent(rideId)}/messages`);
        if (!res.ok) {
          if (!cancelled) applyGate(res.status);
          return;
        }
        const data = (await res.json()) as { messages?: RideChatMessage[] };
        if (cancelled) return;
        setMessages(data.messages ?? []);
      } catch {
        /* transient */
      }
    }

    async function loadLocations() {
      try {
        const res = await authedFetch(`${API_URL}/api/rides/${encodeURIComponent(rideId)}/locations`);
        if (!res.ok) {
          // Locations are optional; a locked/unavailable ride just shows none.
          return;
        }
        const data = (await res.json()) as { locations?: RideLocation[] };
        if (cancelled) return;
        setLocations(data.locations ?? []);
      } catch {
        /* transient */
      }
    }

    loadParticipants();
    loadMessages();
    loadLocations();

    const pTimer = setInterval(() => {
      if (!cancelled) loadParticipants();
    }, PARTICIPANTS_POLL_MS);
    const mTimer = setInterval(() => {
      if (!cancelled) loadMessages();
    }, CHAT_POLL_MS);
    const lTimer = setInterval(() => {
      if (!cancelled) loadLocations();
    }, LOCATIONS_POLL_MS);

    return () => {
      cancelled = true;
      aliveRef.current = false;
      clearInterval(pTimer);
      clearInterval(mTimer);
      clearInterval(lTimer);
    };
  }, [rideId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending || text.length > 2000) return;
    setSending(true);
    setChatError(null);
    const previous = input;
    setInput("");

    // Optimistic bubble; reconciled by the poll / the POST response.
    const tempId = `local_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        sender_id: currentUserId ?? "",
        sender_name: "You",
        body: text,
        created_at: new Date().toISOString(),
        mine: true,
      },
    ]);

    try {
      const res = await authedFetch(`${API_URL}/api/rides/${encodeURIComponent(rideId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Backend reads req.body.body — the message text lives under `body`.
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        applyGate(res.status);
        throw new Error(b?.error === "MESSAGE_TOO_LONG" ? "Message too long (2000 max)." : `HTTP ${res.status}`);
      }
      const posted = (await res.json()) as RideChatMessage;
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...posted, mine: true } : m)));
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(previous);
      setChatError(err instanceof Error ? err.message : "Couldn't send message.");
    } finally {
      setSending(false);
    }
  }

  const sharingCount = locations.length;

  if (gate === "unavailable") {
    return (
      <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", padding: "10px 14px" }}>
        Ride group chat &amp; live map activate once the backend migration is applied.
      </div>
    );
  }
  if (gate === "locked") {
    return (
      <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", padding: "10px 14px" }}>
        🔒 The ride group opens once you're an accepted rider on this trip.
      </div>
    );
  }

  return (
    <div
      style={{
        background: "var(--rm-paper-raised)",
        border: "1px solid var(--rm-border)",
        borderRadius: "var(--rm-radius)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          background: "var(--rm-paper)",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--rm-font-display)",
          fontSize: "12px",
          fontWeight: 600,
          letterSpacing: "0.03em",
          color: "var(--rm-ink)",
        }}
      >
        <span>
          👥 Ride group · {participants.length} rider{participants.length === 1 ? "" : "s"}
          {sharingCount > 0 ? ` · ${sharingCount} live` : ""}
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Participants (server-side masked) */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <SectionTitle>Who's on this ride</SectionTitle>
            {participants.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>Loading riders…</div>
            ) : (
              participants.map((p) => (
                <div
                  key={p.user_id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "12px",
                    color: "var(--rm-ink)",
                    padding: "6px 8px",
                    background: "var(--rm-paper)",
                    border: "1px solid var(--rm-border)",
                    borderRadius: "8px",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                    <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.display_name ?? "Rider"}
                      {p.user_id === currentUserId ? " (you)" : ""}
                    </span>
                    {p.is_verified ? <span title="Verified">✔</span> : null}
                  </span>
                  <span style={{ color: "var(--rm-ink-soft)", whiteSpace: "nowrap", textAlign: "right" }}>
                    {roleLabel(p.role)}
                    {p.details_visible && (p.pickup_label || p.dropoff_label)
                      ? ` · ${[p.pickup_label, p.dropoff_label].filter(Boolean).join(" → ")}`
                      : p.details_visible
                        ? ""
                        : " · details hidden"}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Live location (read side) */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <SectionTitle>Live locations</SectionTitle>
            {locations.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                No one is sharing yet — flip on “Share my trip” below to appear here.
              </div>
            ) : (
              locations.map((l) => (
                <div
                  key={l.user_id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "12px",
                    color: "var(--rm-ink)",
                    padding: "6px 8px",
                    background: "var(--rm-paper)",
                    border: "1px solid var(--rm-border)",
                    borderRadius: "8px",
                  }}
                >
                  <span>
                    🛰️ {l.display_name ?? "Rider"}
                    {l.mine ? " (you)" : ""}
                  </span>
                  <a
                    href={buildGoogleMapsLink(l.lat, l.lng)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--rm-route-green)", textDecoration: "none", whiteSpace: "nowrap" }}
                  >
                    View · {formatTime(l.updated_at)}
                  </a>
                </div>
              ))
            )}
          </div>

          {/* Group chat */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <SectionTitle>Group chat</SectionTitle>
            <div
              style={{
                maxHeight: "180px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "8px",
                background: "#f8f9f7",
                border: "1px solid var(--rm-border)",
                borderRadius: "8px",
              }}
            >
              {messages.length === 0 && (
                <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", textAlign: "center", marginTop: "8px" }}>
                  No messages yet — say salaam to your ride group.
                </div>
              )}
              {messages.map((m) => {
                const isMine = m.mine;
                return (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: isMine ? "flex-end" : "flex-start",
                      maxWidth: "85%",
                      background: isMine ? "var(--rm-signal)" : "var(--rm-paper-raised)",
                      color: isMine ? "var(--rm-signal-ink)" : "var(--rm-ink)",
                      padding: "8px 12px",
                      borderRadius: isMine ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                      border: isMine ? "none" : "1px solid var(--rm-border)",
                    }}
                  >
                    {!isMine && m.sender_name ? (
                      <div style={{ fontSize: "10px", fontWeight: 600, marginBottom: "2px", opacity: 0.75 }}>
                        {m.sender_name}
                      </div>
                    ) : null}
                    <div style={{ fontSize: "13px", lineHeight: "1.35", whiteSpace: "pre-wrap" }}>{m.body}</div>
                    <div style={{ fontSize: "9px", opacity: 0.6, marginTop: "3px", textAlign: "right" }}>
                      {formatTime(m.created_at)}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
            {chatError && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{chatError}</div>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSend();
              }}
              style={{ display: "flex", gap: "8px" }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message the ride group…"
                disabled={sending}
                style={{
                  flex: 1,
                  padding: "9px 12px",
                  fontSize: "13px",
                  fontFamily: "var(--rm-font-body)",
                  border: "1px solid var(--rm-border)",
                  borderRadius: "8px",
                  outline: "none",
                  background: "var(--rm-paper)",
                  color: "var(--rm-ink)",
                }}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                style={{
                  padding: "9px 14px",
                  fontFamily: "var(--rm-font-display)",
                  fontWeight: 600,
                  fontSize: "12px",
                  color: "var(--rm-signal-ink)",
                  background: "var(--rm-signal)",
                  border: "none",
                  borderRadius: "8px",
                  cursor: sending || !input.trim() ? "wait" : "pointer",
                  opacity: sending || !input.trim() ? 0.7 : 1,
                }}
              >
                Send
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "10px",
        fontFamily: "var(--rm-font-display)",
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "var(--rm-ink-soft)",
      }}
    >
      {children}
    </div>
  );
}
