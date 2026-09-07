/* Day 7 Feature 2: "Share my trip" — a zero-cost live location link.
   Uses navigator.geolocation.watchPosition and rebuilds a Google Maps
   link as the position updates; the link is refreshed at most every
   30s to keep shared URLs stable. No backend, no SMS, no paid API. */
import { useEffect, useRef, useState } from "react";
import { buildGoogleMapsLink } from "../safety";

const REFRESH_INTERVAL_MS = 30_000;

export default function TripSharePanel() {
  const [sharing, setSharing] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const lastLinkAtRef = useRef<number>(0);

  useEffect(() => {
    if (!sharing) return;

    setError(null);
    if (!("geolocation" in navigator)) {
      setError("This browser doesn't support location sharing.");
      setSharing(false);
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        // Throttle link churn: a fresh URL at most every 30s.
        if (now - lastLinkAtRef.current >= REFRESH_INTERVAL_MS || lastLinkAtRef.current === 0) {
          lastLinkAtRef.current = now;
          setLink(buildGoogleMapsLink(pos.coords.latitude, pos.coords.longitude));
          setUpdatedAt(new Date());
        }
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied — trip sharing needs your location to build a live link."
            : "Couldn't read your location, so the live link can't be generated."
        );
        setSharing(false);
      },
      { enableHighAccuracy: true, maximumAge: 20_000 }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      lastLinkAtRef.current = 0;
    };
  }, [sharing]);

  async function handleCopy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked; fall back to selecting the text input.
      setCopied(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--rm-paper-raised)",
        border: "1px solid var(--rm-border)",
        borderRadius: "var(--rm-radius)",
        padding: "14px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontFamily: "var(--rm-font-body)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>📍 Share my trip</div>
          <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
            Free live-location link (Google Maps), refreshed every 30s.
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={sharing}
          onClick={() => setSharing((s) => !s)}
          style={{
            width: "46px",
            height: "26px",
            borderRadius: "999px",
            border: "1px solid var(--rm-border)",
            background: sharing ? "var(--rm-route-green)" : "var(--rm-paper)",
            position: "relative",
            cursor: "pointer",
            flexShrink: 0,
            transition: "background 0.15s ease",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: "2px",
              left: sharing ? "22px" : "2px",
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              background: "#ffffff",
              border: "1px solid var(--rm-border)",
              transition: "left 0.15s ease",
            }}
          />
        </button>
      </div>

      {error && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{error}</div>}

      {sharing && link && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              flex: 1,
              padding: "9px 12px",
              fontSize: "12px",
              fontFamily: "var(--rm-font-display)",
              border: "1px solid var(--rm-border)",
              borderRadius: "8px",
              background: "var(--rm-paper)",
              color: "var(--rm-ink)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={handleCopy}
            style={{
              padding: "9px 12px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--rm-signal-ink)",
              background: "var(--rm-signal)",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent("Tracking my live ride on RouteSync: " + link)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "9px 12px",
              fontFamily: "var(--rm-font-display)",
              fontSize: "12px",
              fontWeight: 600,
              color: "#ffffff",
              background: "#25D366",
              textDecoration: "none",
              borderRadius: "8px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span>💬</span>
            <span>WhatsApp</span>
          </a>
        </div>
      )}

      {sharing && !link && !error && (
        <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>Waiting for first location fix…</div>
      )}
      {sharing && updatedAt && (
        <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
          Live link updated at {updatedAt.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
