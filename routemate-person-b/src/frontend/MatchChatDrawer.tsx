/* Real in-app chat for mutually confirmed carpool matches — loads/sends
   via the API (shared across both users on the same server). Day 7: verified
   badge, trip-share panel, and report/block tools. */
import { useEffect, useRef, useState } from "react";
import VerifiedBadge from "./VerifiedBadge";
import TripSharePanel from "./TripSharePanel";
import SafetyMenu from "./SafetyMenu";
import { co2SavedSummary } from "../carbonImpact";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

export interface ChatMessage {
  id: string;
  sender: "user" | "other";
  text: string;
  timestamp: string;
}

export interface ConfirmedMatchInfo {
  id: string;
  /** Server chat thread id — required for live messaging. */
  chatId?: string;
  candidateDisplayName: string;
  candidatePhone: string;
  candidateSectorFrom: string;
  candidateSectorTo: string;
  fareSharePKR: number;
  sharedDistanceKm?: number;
  riderCount?: number;
}

interface MatchChatDrawerProps {
  match: ConfirmedMatchInfo;
  onClose: () => void;
  currentUserId?: string;
  candidateUserId?: string;
  candidateIsVerified?: boolean;
  candidateVerifiedDomain?: string | null;
  safety?: { reporterId: string; rideId?: string | null; onBlocked?: () => void };
}

