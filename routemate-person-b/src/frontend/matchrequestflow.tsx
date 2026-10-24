/* Two-sided ride approval UI. Nothing here confirms a ride — sending a
   request (SendRequestModal) starts the handshake, and this panel is
   where each side takes their turn: the recipient answers with their
   conditions, the requester gives (or withholds) the final OK. The chat
   only exists after that last step, enforced server-side too. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { authedFetch } from "./demoAuth";
import { API_URL } from "./apiBase";

export interface MatchRequestView {
  id: string;
  status: "pending" | "awaiting_requester" | "confirmed" | "declined" | "cancelled" | "expired";
  role: "requester" | "recipient";
  peer_user_id: string;
  peer_name: string;
  from_user_id: string;
  from_name: string;
  to_user_id: string;
  to_name: string;
  from_trip_request_id: string | null;
  to_trip_request_id: string | null;
  /** Set when the request asks to join a host driver's carpool group. */
  group: {
    host_user_id: string;
    host_trip_request_id: string;
    group_id: string;
  } | null;
  preferences: {
    gender_preference: "any" | "male_only" | "female_only";
    departure_time: string;
    flexibility_minutes: number;
    max_co_passengers: number;
    vehicle_type: "none" | "car" | "bike" | "ride_hailing";
    pickup_note: string;
    note: string;
  };
  conditions: null | {
    agrees_to_preferences: boolean;
    pickup_spot: string;
    departure_time_note: string;
    gender_preference: "any" | "male_only" | "female_only";
    max_co_passengers: number | null;
    fare_agreed: boolean;
    note: string;
  };
  snapshot: {
    origin_label: string;
    destination_label: string;
    origin: { lat: number; lng: number; address_label: string };
    destination: { lat: number; lng: number; address_label: string };
    overlap_pct: number;
    detour_added_minutes: number;
    match_type: "peer_share" | "owner_passenger" | "shared_ride_hailing";
    fare_share_from_pkr: number;
    fare_share_to_pkr: number;
  };
  chat_id: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  confirmed_at: string | null;
  expires_at: string;
}

export interface SendRequestValues {
  genderPreference: "any" | "male_only" | "female_only";
  flexibilityMinutes: number;
  maxCoPassengers: number;
  pickupNote: string;
  note: string;
}

// ── shared little formatters ─────────────────────────────────────────

