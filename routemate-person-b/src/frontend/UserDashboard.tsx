/* Personal dashboard — ride history, ratings, CO₂ and estimated money saved. */
import { useEffect, useState } from "react";
import VerifiedBadge from "./VerifiedBadge";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";
import { Gender } from "../types";

export interface DashboardProfile {
  display_name: string;
  gender: Gender;
  is_verified: boolean;
  verified_domain: string | null;
}

interface DashboardRide {
  ride_id: string;
  role: "driver" | "passenger";
  status: string;
  origin_label: string;
  destination_label: string;
  departure_time: string | null;
  completed_at: string | null;
  co2_saved_kg: number | null;
  estimated_fare_saved_pkr: number | null;
}

interface DashboardPayload {
  profile: DashboardProfile;
  rating: { avg_stars: number; rating_count: number };
  stats: {
    ride_count: number;
    total_co2_saved_kg: number;
    estimated_money_saved_pkr: number;
  };
  rides: DashboardRide[];
}

interface UserDashboardProps {
  userId: string;
  fallbackProfile?: DashboardProfile | null;
  onClose: () => void;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        background: "var(--rm-paper)",
        border: "1px solid var(--rm-border)",
        borderRadius: "var(--rm-radius)",
        padding: "12px 14px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: "10px",
          fontFamily: "var(--rm-font-display)",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--rm-ink-soft)",
          marginBottom: "6px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "20px",
          fontWeight: 600,
          color: "var(--rm-ink)",
          fontFamily: "var(--rm-font-display)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)", marginTop: "4px" }}>{hint}</div>
      ) : null}
    </div>
  );
}

export default function UserDashboard({ userId, fallbackProfile, onClose }: UserDashboardProps) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await authedFetch(`${API_URL}/api/users/${userId}/dashboard`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.details ?? body?.error ?? `HTTP ${res.status}`);
        }
        const payload = (await res.json()) as DashboardPayload;
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Couldn't load dashboard.");
          if (fallbackProfile) {
            setData({
              profile: fallbackProfile,
              rating: { avg_stars: 0, rating_count: 0 },
              stats: { ride_count: 0, total_co2_saved_kg: 0, estimated_money_saved_pkr: 0 },
              rides: [],
            });
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, fallbackProfile]);

  const profile = data?.profile ?? fallbackProfile;
  const rating = data?.rating ?? { avg_stars: 0, rating_count: 0 };
  const stats = data?.stats ?? {
    ride_count: 0,
    total_co2_saved_kg: 0,
    estimated_money_saved_pkr: 0,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 110,
        background: "rgba(27, 31, 39, 0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "24px 12px",
        overflowY: "auto",
        fontFamily: "var(--rm-font-body)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "560px",
          background: "var(--rm-paper-raised)",
          border: "1px solid var(--rm-border)",
          borderRadius: "12px",
          boxShadow: "0 16px 40px rgba(27,31,39,0.2)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 18px",
            borderBottom: "1px solid var(--rm-border)",
            background: "var(--rm-paper)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "11px",
                fontFamily: "var(--rm-font-display)",
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--rm-ink-soft)",
              }}
            >
              Personal dashboard
            </div>
            <div
              style={{
                marginTop: "4px",
                fontSize: "18px",
                fontWeight: 600,
                color: "var(--rm-ink)",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              {profile?.display_name ?? "RouteSync User"}
              {profile?.is_verified ? (
                <VerifiedBadge domain={profile.verified_domain} compact />
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "8px",
              padding: "6px 10px",
              cursor: "pointer",
              color: "var(--rm-ink-soft)",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
            }}
          >
            Close
          </button>
        </div>

        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "16px" }}>
          {loading && (
            <div style={{ fontSize: "13px", color: "var(--rm-ink-soft)" }}>Loading your stats…</div>
          )}
          {error && (
            <div
              style={{
                fontSize: "12px",
                color: "var(--rm-danger)",
                background: "var(--rm-alert-tint)",
                borderRadius: "8px",
                padding: "10px 12px",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px",
            }}
          >
            <StatCard label="Rides" value={String(stats.ride_count)} hint="Completed + active" />
            <StatCard
              label="Rating"
              value={
                rating.rating_count > 0
                  ? `${rating.avg_stars.toFixed(1)}★`
                  : "—"
              }
              hint={
                rating.rating_count > 0
                  ? `${rating.rating_count} review${rating.rating_count === 1 ? "" : "s"}`
                  : "No ratings yet"
              }
            />
            <StatCard
              label="CO₂ saved"
              value={`${stats.total_co2_saved_kg.toFixed(1)} kg`}
              hint="From completed shared rides"
            />
            <StatCard
              label="Money saved"
              value={
                stats.estimated_money_saved_pkr > 0
                  ? `Rs ${Math.round(stats.estimated_money_saved_pkr)}`
                  : "—"
              }
              hint="Est. vs solo car (PKR/km)"
            />
          </div>

          <div>
            <div
              style={{
                fontSize: "11px",
                fontFamily: "var(--rm-font-display)",
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--rm-ink-soft)",
                marginBottom: "10px",
              }}
            >
              Ride history
            </div>

            {!loading && (data?.rides?.length ?? 0) === 0 ? (
              <div
                style={{
                  border: "1px dashed var(--rm-border)",
                  borderRadius: "var(--rm-radius)",
                  padding: "20px 16px",
                  textAlign: "center",
                  color: "var(--rm-ink-soft)",
                  fontSize: "13px",
                }}
              >
                No rides yet. Accept a match and complete a trip to build your history.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {(data?.rides ?? []).map((ride) => (
                  <div
                    key={`${ride.ride_id}-${ride.role}`}
                    style={{
                      border: "1px solid var(--rm-border)",
                      borderRadius: "var(--rm-radius)",
                      padding: "12px 14px",
                      background: "var(--rm-paper)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        marginBottom: "4px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "13px",
                          fontWeight: 600,
                          color: "var(--rm-ink)",
                        }}
                      >
                        {ride.origin_label} → {ride.destination_label}
                      </span>
                      <span
                        style={{
                          fontSize: "10px",
                          fontFamily: "var(--rm-font-display)",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          color: "var(--rm-ink-soft)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {ride.role} · {ride.status}
                      </span>
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                      {formatWhen(ride.completed_at ?? ride.departure_time)}
                      {ride.co2_saved_kg != null ? ` · ${ride.co2_saved_kg} kg CO₂` : ""}
                      {ride.estimated_fare_saved_pkr != null && ride.estimated_fare_saved_pkr > 0
                        ? ` · ~Rs ${Math.round(ride.estimated_fare_saved_pkr)} saved`
                        : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