const DEFAULT_ICEBREAKERS = [
  "Assalam-o-Alaikum! Where should I meet you?",
  "I'll be ready at the pickup point shortly.",
  "Sharing my vehicle details in chat.",
];

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function MatchChatDrawer({
  match,
  onClose,
  currentUserId,
  candidateUserId,
  candidateIsVerified = false,
  candidateVerifiedDomain = null,
  safety,
}: MatchChatDrawerProps) {
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const chatId = match.chatId;

  async function refreshMessages(opts?: { quiet?: boolean }) {
    if (!chatId || !currentUserId) return;
    try {
      const res = await authedFetch(
        `${API_URL}/api/match-chats/${encodeURIComponent(chatId)}/messages`
      );
      if (!res.ok) {
        // 404 after an API restart with an empty store — keep existing bubbles
        // instead of wiping the UI with a scary banner.
        if (opts?.quiet || res.status === 404) {
          if (!opts?.quiet && res.status === 404) {
            setLoadError("Chat reconnecting… send again if your last message didn’t appear.");
          }
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      const next: ChatMessage[] = (payload.messages ?? []).map(
        (m: { id: string; text: string; created_at: string; mine: boolean }) => ({
          id: m.id,
          sender: m.mine ? "user" : "other",
          text: m.text,
          timestamp: formatTime(m.created_at),
        })
      );
      setMessages(next);
      setLoadError(null);
    } catch {
      if (!opts?.quiet) {
        setLoadError("Couldn't reach the chat server briefly — retrying…");
      }
    }
  }

  useEffect(() => {
    refreshMessages();
    if (!chatId) return;
    const poll = setInterval(() => refreshMessages({ quiet: true }), 2000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, currentUserId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function handleSend(textToSend?: string) {
    const text = (textToSend || input).trim();
    if (!text || !chatId || !currentUserId || sending) return;

    setSending(true);
    if (!textToSend) setInput("");

    // Optimistic bubble so a slow/restarting API doesn't look broken.
    const optimisticId = `local_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        sender: "user",
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
    ]);
    setLoadError(null);

    try {
      const res = await authedFetch(
        `${API_URL}/api/match-chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: currentUserId, text }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.details ?? body?.error ?? `HTTP ${res.status}`);
      }
      await refreshMessages({ quiet: true });
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      if (!textToSend) setInput(text);
      setLoadError(err instanceof Error ? err.message : "Couldn't send message.");
    } finally {
      setSending(false);
    }
  }

  const phoneLabel =
    match.candidatePhone && match.candidatePhone !== "Shared after confirmation"
      ? match.candidatePhone
      : "Use chat for now";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(27, 31, 39, 0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "stretch",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "460px",
          background: "var(--rm-paper-raised)",
          borderLeft: "1px solid var(--rm-border)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "var(--rm-font-body)",
          boxShadow: "-8px 0 32px rgba(27,31,39,0.2)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--rm-border)",
            background: "var(--rm-paper)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                background: "var(--rm-signal)",
                color: "var(--rm-signal-ink)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: "16px",
                fontFamily: "var(--rm-font-display)",
              }}
            >
              {match.candidateDisplayName.charAt(0)}
            </div>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--rm-ink)" }}>
                {match.candidateDisplayName}{" "}
                {candidateIsVerified && <VerifiedBadge domain={candidateVerifiedDomain} compact />}{" "}
                <span style={{ fontSize: "11px", color: "var(--rm-route-green)" }}>✓ Confirmed Match</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                {match.candidateSectorFrom} → {match.candidateSectorTo}
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: "20px",
              cursor: "pointer",
              color: "var(--rm-ink-soft)",
              padding: "4px 8px",
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: "10px 20px",
            background: "#d7ecdf",
            borderBottom: "1px solid var(--rm-border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "12px",
            color: "#0e3d24",
          }}
        >
          <span>
            Contact: <strong>{phoneLabel}</strong>
            {match.fareSharePKR > 0 ? ` · Fare share Rs ${match.fareSharePKR}` : ""}
          </span>
          {phoneLabel.startsWith("+") || /\d{7,}/.test(phoneLabel) ? (
            <a
              href={`tel:${phoneLabel}`}
              style={{
                fontSize: "11px",
                fontFamily: "var(--rm-font-display)",
                fontWeight: 600,
                color: "#0e3d24",
                background: "#bde1cb",
                padding: "4px 10px",
                borderRadius: "6px",
                textDecoration: "none",
              }}
            >
              Call
            </a>
          ) : null}
        </div>

        {(() => {
          const summary = co2SavedSummary(match.sharedDistanceKm ?? 8.5, match.riderCount ?? 2);
          if (!summary) return null;
          return (
            <div
              style={{
                padding: "8px 20px",
                background: "#eef7ee",
                borderBottom: "1px solid var(--rm-border)",
                fontSize: "12px",
                color: "#1f4d2c",
              }}
            >
              {summary}
            </div>
          );
        })()}

        <div style={{ borderBottom: "1px solid var(--rm-border)", background: "var(--rm-paper)" }}>
          <button
            type="button"
            onClick={() => setSafetyOpen((o) => !o)}
            aria-expanded={safetyOpen}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 20px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.03em",
              color: "var(--rm-ink)",
            }}
          >
            <span>Safety tools — share trip, report, block</span>
            <span>{safetyOpen ? "▲" : "▼"}</span>
          </button>

          {safetyOpen && (
            <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <TripSharePanel />
              {safety && candidateUserId && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 14px",
                    background: "var(--rm-paper-raised)",
                    border: "1px solid var(--rm-border)",
                    borderRadius: "var(--rm-radius)",
                  }}
                >
                  <span style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                    Something wrong? Report or block {match.candidateDisplayName.split(" ")[0]}.
                  </span>
                  <SafetyMenu
                    reporterId={safety.reporterId}
                    reportedUserId={candidateUserId}
                    reportedDisplayName={match.candidateDisplayName}
                    rideId={safety.rideId ?? null}
                    onBlocked={safety.onBlocked}
                    align="right"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            background: "#f8f9f7",
          }}
        >
          {!chatId && (
            <div style={{ fontSize: "13px", color: "var(--rm-danger)" }}>
              Chat thread missing — accept the match again while the API is running.
            </div>
          )}
          {loadError && (
            <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{loadError}</div>
          )}
          {chatId && messages.length === 0 && !loadError && (
            <div style={{ fontSize: "13px", color: "var(--rm-ink-soft)", textAlign: "center", marginTop: "24px" }}>
              Say salaam — messages here go to {match.candidateDisplayName.split(" ")[0]} in real time.
            </div>
          )}
          {messages.map((msg) => {
            const isUser = msg.sender === "user";
            return (
              <div
                key={msg.id}
                style={{
                  alignSelf: isUser ? "flex-end" : "flex-start",
                  maxWidth: "80%",
                  background: isUser ? "var(--rm-signal)" : "var(--rm-paper-raised)",
                  color: isUser ? "var(--rm-signal-ink)" : "var(--rm-ink)",
                  padding: "10px 14px",
                  borderRadius: isUser ? "14px 14px 2px 14px" : "14px 14px 14px 2px",
                  border: isUser ? "none" : "1px solid var(--rm-border)",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ fontSize: "13px", lineHeight: "1.4" }}>{msg.text}</div>
                <div
                  style={{
                    fontSize: "10px",
                    opacity: 0.65,
                    marginTop: "4px",
                    textAlign: "right",
                    fontFamily: "var(--rm-font-display)",
                  }}
                >
                  {msg.timestamp}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div
          style={{
            padding: "8px 16px",
            background: "var(--rm-paper)",
            borderTop: "1px solid var(--rm-border)",
            display: "flex",
            gap: "6px",
            overflowX: "auto",
          }}
        >
          {DEFAULT_ICEBREAKERS.map((chip, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSend(chip)}
              disabled={!chatId || sending}
              style={{
                fontSize: "11px",
                whiteSpace: "nowrap",
                padding: "4px 10px",
                background: "var(--rm-paper-raised)",
                border: "1px solid var(--rm-border)",
                borderRadius: "999px",
                color: "var(--rm-ink-soft)",
                cursor: !chatId || sending ? "wait" : "pointer",
              }}
            >
              {chip}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--rm-border)",
            background: "var(--rm-paper-raised)",
            display: "flex",
            gap: "8px",
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message to your carpool mate…"
            disabled={!chatId || sending}
            style={{
              flex: 1,
              padding: "10px 14px",
              fontSize: "14px",
              fontFamily: "var(--rm-font-body)",
              border: "1px solid var(--rm-border)",
              borderRadius: "var(--rm-radius)",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={!chatId || sending}
            style={{
              padding: "10px 16px",
              fontFamily: "var(--rm-font-display)",
              fontWeight: 600,
              fontSize: "12px",
              color: "var(--rm-signal-ink)",
              background: "var(--rm-signal)",
              border: "none",
              borderRadius: "var(--rm-radius)",
              cursor: !chatId || sending ? "wait" : "pointer",
              opacity: !chatId || sending ? 0.7 : 1,
            }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
