/* Day 9: the "join an existing shared ride" flow that sits on top of
 * poolingCapacity.ts / book_pooled_ride(). Lets a rider discover open
 * rides (from GET /api/rides/active) and request a seat.
 *
 * One card per CAR, not per ride row: a car with riders already confirmed
 * into it renders the way a group match card does — host up top, everyone
 * already riding listed underneath — and the single "Request seat" action
 * addresses the whole car, so host and co-riders each get the ask and every
 * confirmation folds into the same group chat. */
import { useEffect, useState, type CSSProperties } from "react";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";
import { routeOverlapPct } from "../routeOverlap";
import type { GeoJSONLineString } from "../types";

interface RideMember {
  user_id: string;
  display_name: string;
}

interface OpenRideListing {
  ride_id: string;
  /** The ride owner — driver of their own car, or the rider sharing an
   *  inDrive/Uber seat. A join sends the approve-and-chat request here. */
  owner_user_id: string;
  driver_display_name: string;
  driver_is_verified: boolean;
  origin_label?: string;
  destination_label?: string;
  origin?: { lat: number; lng: number; address_label: string };
  destination?: { lat: number; lng: number; address_label: string };
  departure_time?: string;
  available_seats: number;
  current_rider_count: number;
  /** Riders already confirmed into this car, and anyone mid-handshake. */
  members?: RideMember[];
  pending_members?: RideMember[];
  /** The car's stable group key — echoed back as the request's group so
   *  every join into this car lands in one shared chat. */
  group_key?: string;
  will_need_group_consent: boolean;
  co2_saved_summary: string | null;
}

type JoinOutcome = { rideId: string; status: "requested" | "error"; message: string };

const cardStyle: CSSProperties = {
  background: "var(--rm-paper-raised)",
  border: "1px solid var(--rm-border)",
  borderRadius: "var(--rm-radius)",
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const chipStyle: CSSProperties = {
  fontFamily: "var(--rm-font-display)",
  fontSize: "10px",
  fontWeight: 600,
  letterSpacing: "0.04em",
  padding: "2px 7px",
  borderRadius: "999px",
  border: "1px solid var(--rm-border)",
  color: "var(--rm-ink-soft)",
  whiteSpace: "nowrap",
};

function straightLine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): GeoJSONLineString {
  return { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] };
}

/** How much of the rider's own searched corridor this ride travels too.
 *  Straight-line corridor overlap (same 500 m buffer the match cards use),
 *  not road geometry — hence the "≈", and it's hidden until both routes
 *  are actually known. */
function routeMatchPct(
  ride: OpenRideListing,
  pickupPoint?: { lat: number; lng: number },
  dropoffPoint?: { lat: number; lng: number }
): number | null {
  if (!ride.origin || !ride.destination || !pickupPoint || !dropoffPoint) return null;
  const pct = routeOverlapPct(
    straightLine(pickupPoint, dropoffPoint),
    straightLine(ride.origin, ride.destination)
  );
  if (!Number.isFinite(pct)) return null;
  return Math.round(pct);
}