function formatDeparture(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function flexLabel(minutes: number): string {
  return minutes > 0 ? `±${minutes} min` : "exact";
}

function capLabel(cap: number): string {
  if (cap === -1) return "No passenger limit";
  if (cap === 0) return "Solo — no other passengers";
  return `Up to ${cap} other passenger${cap === 1 ? "" : "s"}`;
}

const VEHICLE_LABEL: Record<string, string> = {
  none: "No vehicle declared",
  car: "🚗 Car",
  bike: "🏍️ Bike",
  ride_hailing: "🚕 Shared ride-hailing",
};

const GENDER_LABEL: Record<string, string> = {
  any: "Any gender",
  male_only: "Male only",
  female_only: "Female only",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontFamily: "var(--rm-font-display)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--rm-ink-soft)",
};

const cardStyle: CSSProperties = {
  fontFamily: "var(--rm-font-body)",
  background: "var(--rm-paper-raised)",
  border: "1.5px solid var(--rm-border)",
  borderRadius: "calc(var(--rm-radius) + 4px)",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const chipStyle: CSSProperties = {
  fontSize: "11px",
  fontFamily: "var(--rm-font-display)",
  fontWeight: 600,
  background: "var(--rm-paper)",
  border: "1px solid var(--rm-border)",
  padding: "3px 8px",
  borderRadius: "6px",
  color: "var(--rm-ink)",
  whiteSpace: "nowrap",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box" as const,
  fontFamily: "var(--rm-font-body)",
  fontSize: "13px",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid var(--rm-border)",
  background: "var(--rm-paper)",
  color: "var(--rm-ink)",
};

const labelStyle: CSSProperties = {
  fontSize: "11px",
  fontFamily: "var(--rm-font-display)",
  fontWeight: 600,
  color: "var(--rm-ink-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  display: "block",
  marginBottom: "3px",
};

function PrimaryButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: "10px",
        fontFamily: "var(--rm-font-display)",
        fontSize: "12px",
        fontWeight: 600,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        color: danger ? "var(--rm-alert, #b3261e)" : "var(--rm-signal-ink)",
        background: danger ? "transparent" : "var(--rm-signal)",
        border: danger ? "1px solid var(--rm-alert, #b3261e)" : "none",
        borderRadius: "var(--rm-radius)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** One-line "what the other person asked for / answered with" chips. */
function PreferenceChips({ r }: { r: MatchRequestView }) {
  const p = r.preferences;
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
      <span style={chipStyle}>🕒 {formatDeparture(p.departure_time)} ({flexLabel(p.flexibility_minutes)})</span>
      <span style={chipStyle}>👥 {capLabel(p.max_co_passengers)}</span>
      <span style={chipStyle}>🚻 {GENDER_LABEL[p.gender_preference]}</span>
      <span style={chipStyle}>{VEHICLE_LABEL[p.vehicle_type] ?? p.vehicle_type}</span>
      <span style={chipStyle}>
        🔀 {r.snapshot.overlap_pct}% overlap · +{r.snapshot.detour_added_minutes} min
      </span>
    </div>
  );
}

// ── SendRequestModal ─────────────────────────────────────────────────

export function SendRequestModal({
  peerName,
  groupInfo,
  originLabel,
  destinationLabel,
  departureTime,
  myFareSharePkr,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  peerName: string;
  /** When the target is a carpool group (host driver + riders already
   *  in the car), the composer speaks "join the group" instead of
   *  "request a ride from a stranger". */
  groupInfo?: { hostName: string; memberNames: string[] };
  originLabel: string;
  destinationLabel: string;
  /** "HH:MM" from the search form — shown as the planned departure. */
  departureTime: string;
  myFareSharePkr: number;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: SendRequestValues) => void;
  onCancel: () => void;
}) {
  const [genderPreference, setGenderPreference] = useState<"any" | "male_only" | "female_only">("any");
  const [flexibilityMinutes, setFlexibilityMinutes] = useState(15);
  const [maxCoPassengers, setMaxCoPassengers] = useState(-1);
  const [pickupNote, setPickupNote] = useState("");
  const [note, setNote] = useState("");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 18, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 70,
        padding: "16px",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...cardStyle,
          width: "100%",
          maxWidth: "440px",
          maxHeight: "88vh",
          overflowY: "auto",
          gap: "12px",
        }}
      >
        <div>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--rm-ink)", fontFamily: "var(--rm-font-display)" }}>
            {groupInfo ? `Request to join ${groupInfo.hostName}'s carpool group` : `Send a ride request to ${peerName}`}
          </div>
          <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", marginTop: "3px" }}>
            {originLabel} → {destinationLabel} · departing ~{departureTime} · your share Rs {myFareSharePkr.toFixed(0)}
          </div>
          {groupInfo && groupInfo.memberNames.length > 0 && (
            <div style={{ fontSize: "12px", color: "var(--rm-ink)", marginTop: "5px" }}>
              👥 Already in the car: {groupInfo.memberNames.join(", ")}
            </div>
          )}
          {groupInfo && groupInfo.memberNames.length === 0 && (
            <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", marginTop: "5px" }}>
              👥 You'd be the first rider to join {groupInfo.hostName.split(" ")[0]}'s car
            </div>
          )}
        </div>

        <div
          style={{
            fontSize: "11px",
            background: "var(--rm-paper)",
            border: "1px dashed var(--rm-border)",
            borderRadius: "8px",
            padding: "7px 10px",
            color: "var(--rm-ink-soft)",
          }}
        >
          Nothing is confirmed until both sides approve. {groupInfo ? groupInfo.hostName : peerName}{" "}
          will see everything you share below, and you'll get the final say after the answer
          comes back.
        </div>

        <div>
          <label style={labelStyle} htmlFor="rm-req-gender">Gender preference</label>
          <select
            id="rm-req-gender"
            style={inputStyle}
            value={genderPreference}
            onChange={(e) => setGenderPreference(e.target.value as "any" | "male_only" | "female_only")}
          >
            <option value="any">Any gender</option>
            <option value="female_only">Female only</option>
            <option value="male_only">Male only</option>
          </select>
        </div>

        <div>
          <label style={labelStyle} htmlFor="rm-req-flex">Time flexibility</label>
          <select
            id="rm-req-flex"
            style={inputStyle}
            value={flexibilityMinutes}
            onChange={(e) => setFlexibilityMinutes(Number(e.target.value))}
          >
            <option value={0}>Exact — no wiggle</option>
            <option value={15}>±15 minutes</option>
            <option value={30}>±30 minutes</option>
            <option value={60}>±1 hour</option>
            <option value={120}>±2 hours</option>
          </select>
        </div>

        <div>
          <label style={labelStyle} htmlFor="rm-req-cap">Max other passengers</label>
          <select
            id="rm-req-cap"
            style={inputStyle}
            value={maxCoPassengers}
            onChange={(e) => setMaxCoPassengers(Number(e.target.value))}
          >
            <option value={-1}>No limit</option>
            <option value={0}>Solo only — just me</option>
            <option value={1}>At most 1 other</option>
            <option value={2}>At most 2 others</option>
            <option value={3}>At most 3 others</option>
          </select>
        </div>

        <div>
          <label style={labelStyle} htmlFor="rm-req-pickup">Pickup note (optional)</label>
          <input
            id="rm-req-pickup"
            style={inputStyle}
            maxLength={200}
            placeholder="e.g. Blue area near F-8 Jinnah Islamic Plaza clock"
            value={pickupNote}
            onChange={(e) => setPickupNote(e.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="rm-req-note">Message to {peerName} (optional)</label>
          <textarea
            id="rm-req-note"
            style={{ ...inputStyle, minHeight: "64px", resize: "vertical" }}
            maxLength={500}
            placeholder="Anything they should know before deciding…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {error && (
          <div
            style={{
              fontSize: "12px",
              background: "var(--rm-alert-tint, #fdecea)",
              border: "1px solid var(--rm-alert, #b3261e)",
              borderRadius: "8px",
              padding: "8px 10px",
              color: "var(--rm-ink)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px" }}>
          <PrimaryButton
            disabled={submitting}
            onClick={() => onSubmit({ genderPreference, flexibilityMinutes, maxCoPassengers, pickupNote: pickupNote.trim(), note: note.trim() })}
          >
            {submitting ? "Sending…" : groupInfo ? "Send join request" : "Send request"}
          </PrimaryButton>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "10px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.03em",
              color: "var(--rm-ink-soft)",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "var(--rm-radius)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recipient-side pending card (the conditions form) ────────────────

function IncomingPendingCard({
  request,
  onChanged,
}: {
  request: MatchRequestView;
  onChanged: () => void;
}) {
  const [agrees, setAgrees] = useState(false);
  const [fareAgreed, setFareAgreed] = useState(false);
  const [pickupSpot, setPickupSpot] = useState("");
  const [departureTimeNote, setDepartureTimeNote] = useState("");
  const [genderComfort, setGenderComfort] = useState<"any" | "male_only" | "female_only">("any");
  const [capOverride, setCapOverride] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bothTicked = agrees && fareAgreed;

  async function respond(decision: "accept" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`${API_URL}/api/match-requests/${request.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          conditions: {
            agrees_to_preferences: agrees,
            fare_agreed: fareAgreed,
            pickup_spot: pickupSpot.trim(),
            departure_time_note: departureTimeNote.trim(),
            gender_preference: genderComfort,
            max_co_passengers: capOverride === "" ? null : Number(capOverride),
            note: note.trim(),
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.details ?? body?.error ?? "Couldn't send your answer — try again.");
        return;
      }
      onChanged();
    } catch {
      setError("Network error — your answer wasn't sent.");
    } finally {
      setBusy(false);
    }
  }

  const p = request.preferences;
  // Incoming group join: the recipient is the host driver and this rider
  // wants to join their car — label it as a group request, not a solo one.
  const joinsMyGroup =
    request.group != null && request.group.host_user_id === request.to_user_id;
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--rm-ink)", fontFamily: "var(--rm-font-display)" }}>
        {request.from_name} {joinsMyGroup ? "wants to join your carpool group" : "wants to ride with you"}
      </div>
      {joinsMyGroup && (
        <div>
          <span style={chipStyle}>👥 Group join request</span>
        </div>
      )}
      <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
        {request.snapshot.origin_label} → {request.snapshot.destination_label} · their share Rs{" "}
        {request.snapshot.fare_share_from_pkr.toFixed(0)}, you Rs {request.snapshot.fare_share_to_pkr.toFixed(0)}
      </div>

      <PreferenceChips r={request} />

      {(p.pickup_note || p.note) && (
        <div style={{ fontSize: "12px", color: "var(--rm-ink)", background: "var(--rm-paper)", borderRadius: "8px", padding: "8px 10px" }}>
          {p.pickup_note && <div>📍 {p.pickup_note}</div>}
          {p.note && <div style={{ marginTop: p.pickup_note ? "4px" : 0 }}>💬 “{p.note}”</div>}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--rm-border)", paddingTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "var(--rm-ink)", cursor: "pointer" }}>
          <input type="checkbox" checked={agrees} onChange={(e) => setAgrees(e.target.checked)} style={{ marginTop: "3px" }} />
          <span>
            I'm OK with their preferences{" "}
            <span style={{ color: "var(--rm-ink-soft)", fontSize: "11px" }}>(required — {GENDER_LABEL[p.gender_preference].toLowerCase()}, {capLabel(p.max_co_passengers).toLowerCase()})</span>
          </span>
        </label>
        <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", color: "var(--rm-ink)", cursor: "pointer" }}>
          <input type="checkbox" checked={fareAgreed} onChange={(e) => setFareAgreed(e.target.checked)} style={{ marginTop: "3px" }} />
          <span>
            I agree to the fare split{" "}
            <span style={{ color: "var(--rm-ink-soft)", fontSize: "11px" }}>(required — Rs {request.snapshot.fare_share_to_pkr.toFixed(0)} your share)</span>
          </span>
        </label>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "160px" }}>
            <label style={labelStyle}>Pickup spot (optional)</label>
            <input style={inputStyle} maxLength={200} placeholder="Where should I pick up / meet?" value={pickupSpot} onChange={(e) => setPickupSpot(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: "160px" }}>
            <label style={labelStyle}>Timing condition (optional)</label>
            <input style={inputStyle} maxLength={200} placeholder="e.g. Can't leave before 8:15" value={departureTimeNote} onChange={(e) => setDepartureTimeNote(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "140px" }}>
            <label style={labelStyle}>Your gender comfort</label>
            <select style={inputStyle} value={genderComfort} onChange={(e) => setGenderComfort(e.target.value as "any" | "male_only" | "female_only")}>
              <option value="any">Any gender</option>
              <option value="female_only">Female only</option>
              <option value="male_only">Male only</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: "140px" }}>
            <label style={labelStyle}>Passenger cap</label>
            <select style={inputStyle} value={capOverride} onChange={(e) => setCapOverride(e.target.value)}>
              <option value="">No change</option>
              <option value="-1">No limit</option>
              <option value="0">Solo only</option>
              <option value="1">Max 1 other</option>
              <option value="2">Max 2 others</option>
              <option value="3">Max 3 others</option>
            </select>
          </div>
        </div>
        <div>
          <label style={labelStyle}>Message back (optional)</label>
          <textarea style={{ ...inputStyle, minHeight: "52px", resize: "vertical" }} maxLength={500} placeholder="Conditions they should know about…" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {error && (
          <div style={{ fontSize: "12px", color: "var(--rm-alert, #b3261e)" }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: "10px" }}>
          <PrimaryButton disabled={!bothTicked || busy} onClick={() => respond("accept")}>
            {busy ? "Sending…" : "Accept & share my conditions"}
          </PrimaryButton>
          <button
            type="button"
            onClick={() => respond("decline")}
            disabled={busy}
            style={{
              flex: 1,
              padding: "10px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.03em",
              color: "var(--rm-ink-soft)",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "var(--rm-radius)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Decline
          </button>
        </div>
        {!bothTicked && (
          <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
            Tick both boxes above to enable accepting.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────

export default function MatchRequestsPanel({
  userId,
  onOutgoingChange,
  onConfirmed,
}: {
  userId: string;
  onOutgoingChange: (outgoing: MatchRequestView[]) => void;
  onConfirmed: (request: MatchRequestView, chatId: string, rideId?: string | null) => void;
}) {
  const [incoming, setIncoming] = useState<MatchRequestView[]>([]);
  const [outgoing, setOutgoing] = useState<MatchRequestView[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest callback in a ref so the 4s poll never re-subscribes
  // because the parent re-rendered with a new closure.
  const onOutgoingChangeRef = useRef(onOutgoingChange);
  onOutgoingChangeRef.current = onOutgoingChange;

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await authedFetch(`${API_URL}/api/users/${userId}/match-requests`);
      if (!res.ok) return;
      const payload = await res.json();
      const inc = (payload.incoming ?? []) as MatchRequestView[];
      const out = (payload.outgoing ?? []) as MatchRequestView[];
      setIncoming(inc);
      setOutgoing(out);
      onOutgoingChangeRef.current(out);
    } catch {
      /* poll errors are transient — the next tick retries */
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setIncoming([]);
      setOutgoing([]);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [userId, refresh]);

  async function postJson(url: string, body: Record<string, unknown>): Promise<any | null> {
    setBusyId(url);
    setError(null);
    try {
      const res = await authedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.details ?? payload?.error ?? "Something went wrong — try again.");
        return null;
      }
      return payload;
    } catch {
      setError("Network error — try again.");
      return null;
    } finally {
      setBusyId(null);
    }
  }

  async function cancelOutgoing(r: MatchRequestView) {
    const ok = await postJson(`${API_URL}/api/match-requests/${r.id}/cancel`, {});
    if (ok) void refresh();
  }

  async function withdraw(r: MatchRequestView) {
    const ok = await postJson(`${API_URL}/api/match-requests/${r.id}/finalize`, { decision: "withdraw" });
    if (ok) void refresh();
  }

  async function confirmFinal(r: MatchRequestView) {
    const payload = await postJson(`${API_URL}/api/match-requests/${r.id}/finalize`, { decision: "confirm" });
    if (!payload) return;
    const request = payload.request as MatchRequestView;
    const chatId = payload.chat_id as string;
    await refresh();
    // The server folded this pairing into the car's own ride row (one per
    // car, owned by whoever hosts it) — the UI must not mint a second one.
    if (request && chatId) onConfirmed(request, chatId, payload.ride_id ?? null);
  }

  // Confirmed requests are surfaced as the chat the server created on
  // finalize — the panel never re-renders them, so filter them out here.
  const visibleIncoming = incoming.filter((r) => !dismissed.has(r.id) && r.status !== "confirmed");
  const visibleOutgoing = outgoing.filter((r) => !dismissed.has(r.id) && r.status !== "confirmed");
  const hasAnything = visibleIncoming.length > 0 || visibleOutgoing.length > 0;

  if (!userId || !hasAnything) return null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {error && (
        <div
          style={{
            fontSize: "12px",
            background: "var(--rm-alert-tint, #fdecea)",
            border: "1px dashed var(--rm-alert, #b3261e)",
            borderRadius: "8px",
            padding: "8px 12px",
            color: "var(--rm-ink)",
          }}
        >
          {error}
        </div>
      )}

      {visibleIncoming.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <h2 style={sectionTitleStyle}>📥 Ride requests for you</h2>
          {visibleIncoming.map((r) => {
            if (r.status === "pending") {
              return <IncomingPendingCard key={r.id} request={r} onChanged={refresh} />;
            }
            if (r.status === "awaiting_requester") {
              return (
                <div key={r.id} style={{ ...cardStyle, borderStyle: "dashed" }}>
                  <div style={{ fontSize: "13px", color: "var(--rm-ink)" }}>
                    ✅ You accepted — waiting for {r.from_name} to give the final OK.
                  </div>
                  {r.conditions && (
                    <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                      Your conditions: {r.conditions.pickup_spot || "pickup as proposed"}
                      {r.conditions.departure_time_note ? ` · ${r.conditions.departure_time_note}` : ""}
                      {r.conditions.max_co_passengers !== null ? ` · cap ${r.conditions.max_co_passengers}` : ""}
                      {r.conditions.gender_preference !== "any" ? ` · ${GENDER_LABEL[r.conditions.gender_preference]}` : ""}
                      {r.conditions.note ? ` · “${r.conditions.note}”` : ""}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                <span>
                  {r.status === "declined" ? `You declined ${r.from_name}'s request` : r.status === "expired" ? `Request from ${r.from_name} expired` : `Request with ${r.from_name} closed`} — {formatDeparture(r.preferences.departure_time)} · {r.snapshot.origin_label} → {r.snapshot.destination_label}
                </span>
                <button type="button" onClick={() => setDismissed((d) => new Set(d).add(r.id))} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--rm-ink-soft)", cursor: "pointer", fontSize: "14px" }} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {visibleOutgoing.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <h2 style={sectionTitleStyle}>📤 Your ride requests</h2>
          {visibleOutgoing.map((r) => {
            if (r.status === "pending") {
              return (
                <div key={r.id} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <div style={{ fontSize: "13px", color: "var(--rm-ink)" }}>
                      ⏳ Waiting for <strong>{r.to_name}</strong> to respond · {r.snapshot.origin_label} → {r.snapshot.destination_label}
                    </div>
                    <button
                      type="button"
                      onClick={() => cancelOutgoing(r)}
                      disabled={busyId !== null}
                      style={{
                        padding: "6px 12px",
                        fontFamily: "var(--rm-font-display)",
                        fontSize: "11px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        color: "var(--rm-ink-soft)",
                        background: "transparent",
                        border: "1px solid var(--rm-border)",
                        borderRadius: "8px",
                        cursor: busyId !== null ? "not-allowed" : "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  <PreferenceChips r={r} />
                </div>
              );
            }
            if (r.status === "awaiting_requester") {
              return (
                <div key={r.id} style={{ ...cardStyle, borderColor: "var(--rm-route-green)" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-route-green)", fontFamily: "var(--rm-font-display)" }}>
                    {r.to_name} accepted — your call now
                  </div>
                  {r.conditions && (
                    <div style={{ fontSize: "12px", color: "var(--rm-ink)", background: "var(--rm-paper)", borderRadius: "8px", padding: "8px 10px" }}>
                      <div>📍 {r.conditions.pickup_spot || "Pickup as proposed"}</div>
                      {r.conditions.departure_time_note && <div>🕒 {r.conditions.departure_time_note}</div>}
                      {r.conditions.gender_preference !== "any" && <div>🚻 Comfortable with: {GENDER_LABEL[r.conditions.gender_preference]}</div>}
                      {r.conditions.max_co_passengers !== null && <div>👥 {capLabel(r.conditions.max_co_passengers)}</div>}
                      {r.conditions.note && <div>💬 “{r.conditions.note}”</div>}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "10px" }}>
                    <PrimaryButton disabled={busyId !== null} onClick={() => confirmFinal(r)}>
                      Confirm & open chat
                    </PrimaryButton>
                    <button
                      type="button"
                      onClick={() => withdraw(r)}
                      disabled={busyId !== null}
                      style={{
                        flex: 1,
                        padding: "10px",
                        fontFamily: "var(--rm-font-display)",
                        fontSize: "12px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.03em",
                        color: "var(--rm-ink-soft)",
                        background: "transparent",
                        border: "1px solid var(--rm-border)",
                        borderRadius: "var(--rm-radius)",
                        cursor: busyId !== null ? "not-allowed" : "pointer",
                      }}
                    >
                      Withdraw
                    </button>
                  </div>
                </div>
              );
            }
            if (r.status === "confirmed") return null;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                <span>
                  {r.status === "declined"
                    ? `${r.to_name} declined your request`
                    : r.status === "expired"
                    ? `Your request to ${r.to_name} expired (no answer within 24h)`
                    : `Request to ${r.to_name} cancelled`}{" "}
                  — {r.snapshot.origin_label} → {r.snapshot.destination_label}
                </span>
                <button type="button" onClick={() => setDismissed((d) => new Set(d).add(r.id))} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--rm-ink-soft)", cursor: "pointer", fontSize: "14px" }} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}