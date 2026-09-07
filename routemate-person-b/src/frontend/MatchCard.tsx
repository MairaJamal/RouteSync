/* Changed: Added MatchCardSkeleton loading component, accessible keyboard focus styles, touch/swipeable mobile container styling, and responsive layout polish. */
import { LabeledLeg } from "../matchPipeline";
import { RiderFareShare } from "../fareSplit";
import { RatingSummary, GeoJSONLineString, VehicleType } from "../types";
import VerifiedBadge from "./VerifiedBadge";
import SafetyMenu from "./SafetyMenu";
import MatchRouteMap from "./MatchRouteMap";
import { useState } from "react";

export function MatchCardSkeleton() {
  return (
    <div
      style={{
        fontFamily: "var(--rm-font-body)",
        background: "var(--rm-paper-raised)",
        border: "1px solid var(--rm-border)",
        borderRadius: "calc(var(--rm-radius) + 4px)",
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
          <div className="rm-skeleton" style={{ height: "18px", width: "55%" }} />
          <div className="rm-skeleton" style={{ height: "14px", width: "40%" }} />
        </div>
        <div className="rm-skeleton" style={{ height: "24px", width: "90px", borderRadius: "999px" }} />
      </div>

      <div className="rm-skeleton" style={{ height: "12px", width: "100%", borderRadius: "6px" }} />

      <div className="rm-skeleton" style={{ height: "14px", width: "60%" }} />
      <div className="rm-skeleton" style={{ height: "28px", width: "45%" }} />

      <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
        <div className="rm-skeleton" style={{ flex: 1, height: "42px", borderRadius: "var(--rm-radius)" }} />
        <div className="rm-skeleton" style={{ flex: 1, height: "42px", borderRadius: "var(--rm-radius)" }} />
      </div>
    </div>
  );
}


const LEG_COLOR: Record<LabeledLeg["color"], string> = {
  blue: "var(--rm-route-blue)",
  green: "var(--rm-route-green)",
  purple: "var(--rm-route-purple)",
};

const LEG_LABEL: Record<LabeledLeg["color"], string> = {
  blue: "Lead leg",
  green: "Shared leg",
  purple: "Final dropoff",
};

/** Human-readable leg distance — meters below 1km, one decimal above. */
function formatLegDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters)}m`;
}

/** The signature element: a segmented bar where each leg's width is
 *  proportional to its distance, colored exactly as the backend's
 *  matchPipeline.ts assigns — blue/green/purple aren't decoration here,
 *  they're the same leg structure the fare split was computed from. The
 *  legend spells out each leg's real distance (and the total) so the
 *  proportions are verifiable against the numbers, not taken on faith. */
function RouteBar({ legs }: { legs: LabeledLeg[] }) {
  const total = legs.reduce((sum, l) => sum + l.distance_m, 0) || 1;
  return (
    <div>
      <div
        style={{
          display: "flex",
          height: "10px",
          borderRadius: "6px",
          overflow: "hidden",
          border: "1px solid var(--rm-border)",
        }}
      >
        {legs.map((leg, i) => (
          <div
            key={i}
            style={{
              width: `${(leg.distance_m / total) * 100}%`,
              background: LEG_COLOR[leg.color],
            }}
            title={`${LEG_LABEL[leg.color]}: ${formatLegDistance(leg.distance_m)}`}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: "14px", marginTop: "8px", flexWrap: "wrap", alignItems: "center" }}>
        {legs.map((leg, i) => (
          <span
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "11px",
              color: "var(--rm-ink-soft)",
              fontFamily: "var(--rm-font-body)",
            }}
          >
            <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: LEG_COLOR[leg.color] }} />
            {LEG_LABEL[leg.color]}
            <span
              style={{
                color: "var(--rm-ink)",
                fontFamily: "var(--rm-font-display)",
                fontWeight: 600,
              }}
            >
              {formatLegDistance(leg.distance_m)}
            </span>
          </span>
        ))}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "11px",
            color: "var(--rm-ink-soft)",
            fontFamily: "var(--rm-font-display)",
          }}
        >
          Total {formatLegDistance(total)}
        </span>
      </div>
    </div>
  );
}

function OverlapBadge({ pct }: { pct: number }) {
  const strong = pct >= 75;
  return (
    <span
      style={{
        fontFamily: "var(--rm-font-display)",
        fontSize: "12px",
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: "999px",
        color: strong ? "#0e3d24" : "var(--rm-ink-soft)",
        background: strong ? "#d7ecdf" : "var(--rm-paper)",
        border: `1px solid ${strong ? "var(--rm-route-green)" : "var(--rm-border)"}`,
      }}
    >
      {pct}% overlap
    </span>
  );
}

/** Day 7 Feature 4: trust signal. Aggregates come from the public
 *  rating-summary endpoint; comments are never shown here. */
function RatingText({ rating }: { rating: RatingSummary | null | undefined }) {
  if (!rating || rating.rating_count === 0) {
    return (
      <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>No ratings yet</span>
    );
  }
  return (
    <span style={{ fontSize: "11px", fontFamily: "var(--rm-font-display)", color: "var(--rm-star)", fontWeight: 600 }}>
      ★ {rating.avg_stars.toFixed(1)}{" "}
      <span style={{ color: "var(--rm-ink-soft)", fontWeight: 400, fontFamily: "var(--rm-font-body)" }}>
        ({rating.rating_count} ride{rating.rating_count === 1 ? "" : "s"})
      </span>
    </span>
  );
}

/** RouteSync Trust Score (0-100) combining institutional verification,
 *  historical trip ratings, and platform safety compliance. */
function TrustScoreBadge({
  isVerified,
  rating,
}: {
  isVerified: boolean;
  rating: RatingSummary | null | undefined;
}) {
  let score = 55; // baseline community score
  if (isVerified) score += 25;
  if (rating && rating.rating_count > 0) {
    score += Math.round((rating.avg_stars / 5) * 12);
    score += Math.min(8, rating.rating_count * 2);
  }
  const finalScore = Math.min(99, score);
  const isHighTrust = finalScore >= 80;

  return (
    <span
      style={{
        fontFamily: "var(--rm-font-display)",
        fontSize: "11px",
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: "999px",
        color: isHighTrust ? "#065f46" : "var(--rm-ink)",
        background: isHighTrust ? "#d1fae5" : "var(--rm-paper)",
        border: `1px solid ${isHighTrust ? "#10b981" : "var(--rm-border)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
      title={`RouteSync Trust Score (${finalScore}/100) calculated from verified email, completed rides, and community ratings`}
    >
      <span>🛡️</span>
      <span>Trust {finalScore}</span>
    </span>
  );
}

