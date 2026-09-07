/* Day 9: the "join an existing shared ride" flow that sits on top of
 * poolingCapacity.ts / book_pooled_ride(). Lets a rider discover open
 * rides (from GET /api/rides/active) and request a seat, using the
 * same can-add-passenger -> book two-step the backend already
 * exposes. If the join would bring the pool to 3+ riders, the booking
 * comes back as pending_consent — this shows that state clearly
 * rather than implying the rider is already in. */
import { useEffect, useState, type CSSProperties } from "react";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";

interface OpenRideListing {
  ride_id: string;
  driver_display_name: string;
  driver_is_verified: boolean;
  origin_label?: string;
  destination_label?: string;
  departure_time?: string;
  available_seats: number;
  current_rider_count: number;
  will_need_group_consent: boolean;
  co2_saved_summary: string | null;
}

type JoinOutcome = { rideId: string; status: "accepted" | "pending_consent"; message: string };

const cardStyle: CSSProperties = {
  background: "var(--rm-paper-raised)",
  border: "1px solid var(--rm-border)",
  borderRadius: "var(--rm-radius)",
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

export default function SharedRideBrowser({
  userId,
  pickupPoint,
  dropoffPoint,
}: {
  userId: string;
  pickupPoint?: { lat: number; lng: number; address_label: string };
  dropoffPoint?: { lat: number; lng: number; address_label: string };
}) {
  const [rides, setRides] = useState<OpenRideListing[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [joiningRideId, setJoiningRideId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, JoinOutcome>>({});

  async function refresh() {
    try {
      const res = await authedFetch(
        `${API_URL}/api/rides/active?viewer_id=${encodeURIComponent(userId)}`
      );
      if (res.status === 503) {
        setRides([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      setRides(payload.rides ?? []);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load open shared rides right now.");
    }
  }

  useEffect(() => {
    if (expanded) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function requestToJoin(ride: OpenRideListing) {
    if (!pickupPoint || !dropoffPoint) {
      setOutcomes((prev) => ({
        ...prev,
        [ride.ride_id]: {
          rideId: ride.ride_id,
          status: "pending_consent",
          message: "Search for a route first so we know your pickup/drop-off point.",
        },
      }));
      return;
    }

    setJoiningRideId(ride.ride_id);
    try {
      const checkRes = await authedFetch(`${API_URL}/api/rides/${ride.ride_id}/can-add-passenger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passenger_id: userId,
          max_co_passengers: -1, // no personal cap set here; the driver/existing riders' caps still apply
          seats_requested: 1,
          pickup_point: pickupPoint,
          dropoff_point: dropoffPoint,
        }),
      });
      const checkPayload = await checkRes.json();
      if (!checkPayload.canAdd) {
        setOutcomes((prev) => ({
          ...prev,
          [ride.ride_id]: {
            rideId: ride.ride_id,
            status: "pending_consent",
            message: `Can't join this ride: ${checkPayload.reason ?? "capacity full"}.`,
          },
        }));
        return;
      }

      const bookRes = await authedFetch(`${API_URL}/api/rides/${ride.ride_id}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passenger_id: userId,
          max_co_passengers: -1,
          seats_requested: 1,
          pickup_point: pickupPoint,
          dropoff_point: dropoffPoint,
        }),
      });
      const bookPayload = await bookRes.json();
      if (!bookRes.ok) {
        setOutcomes((prev) => ({
          ...prev,
          [ride.ride_id]: {
            rideId: ride.ride_id,
            status: "pending_consent",
            message: `Couldn't request a seat: ${bookPayload?.reason ?? bookPayload?.error ?? "unknown error"}.`,
          },
        }));
        return;
      }

      setOutcomes((prev) => ({
        ...prev,
        [ride.ride_id]: {
          rideId: ride.ride_id,
          status: bookPayload.status,
          message:
            bookPayload.status === "pending_consent"
              ? "Requested — this pool has 3+ riders, so everyone already on it needs to agree first. You'll be notified once they respond."
              : "You're in! This was a 1:1 join so no group approval was needed.",
        },
      }));
      // Seat count on the listing is now stale either way (reserved
      // whether pending or accepted) — drop it from the browse list.
      setRides((prev) => prev.filter((r) => r.ride_id !== ride.ride_id));
    } catch {
      setOutcomes((prev) => ({
        ...prev,
        [ride.ride_id]: {
          rideId: ride.ride_id,
          status: "pending_consent",
          message: "Couldn't reach the server — please try again.",
        },
      }));
    } finally {
      setJoiningRideId(null);
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          background: "var(--rm-paper-raised)",
          border: "1px solid var(--rm-border)",
          borderRadius: "var(--rm-radius)",
          cursor: "pointer",
          fontFamily: "var(--rm-font-display)",
          fontSize: "13px",
          fontWeight: 600,
          color: "var(--rm-ink)",
        }}
      >
        <span>🚗 Join an existing shared ride</span>
        <span>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {loadError && <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>{loadError}</div>}

          {!loadError && rides.length === 0 && Object.keys(outcomes).length === 0 && (
            <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
              No open rides with a free seat right now.
            </div>
          )}

          {Object.values(outcomes).map((o) => (
            <div
              key={o.rideId}
              style={{
                fontSize: "12px",
                background: o.status === "accepted" ? "#eef7ee" : "var(--rm-alert-tint)",
                border: `1px dashed ${o.status === "accepted" ? "#4a8f5c" : "var(--rm-alert)"}`,
                borderRadius: "8px",
                padding: "8px 12px",
                color: o.status === "accepted" ? "#1f4d2c" : "var(--rm-ink)",
              }}
            >
              {o.message}
            </div>
          ))}

          {rides.map((ride) => (
            <div key={ride.ride_id} style={cardStyle}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>
                {ride.driver_display_name}
                {ride.driver_is_verified ? " ✓" : ""} — {ride.origin_label ?? "Origin"} →{" "}
                {ride.destination_label ?? "Destination"}
              </div>
              <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                {ride.available_seats} seat{ride.available_seats === 1 ? "" : "s"} open ·{" "}
                currently {ride.current_rider_count} rider{ride.current_rider_count === 1 ? "" : "s"}
                {ride.will_need_group_consent && " · joining will need the group's approval"}
              </div>
              {ride.co2_saved_summary && (
                <div style={{ fontSize: "12px", color: "#1f4d2c" }}>{ride.co2_saved_summary}</div>
              )}
              <button
                type="button"
                disabled={joiningRideId === ride.ride_id}
                onClick={() => requestToJoin(ride)}
                style={{
                  alignSelf: "flex-start",
                  padding: "7px 14px",
                  fontFamily: "var(--rm-font-display)",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#fff",
                  background: "var(--rm-signal)",
                  border: "none",
                  borderRadius: "8px",
                  cursor: joiningRideId === ride.ride_id ? "wait" : "pointer",
                }}
              >
                {joiningRideId === ride.ride_id ? "Requesting…" : "Request seat"}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