function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

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
    // A join is no longer a silent seat-book. It sends a ride request (the
    // same two-sided handshake used everywhere else) to whoever hosts the
    // car AND to everyone already riding in it — one ask per person, all
    // stamped with the same group key so the answers converge on a single
    // group chat instead of parallel 1:1 threads.
    const members = (ride.members ?? []).filter((m) => m.user_id && m.user_id !== ride.owner_user_id);
    const targets: { user_id: string; display_name: string }[] = [
      { user_id: ride.owner_user_id, display_name: ride.driver_display_name },
      ...members,
    ].filter((t) => t.user_id && t.user_id !== userId);

    if (!ride.origin || !ride.destination || targets.length === 0) {
      setOutcomes((prev) => ({
        ...prev,
        [ride.ride_id]: {
          rideId: ride.ride_id,
          status: "error",
          message: "This ride is missing pickup/drop-off details, so a request can't be sent.",
        },
      }));
      return;
    }

    setJoiningRideId(ride.ride_id);
    const sentTo: string[] = [];
    const failures: string[] = [];
    try {
      for (const target of targets) {
        try {
          const res = await authedFetch(`${API_URL}/api/match-requests`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from_user_id: userId,
              to_user_id: target.user_id,
              // The car's identity doubles as the group key: rides have no
              // trip_request column, and the server verifies the claimed
              // host against this ride row rather than trusting the body.
              group: {
                host_user_id: ride.owner_user_id,
                host_trip_request_id: ride.group_key ?? ride.ride_id,
                host_ride_id: ride.ride_id,
              },
              preferences: {
                gender_preference: "any",
                departure_time: ride.departure_time ?? new Date().toISOString(),
                flexibility_minutes: 15,
                max_co_passengers: -1,
                vehicle_type: "none",
                pickup_note: [pickupPoint?.address_label, dropoffPoint?.address_label]
                  .filter(Boolean)
                  .join(" → ")
                  .slice(0, 200),
                note: "",
              },
              snapshot: {
                origin_label: ride.origin_label ?? ride.origin.address_label,
                destination_label: ride.destination_label ?? ride.destination.address_label,
                origin: ride.origin,
                destination: ride.destination,
                overlap_pct: routeMatchPct(ride, pickupPoint, dropoffPoint) ?? 100,
                detour_added_minutes: 0,
                match_type: "owner_passenger",
                fare_share_from_pkr: 0,
                fare_share_to_pkr: 0,
              },
            }),
          });
          const payload = await res.json().catch(() => null);
          if (res.ok) {
            sentTo.push(target.display_name);
          } else {
            failures.push(
              `${target.display_name}: ${payload?.details ?? payload?.error ?? `HTTP ${res.status}`}`
            );
          }
        } catch {
          failures.push(`${target.display_name}: network error`);
        }
      }

      const carLabel =
        members.length > 0
          ? `${ride.driver_display_name}'s car (${nameList(targets.map((t) => t.display_name))})`
          : ride.driver_display_name;

      if (sentTo.length === 0) {
        setOutcomes((prev) => ({
          ...prev,
          [ride.ride_id]: {
            rideId: ride.ride_id,
            status: "error",
            message: failures[0] ?? "Couldn't send the request — please try again.",
          },
        }));
        return;
      }

      const tail =
        failures.length > 0
          ? ` Couldn't reach ${nameList(failures.map((f) => f.split(":")[0]))} — you can still chat once ${ride.driver_display_name} accepts.`
          : "";
      setOutcomes((prev) => ({
        ...prev,
        [ride.ride_id]: {
          rideId: ride.ride_id,
          status: "requested",
          message: `Request sent to ${carLabel} — nothing is confirmed until they accept and you give the final OK. Watch "Your ride requests".${tail}`,
        },
      }));
      // Drop it from the browse list so the joiner can't double-request.
      setRides((prev) => prev.filter((r) => r.ride_id !== ride.ride_id));
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
                background: o.status === "requested" ? "#eef7ee" : "var(--rm-alert-tint)",
                border: `1px dashed ${o.status === "requested" ? "#4a8f5c" : "var(--rm-alert)"}`,
                borderRadius: "8px",
                padding: "8px 12px",
                color: o.status === "requested" ? "#1f4d2c" : "var(--rm-ink)",
              }}
            >
              {o.message}
            </div>
          ))}

          {rides.map((ride) => {
            const members = (ride.members ?? []).filter((m) => m.user_id !== ride.owner_user_id);
            const pending = (ride.pending_members ?? []).filter(
              (m) => m.user_id !== ride.owner_user_id && !members.some((x) => x.user_id === m.user_id)
            );
            const matchPct = routeMatchPct(ride, pickupPoint, dropoffPoint);
            const inCar = members.length + 1;
            return (
              <div key={ride.ride_id} style={cardStyle}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "10px",
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>
                    {ride.driver_display_name}
                    {ride.driver_is_verified ? " ✓" : ""}
                    {members.length > 0 && (
                      <span
                        style={{
                          ...chipStyle,
                          marginLeft: "6px",
                          background: "#e9f3ec",
                          borderColor: "#bcd8c4",
                          color: "#0e3d24",
                        }}
                      >
                        GROUP
                      </span>
                    )}
                  </div>
                  {matchPct !== null && (
                    <span
                      style={chipStyle}
                      title="Straight-line corridor overlap with the pickup/drop-off you searched"
                    >
                      ≈{matchPct}% route match
                    </span>
                  )}
                </div>

                <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                  {ride.origin_label ?? "Origin"} → {ride.destination_label ?? "Destination"}
                </div>

                {members.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "12px",
                      color: "var(--rm-ink-soft)",
                      background: "#f3f8f4",
                      border: "1px solid #dceadf",
                      borderRadius: "8px",
                      padding: "6px 10px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--rm-font-display)",
                        fontSize: "10px",
                        fontWeight: 600,
                        color: "#0e3d24",
                        whiteSpace: "nowrap",
                      }}
                    >
                      👥 {inCar} in this car
                    </span>
                    <span>
                      {nameList(members.map((m) => m.display_name))} already riding — you'd join
                      them
                    </span>
                    {pending.length > 0 && (
                      <span>
                        · {nameList(pending.map((m) => m.display_name))} requested to join
                      </span>
                    )}
                  </div>
                )}

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
                  {joiningRideId === ride.ride_id
                    ? "Requesting…"
                    : members.length > 0
                      ? "Request seat in this car"
                      : "Request seat"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