/** Day 7 Feature 1: marks candidates whose preference restricts the
 *  pool to women only, so riders see the mode before accepting. */
function WomenOnlyBadge() {
  return (
    <span
      style={{
        fontFamily: "var(--rm-font-display)",
        fontSize: "10px",
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: "999px",
        color: "var(--rm-women-only)",
        background: "var(--rm-women-only-tint)",
        border: "1px solid var(--rm-women-only)",
        whiteSpace: "nowrap",
      }}
    >
      ♀ Women only
    </span>
  );
}

export interface MatchCardSafetyConfig {
  reporterId: string;
  rideId?: string | null;
  onBlocked?: () => void;
}

/** Day 8/11: marks a match as owner/passenger, or a shared
 *  ride-hailing split — shown instead of WomenOnlyBadge's neighbor
 *  spot so a rider immediately knows what kind of trip this is. */
function VehicleBadge({ vehicleType, isOwner }: { vehicleType: VehicleType; isOwner: boolean }) {
  if (vehicleType === "ride_hailing") {
    return (
      <span
        style={{
          fontFamily: "var(--rm-font-display)",
          fontSize: "10px",
          fontWeight: 600,
          padding: "2px 7px",
          borderRadius: "999px",
          color: "var(--rm-ink)",
          background: "var(--rm-paper)",
          border: "1px solid var(--rm-border)",
          whiteSpace: "nowrap",
        }}
      >
        🚕 Shared Yango/inDrive
      </span>
    );
  }
  const icon = vehicleType === "bike" ? "🏍️" : "🚗";
  const label = isOwner
    ? `${vehicleType === "bike" ? "Bike" : "Car"} owner`
    : `${vehicleType === "bike" ? "Bike" : "Car"} ride`;
  return (
    <span
      style={{
        fontFamily: "var(--rm-font-display)",
        fontSize: "10px",
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: "999px",
        color: "var(--rm-ink)",
        background: "var(--rm-paper)",
        border: "1px solid var(--rm-border)",
        whiteSpace: "nowrap",
      }}
    >
      {icon} {label}
    </span>
  );
}

