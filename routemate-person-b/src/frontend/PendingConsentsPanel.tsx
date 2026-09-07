/* Day 9: the UI half of group consent. A rider is asked to vote
 * whenever a join to a ride they're on would bring the pool to 3+
 * total riders (see poolingCapacity.ts / respond_to_ride_consent()).
 * This panel is a notification inbox — the rider doesn't know the
 * ride_id/booking_id in advance, so it's driven entirely by
 * GET /api/users/:id/pending-consents, not a specific-ride lookup. */
import { useEffect, useState, type CSSProperties } from "react";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

interface PendingConsent {
  ride_id: string;
  booking_id: string;
  requested_at: string;
  expires_at?: string | null;
  origin_label?: string;
  destination_label?: string;
  departure_time?: string;
  joining_rider_name: string;
}

/** "Expires in 12m", "Expires in <1m", or null once/if there's no
 *  deadline on the row (shouldn't happen post-migration, but the
 *  panel shouldn't crash on an older booking either). */
function formatCountdown(expiresAt: string | null | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const msLeft = new Date(expiresAt).getTime() - now;
  if (msLeft <= 0) return "Expiring…";
  const minutesLeft = Math.ceil(msLeft / 60_000);
  return minutesLeft <= 1 ? "Expires in <1m" : `Expires in ${minutesLeft}m`;
}

const cardStyle: CSSProperties = {
  background: "var(--rm-paper-raised)",
  border: "1px solid var(--rm-border)",
  borderRadius: "var(--rm-radius)",
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

export default function PendingConsentsPanel({ userId }: { userId: string }) {
  const [pending, setPending] = useState<PendingConsent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [outcomeNotice, setOutcomeNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Ticks the countdown text between the 20s data polls below — the
  // deadline itself lives server-side, this is purely so "Expires in
  // 12m" doesn't sit frozen for 20 seconds at a time.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, []);

  async function refresh() {
    try {
      const res = await authedFetch(`${API_URL}/api/users/${userId}/pending-consents`);
      if (res.status === 503) {
        // Group consent isn't enabled on this database yet — stay
        // silent rather than showing an error for a feature that
        // simply hasn't been migrated in yet.
        setPending([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      setPending(payload.pending ?? []);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't check for pending ride approvals.");
    }
  }

  useEffect(() => {
    if (!userId) return;
    refresh();
    // Lightweight poll — this is a "someone needs your answer" inbox,
    // so it should update without the rider having to refresh the page.
    const interval = setInterval(refresh, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function respond(item: PendingConsent, agree: boolean) {
    setRespondingId(item.booking_id);
    setOutcomeNotice(null);
    try {
      const res = await authedFetch(
        `${API_URL}/api/rides/${item.ride_id}/bookings/${item.booking_id}/consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rider_id: userId, agree }),
        }
      );
      const payload = await res.json();
      if (!res.ok) {
        setOutcomeNotice(
          payload?.error === "USER_ID_MISMATCH"
            ? "Couldn't record your vote — please try again."
            : payload?.reason === "CONSENT_EXPIRED"
            ? `Too late — nobody finished voting in time, so ${item.joining_rider_name}'s seat request was automatically cancelled.`
            : `Couldn't record your vote (${payload?.reason ?? payload?.error ?? "unknown error"}).`
        );
      } else if (payload.reason === "ALL_AGREED") {
        setOutcomeNotice(`✅ Everyone agreed — ${item.joining_rider_name} is now in the pool.`);
      } else if (payload.reason === "DECLINED") {
        setOutcomeNotice(agree
          ? `That join was declined by someone else in the group.`
          : `You declined — ${item.joining_rider_name}'s seat request was cancelled.`);
      } else {
        setOutcomeNotice(`Your answer is recorded — still waiting on the rest of the group.`);
      }
      setPending((prev) => prev.filter((p) => p.booking_id !== item.booking_id));
    } catch {
      setOutcomeNotice("Couldn't reach the server — please try again.");
    } finally {
      setRespondingId(null);
    }
  }

  if (loadError) {
    return (
      <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>{loadError}</div>
    );
  }

  if (pending.length === 0 && !outcomeNotice) return null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {pending.length > 0 && (
        <h2
          style={{
            margin: 0,
            fontSize: "14px",
            fontFamily: "var(--rm-font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--rm-ink)",
          }}
        >
          🤝 Group approval needed ({pending.length})
        </h2>
      )}

      {outcomeNotice && (
        <div
          style={{
            fontSize: "12px",
            background: "#eef7ee",
            border: "1px dashed #4a8f5c",
            borderRadius: "8px",
            padding: "8px 12px",
            color: "#1f4d2c",
          }}
        >
          {outcomeNotice}
        </div>
      )}

      {pending.map((item) => {
        const countdown = formatCountdown(item.expires_at, now);
        const msLeft = item.expires_at ? new Date(item.expires_at).getTime() - now : null;
        const isUrgent = msLeft !== null && msLeft <= 5 * 60_000;
        return (
        <div key={item.booking_id} style={cardStyle}>
          <div style={{ fontSize: "13px", color: "var(--rm-ink)" }}>
            <strong>{item.joining_rider_name}</strong> wants to join your shared ride
            {item.origin_label && item.destination_label
              ? ` from ${item.origin_label} to ${item.destination_label}`
              : ""}
            . This changes your ride from a 1:1 share to a group of 3 or more, so everyone
            currently on it — including you — needs to agree first.
          </div>
          {countdown && (
            <div
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: isUrgent ? "#b3441c" : "var(--rm-ink-soft)",
              }}
            >
              ⏳ {countdown} — if nobody answers in time, this join is cancelled and the seat
              is released.
            </div>
          )}
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              disabled={respondingId === item.booking_id}
              onClick={() => respond(item, true)}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontFamily: "var(--rm-font-display)",
                fontSize: "12px",
                fontWeight: 600,
                color: "#fff",
                background: "var(--rm-route-green)",
                border: "none",
                borderRadius: "8px",
                cursor: respondingId === item.booking_id ? "wait" : "pointer",
              }}
            >
              ✓ Agree to share
            </button>
            <button
              type="button"
              disabled={respondingId === item.booking_id}
              onClick={() => respond(item, false)}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontFamily: "var(--rm-font-display)",
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--rm-ink)",
                background: "transparent",
                border: "1px solid var(--rm-border)",
                borderRadius: "8px",
                cursor: respondingId === item.booking_id ? "wait" : "pointer",
              }}
            >
              ✕ Decline
            </button>
          </div>
        </div>
        );
      })}
    </section>
  );
}
