import { co2SavedKgTotal } from "../carbonImpact";

export interface SoloFareEstimateView {
  provider: string;
  price: number;
  live_check_url?: string | null;
}

export interface FareComparisonCardProps {
  routesyncPrice: number;
  soloEstimates: SoloFareEstimateView[];
  estimatesAreLive?: boolean;
  sharedDistanceKm?: number;
  /** Total riders in the pool (driver + passengers). Defaults to 2
   *  (classic 1:1 share) so existing callers keep working unchanged. */
  riderCount?: number;
}

export default function FareComparisonCard({
  routesyncPrice,
  soloEstimates,
  estimatesAreLive = false,
  sharedDistanceKm = 8.5,
  riderCount = 2,
}: FareComparisonCardProps) {
  const cheapestSolo = Math.min(...soloEstimates.map((e) => e.price));
  const savingsPct = Math.round((1 - routesyncPrice / cheapestSolo) * 100);
  const co2SavedKg = co2SavedKgTotal(sharedDistanceKm || 8.5, riderCount);

  return (
    <div
      style={{
        fontFamily: "var(--rm-font-body)",
        background: "var(--rm-ink)",
        color: "var(--rm-paper)",
        borderRadius: "calc(var(--rm-radius) + 4px)",
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.7 }}>
          Your RouteSync fare
        </span>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {savingsPct > 0 && (
            <span
              style={{
                fontFamily: "var(--rm-font-display)",
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--rm-signal-ink)",
                background: "var(--rm-signal)",
                padding: "2px 8px",
                borderRadius: "999px",
              }}
            >
              {savingsPct}% cheaper
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: "var(--rm-font-display)", fontSize: "32px", fontWeight: 600 }}>
          Rs {routesyncPrice.toFixed(0)}
        </div>

        {/* Live CO2 Environmental Impact Badge */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: "rgba(61, 131, 97, 0.25)",
            border: "1px solid var(--rm-route-green)",
            color: "#6ee7b7",
            padding: "4px 10px",
            borderRadius: "8px",
            fontSize: "12px",
            fontFamily: "var(--rm-font-display)",
          }}
          title="Carbon emission avoided compared to an equivalent solo petrol car ride"
        >
          <span>🌱</span>
          <span><strong>-{co2SavedKg} kg</strong> CO₂</span>
        </div>
      </div>

      <div
        style={{
          borderTop: "1px solid rgba(238,241,236,0.15)",
          paddingTop: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.6 }}>
          Solo fares on this route {estimatesAreLive ? "(live estimate)" : "(sample)"}
        </div>
        {soloEstimates.map((e) => (
          <div key={e.provider} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", opacity: 0.85 }}>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {e.provider} (solo)
              {e.live_check_url && (
                <a
                  href={e.live_check_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Check the live ${e.provider} fare for this route`}
                  style={{ color: "var(--rm-signal)", textDecoration: "none", fontSize: "12px" }}
                >
                  check live ↗
                </a>
              )}
            </span>
            <span>Rs {e.price.toFixed(0)}</span>
          </div>
        ))}
        <p style={{ margin: "4px 0 0", fontSize: "11px", lineHeight: 1.5, opacity: 0.55 }}>
          {estimatesAreLive
            ? "Estimates modeled from this route's live OSRM distance & time using each provider's Islamabad tariff (base + per-km + per-min). Use “check live” for the exact in-app fare."
            : "Sample fares — live fare intelligence unavailable in demo mode."}
        </p>
      </div>
    </div>
  );
}