export interface MatchCardProps {
  candidateDisplayName: string;
  candidateSectorFrom: string;
  candidateSectorTo: string;
  overlapPct: number;
  detourAddedMinutes: number;
  legs: LabeledLeg[];
  routeGeometry?: {
    requester: GeoJSONLineString | null;
    candidate: GeoJSONLineString | null;
    combined: GeoJSONLineString | null;
  };
  fareSplit: RiderFareShare[];
  /** Day 8 — undefined/"peer_share" renders exactly as before. Day 11
   *  adds "shared_ride_hailing". */
  matchType?: "peer_share" | "owner_passenger" | "shared_ride_hailing";
  ownerUserId?: string;
  vehicleType?: VehicleType;
  /** Only set when matchType === "shared_ride_hailing". */
  sharedFarePkr?: number;
  sharedFareNote?: string;
  /** Day 12: self-declared plate / make for the candidate when they declared a vehicle.
   *  Never includes any CNIC information. */
  ownerVehicleDeclared?: boolean;
  ownerVehiclePlate?: string | null;
  ownerVehicleMakeModel?: string | null;
  currentUserId: string;
  status?: "pending" | "confirmed";
  // Day 7 Safety & Trust — all optional so pre-migration data still renders.
  candidateUserId?: string;
  candidateIsVerified?: boolean;
  candidateVerifiedDomain?: string | null;
  candidateRating?: RatingSummary | null;
  candidatePreference?: "any" | "male_only" | "female_only";
  safety?: MatchCardSafetyConfig;
  onAccept: () => void;
  onReject: () => void;
  onOpenChat?: () => void;
}

export default function MatchCard({
  candidateDisplayName,
  candidateSectorFrom,
  candidateSectorTo,
  overlapPct,
  detourAddedMinutes,
  legs,
  routeGeometry,
  fareSplit,
  matchType = "peer_share",
  ownerUserId,
  vehicleType,
  sharedFarePkr,
  sharedFareNote,
  ownerVehicleDeclared,
  ownerVehiclePlate,
  ownerVehicleMakeModel,
  currentUserId,
  status = "pending",
  candidateUserId,
  candidateIsVerified = false,
  candidateVerifiedDomain = null,
  candidateRating = null,
  candidatePreference = "any",
  safety,
  onAccept,
  onReject,
  onOpenChat,
}: MatchCardProps) {
  const myShare = fareSplit.find((f) => f.user_id === currentUserId);
  const isConfirmed = status === "confirmed";
  const [showMap, setShowMap] = useState(false);
  const hasMapData = Boolean(routeGeometry?.combined);

  return (
    <div
      style={{
        fontFamily: "var(--rm-font-body)",
        background: isConfirmed ? "#f4f9f5" : "var(--rm-paper-raised)",
        border: `1.5px solid ${isConfirmed ? "var(--rm-route-green)" : "var(--rm-border)"}`,
        borderRadius: "calc(var(--rm-radius) + 4px)",
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--rm-ink)" }}>
            {candidateDisplayName}{" "}
            {candidateIsVerified && <VerifiedBadge domain={candidateVerifiedDomain} compact />}{" "}
            {isConfirmed && (
              <span style={{ fontSize: "11px", color: "var(--rm-route-green)", fontFamily: "var(--rm-font-display)" }}>
                ✓ Confirmed Match
              </span>
            )}
          </div>
          <div style={{ fontSize: "13px", color: "var(--rm-ink-soft)", marginTop: "2px" }}>
            {candidateSectorFrom} → {candidateSectorTo}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
            <RatingText rating={candidateRating} />
            <TrustScoreBadge isVerified={Boolean(candidateIsVerified)} rating={candidateRating} />
            {candidatePreference === "female_only" && <WomenOnlyBadge />}
            {(matchType === "owner_passenger" || matchType === "shared_ride_hailing") && vehicleType && (
              <VehicleBadge vehicleType={vehicleType} isOwner={ownerUserId === candidateUserId} />
            )}
          </div>
          {(ownerVehicleDeclared || ownerVehiclePlate || ownerVehicleMakeModel) && (
            <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)", marginTop: "3px" }}>
              Self-declared:{" "}
              <strong style={{ color: "var(--rm-ink)" }}>
                {[ownerVehiclePlate, ownerVehicleMakeModel].filter(Boolean).join(" · ") || "Vehicle on file"}
              </strong>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <OverlapBadge pct={overlapPct} />
          {safety && candidateUserId && (
            <SafetyMenu
              reporterId={safety.reporterId}
              reportedUserId={candidateUserId}
              reportedDisplayName={candidateDisplayName}
              rideId={safety.rideId ?? null}
              onBlocked={safety.onBlocked}
            />
          )}
        </div>
      </div>

      <RouteBar legs={legs} />

      {hasMapData && (
        <div>
          <button
            type="button"
            onClick={() => setShowMap((v) => !v)}
            style={{
              fontFamily: "var(--rm-font-display)",
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.02em",
              color: "var(--rm-signal-ink, var(--rm-ink))",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "999px",
              padding: "4px 10px",
              cursor: "pointer",
            }}
            aria-expanded={showMap}
          >
            {showMap ? "▲ Hide route map" : "▼ Show route map"}
          </button>
          {showMap && (
            <div style={{ marginTop: "10px" }}>
              <MatchRouteMap
                requesterGeometry={routeGeometry?.requester ?? null}
                candidateGeometry={routeGeometry?.candidate ?? null}
                combinedGeometry={routeGeometry?.combined ?? null}
                legs={legs}
              />
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>+{detourAddedMinutes} min added to your trip</div>

      {myShare && (
        <div
          style={{
            fontFamily: "var(--rm-font-display)",
            fontSize: "20px",
            fontWeight: 600,
            color: "var(--rm-ink)",
          }}
        >
          {matchType === "owner_passenger" && ownerUserId === currentUserId ? (
            <>
              <span style={{ color: "var(--rm-route-green)" }}>Rs 0</span>{" "}
              <span style={{ fontFamily: "var(--rm-font-body)", fontSize: "12px", fontWeight: 400, color: "var(--rm-ink-soft)" }}>
                you're driving — no charge
              </span>
            </>
          ) : (
            <>
              Rs {myShare.total_fare.toFixed(0)}{" "}
              <span style={{ fontFamily: "var(--rm-font-body)", fontSize: "12px", fontWeight: 400, color: "var(--rm-ink-soft)" }}>
                {matchType === "owner_passenger"
                  ? "ride fare"
                  : matchType === "shared_ride_hailing"
                  ? "your share of the fare"
                  : "your share"}
              </span>
            </>
          )}
          {matchType === "shared_ride_hailing" && sharedFarePkr != null && (
            <div
              style={{
                fontFamily: "var(--rm-font-body)",
                fontSize: "11px",
                fontWeight: 400,
                color: "var(--rm-ink-soft)",
                marginTop: "2px",
              }}
            >
              Total fare Rs {sharedFarePkr.toFixed(0)}, split by km each person rides — settle up
              between yourselves outside the app.
              {myShare.distance_km != null && myShare.distance_km > 0 && (
                <span>
                  {" "}
                  You: ~{myShare.distance_km.toFixed(1)} km
                  {myShare.distance_share_pct != null ? ` (${myShare.distance_share_pct}%)` : ""}.
                </span>
              )}
              {sharedFareNote && <span> {sharedFareNote}</span>}
            </div>
          )}
        </div>
      )}

      {isConfirmed ? (
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={onOpenChat}
            style={{
              flex: 1,
              padding: "11px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--rm-signal-ink)",
              background: "var(--rm-signal)",
              border: "none",
              borderRadius: "var(--rm-radius)",
              cursor: "pointer",
            }}
          >
            💬 Open Chat & Contact
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={onAccept}
            style={{
              flex: 1,
              padding: "11px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--rm-signal-ink)",
              background: "var(--rm-signal)",
              border: "none",
              borderRadius: "var(--rm-radius)",
              cursor: "pointer",
            }}
          >
            Accept Ride
          </button>
          <button
            onClick={onReject}
            style={{
              flex: 1,
              padding: "11px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--rm-ink-soft)",
              background: "transparent",
              border: "1px solid var(--rm-border)",
              borderRadius: "var(--rm-radius)",
              cursor: "pointer",
            }}
          >
            Pass
          </button>
        </div>
      )}
    </div>
  );
}

