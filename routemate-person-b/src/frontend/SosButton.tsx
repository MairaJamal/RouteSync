/* Day 7 Feature 2 (rev. 2): the SOS button — now with an auto-arming
   dispatch flow. One tap opens the modal, which then:
   1. grabs + continuously watches the device location (Geolocation),
   2. runs a short countdown and AUTOMATICALLY prepares an alert for
      every emergency contact plus the nearest police station, sharing
      the live location link,
   3. records the whole dispatch to the backend (sos_events + sos_alerts)
      and shows a truthful per-recipient status.

   HONESTY IS A SAFETY REQUIREMENT. A browser cannot silently send
   SMS/WhatsApp, so unless a real gateway is wired server-side (see
   src/sosGateway.ts), a recipient's status is "Ready · tap to send" —
   the platform logged + composed the alert and the rider completes the
   final on-device tap. We never render a fake green "Sent to Police"
   for something that never reached a handset. The national helplines
   (15 / 1122) are always one tap away and need no permission at all.

   Location denial is surfaced loudly, never swallowed silently. */
import { useEffect, useRef, useState } from "react";
import { EmergencyContact } from "../types";
import {
  buildGoogleMapsLink,
  buildWhatsAppLink,
  buildPoliceDirectionsLink,
  buildTelLink,
  POLICE_HELPLINE,
  RESCUE_HELPLINE,
} from "../safety";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";
import EmergencyContactsSection from "./EmergencyContactsSection";

/** Mirrors NearbyPoliceStation in src/policeLocator.ts, re-declared so
 *  the frontend bundle never pulls in the Node-side Overpass client. */
interface NearbyPoliceStation {
  osm_type: "node" | "way" | "relation";
  osm_id: string;
  name: string;
  lat: number;
  lng: number;
  phone?: string;
  address?: string;
  distance_km: number;
}

interface DispatchRecipient {
  name: string;
  phone?: string | null;
  kind: "emergency_contact" | "police";
  channel: "whatsapp" | "sms" | "call" | "log";
  status: "logged" | "sent" | "queued" | "failed";
  deep_link: string | null;
}

interface DispatchResult {
  sos_event_id: string | null;
  message: string;
  location_link: string;
  nearest_police: NearbyPoliceStation | null;
  gateway_configured: boolean;
  persisted: boolean;
  recipients: DispatchRecipient[];
}

type GeoState =
  | { kind: "locating" }
  | { kind: "located"; lat: number; lng: number }
  | { kind: "denied"; message: string }
  | { kind: "unsupported" };

/** Modal lifecycle. "armed" runs the auto-send countdown; "manual" is
 *  reached either by cancelling the countdown or when there's no
 *  location (denied/unsupported) so nothing can be auto-composed. */
type Phase = "locating" | "armed" | "dispatching" | "ready" | "manual";

const ARM_SECONDS = 5;

interface SosButtonProps {
  userId: string;
  tripRequestId?: string | null;
  rideId?: string | null;
  companionName?: string | null;
}

export default function SosButton({ userId, tripRequestId, rideId, companionName }: SosButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="SOS — emergency help"
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          right: "18px",
          bottom: "18px",
          zIndex: 90,
          width: "64px",
          height: "64px",
          borderRadius: "50%",
          background: "var(--rm-alert)",
          color: "#ffffff",
          border: "3px solid #ffffff",
          boxShadow: "0 6px 20px rgba(217, 45, 32, 0.45)",
          fontFamily: "var(--rm-font-display)",
          fontWeight: 600,
          fontSize: "15px",
          letterSpacing: "0.06em",
          cursor: "pointer",
        }}
      >
        SOS
      </button>

      {open && (
        <SosModal
          userId={userId}
          tripRequestId={tripRequestId ?? null}
          rideId={rideId ?? null}
          companionName={companionName ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SosModal({
  userId,
  tripRequestId,
  rideId,
  companionName,
  onClose,
}: SosButtonProps & { onClose: () => void }) {
  const [geo, setGeo] = useState<GeoState>({ kind: "locating" });
  const [phase, setPhase] = useState<Phase>("locating");
  const [countdown, setCountdown] = useState(ARM_SECONDS);
  const [dispatch, setDispatch] = useState<DispatchResult | null>(null);
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Refs so the one-shot dispatch effect never re-fires on re-render.
  const dispatchedRef = useRef(false);
  const cancelledRef = useRef(false);

  // Continuous location watch — keeps the live link + directions fresh
  // for the whole time the modal is open.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeo({ kind: "unsupported" });
      setPhase("manual");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => setGeo({ kind: "located", lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        setGeo({
          kind: "denied",
          message:
            err.code === err.PERMISSION_DENIED
              ? "Location permission was denied. Your contacts can still be alerted, but the message won't include your position."
              : "Couldn't determine your location. Your contacts can still be alerted without a position.",
        });
        setPhase("manual");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Load emergency contacts once (informational count + manual fallback).
  useEffect(() => {
    (async () => {
      try {
        const res = await authedFetch(`${API_URL}/api/emergency-contacts?user_id=${encodeURIComponent(userId)}`);
        if (res.ok) {
          const payload = await res.json();
          setContacts(payload.contacts ?? []);
          return;
        } else if (res.status === 503) {
          setContactsError("Emergency contacts aren't enabled on this database yet (Day 7 migration pending).");
        }
      } catch {
        /* fall through to local */
      }
      try {
        const stored = localStorage.getItem(`rm_contacts_${userId}`);
        if (stored) setContacts(JSON.parse(stored));
      } catch {
        setContactsError("Couldn't load emergency contacts.");
      }
    })();
  }, [userId]);

  async function runDispatch(lat: number, lng: number) {
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;
    setPhase("dispatching");
    try {
      const res = await authedFetch(`${API_URL}/api/sos/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          lat,
          lng,
          trip_request_id: tripRequestId,
          ride_id: rideId,
          companion_name: companionName,
        }),
      });
      if (res.ok) {
        const data: DispatchResult = await res.json();
        setDispatch(data);
        setPhase("ready");
        // Best-effort: open the first contact's WhatsApp as the actual
        // delivery gesture. Popup blockers may stop this — the row still
        // offers a manual "Open WhatsApp", so we never depend on it.
        const first = data.recipients.find((r) => r.kind === "emergency_contact" && r.deep_link);
        if (first?.deep_link) window.open(first.deep_link, "_blank", "noopener,noreferrer");
      } else {
        dispatchedRef.current = false;
        setPhase("manual");
      }
    } catch {
      dispatchedRef.current = false;
      setPhase("manual");
    }
  }

  // Auto-arm: once located, run the countdown, then dispatch on its own.
  useEffect(() => {
    if (geo.kind !== "located" || phase !== "armed") return;
    if (countdown <= 0) {
      if (!cancelledRef.current) void runDispatch(geo.lat, geo.lng);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, phase, countdown]);

  // Move from locating → armed as soon as the first fix lands.
  useEffect(() => {
    if (geo.kind === "located" && phase === "locating") setPhase("armed");
  }, [geo, phase]);

  async function handleCopy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const liveMapsLink = geo.kind === "located" ? buildGoogleMapsLink(geo.lat, geo.lng) : null;
  const contactCount = dispatch?.recipients.filter((r) => r.kind === "emergency_contact").length ?? contacts.length;
  const hasPolice = dispatch ? !!dispatch.nearest_police : false;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(27, 31, 39, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "440px",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--rm-paper-raised)",
          border: `2px solid var(--rm-alert)`,
          borderRadius: "calc(var(--rm-radius) + 4px)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          fontFamily: "var(--rm-font-body)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "var(--rm-font-display)", fontSize: "16px", fontWeight: 600, color: "var(--rm-alert)" }}>
            🚨 Emergency SOS
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: "18px", cursor: "pointer", color: "var(--rm-ink-soft)" }}
          >
            ✕
          </button>
        </div>

        {/* Location status — always visible, never silent */}
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "8px",
            fontSize: "13px",
            background: geo.kind === "denied" || geo.kind === "unsupported" ? "var(--rm-alert-tint)" : "var(--rm-paper)",
            border: "1px solid var(--rm-border)",
            color: "var(--rm-ink)",
          }}
        >
          {geo.kind === "locating" && "📍 Getting your location…"}
          {geo.kind === "located" && (
            <a href={liveMapsLink!} target="_blank" rel="noreferrer" style={{ color: "var(--rm-route-blue)", fontWeight: 600 }}>
              📍 Live location locked — open in Google Maps
            </a>
          )}
          {geo.kind === "denied" && <>⚠️ {geo.message}</>}
          {geo.kind === "unsupported" && "⚠️ This browser doesn't support location sharing."}
        </div>

        {/* ── Auto-arming countdown ─────────────────────────────── */}
        {phase === "armed" && geo.kind === "located" && (
          <div
            style={{
              padding: "16px",
              borderRadius: "var(--rm-radius)",
              background: "var(--rm-alert-tint)",
              border: "1px solid var(--rm-alert)",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ fontFamily: "var(--rm-font-display)", fontSize: "34px", fontWeight: 700, color: "var(--rm-alert)", lineHeight: 1 }}>
              {countdown}
            </div>
            <div style={{ fontSize: "13px", color: "var(--rm-ink)" }}>
              Sending your live location to{" "}
              <strong>
                {contactCount} {contactCount === 1 ? "contact" : "contacts"}
              </strong>
              {hasPolice ? " + the nearest police station" : ""}…
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                onClick={() => void runDispatch(geo.lat, geo.lng)}
                style={{
                  flex: 1,
                  padding: "10px",
                  fontFamily: "var(--rm-font-display)",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#ffffff",
                  background: "var(--rm-alert)",
                  border: "none",
                  borderRadius: "var(--rm-radius)",
                  cursor: "pointer",
                }}
              >
                Send now
              </button>
              <button
                type="button"
                onClick={() => {
                  cancelledRef.current = true;
                  setPhase("manual");
                }}
                style={{
                  flex: 1,
                  padding: "10px",
                  fontFamily: "var(--rm-font-display)",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--rm-ink-soft)",
                  background: "transparent",
                  border: "1px solid var(--rm-border)",
                  borderRadius: "var(--rm-radius)",
                  cursor: "pointer",
                }}
              >
                Cancel auto-send
              </button>
            </div>
          </div>
        )}

        {/* ── Dispatching spinner ───────────────────────────────── */}
        {phase === "dispatching" && (
          <div style={{ fontSize: "13px", color: "var(--rm-ink-soft)", textAlign: "center", padding: "8px 0" }}>
            ⏳ Alerting your emergency contacts & the nearest police station…
          </div>
        )}

        {/* ── Ready: truthful per-recipient status + live share ──── */}
        {phase === "ready" && dispatch && (
          <>
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "var(--rm-radius)",
                background: "var(--rm-paper)",
                border: "1px solid var(--rm-border)",
                fontSize: "13px",
                color: "var(--rm-ink)",
              }}
            >
              {dispatch.gateway_configured ? (
                <>✓ Live location <strong>sent</strong> to {dispatch.recipients.length} recipient(s).</>
              ) : (
                <>
                  Alerts <strong>prepared &amp; logged</strong> for {dispatch.recipients.length} recipient(s). Tap each to send — your live location is included.
                </>
              )}
              {!dispatch.persisted && (
                <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)", marginTop: "6px" }}>
                  Note: the dispatch log table isn't migrated yet — alerts above are still ready to send.
                </div>
              )}
            </div>

            {/* The exact message + live link that went out */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--rm-ink-soft)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                📨 Message shared
              </div>
              <div style={{ fontSize: "12px", color: "var(--rm-ink)", background: "var(--rm-paper)", border: "1px solid var(--rm-border)", borderRadius: "8px", padding: "10px 12px" }}>
                {dispatch.message}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a
                  href={liveMapsLink ?? dispatch.location_link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ flex: 1, textAlign: "center", padding: "8px 10px", fontSize: "12px", fontWeight: 600, color: "var(--rm-route-blue)", border: "1px solid var(--rm-border)", borderRadius: "8px", textDecoration: "none" }}
                >
                  🗺️ View live location
                </a>
                <button
                  type="button"
                  onClick={() => handleCopy(liveMapsLink ?? dispatch.location_link)}
                  style={{ flex: 1, padding: "8px 10px", fontSize: "12px", fontWeight: 600, color: "var(--rm-signal-ink)", background: "var(--rm-signal)", border: "none", borderRadius: "8px", cursor: "pointer" }}
                >
                  {copied ? "Copied ✓" : "Copy link"}
                </button>
              </div>
            </div>

            {/* Per-recipient rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--rm-ink-soft)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                👥 Recipients
              </div>
              {dispatch.recipients.map((r, i) => (
                <RecipientRow key={`${r.kind}-${i}`} recipient={r} nearestPolice={dispatch.nearest_police} geo={geo} />
              ))}
              {dispatch.recipients.length === 0 && (
                <div style={{ fontSize: "12px", color: "var(--rm-ink-soft)" }}>
                  No emergency contacts found. Add one below, and use the police helpline at the top.
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Manual / denied path: helplines + direct contact links ── */}
        {(phase === "manual" || phase === "ready") && (
          <EmergencyServices />
        )}

        {phase === "manual" && (
          <>
            {contactsError && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{contactsError}</div>}
            {contacts.length === 0 ? (
              <EmergencyContactsSection userId={userId} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--rm-ink-soft)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Send manually
                </div>
                {contacts.map((c) => (
                  <a
                    key={c.id}
                    href={buildWhatsAppLink(c.contact_phone, buildManualMessage(liveMapsLink, companionName))}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "12px 14px",
                      background: "#25d366",
                      color: "#ffffff",
                      borderRadius: "var(--rm-radius)",
                      textDecoration: "none",
                      fontWeight: 600,
                      fontSize: "14px",
                    }}
                  >
                    <span>💬 Alert {c.contact_name}</span>
                    <span style={{ fontFamily: "var(--rm-font-display)", fontSize: "12px" }}>{c.contact_phone}</span>
                  </a>
                ))}
              </div>
            )}
            {geo.kind === "located" && (
              <button
                type="button"
                onClick={() => void runDispatch(geo.lat, geo.lng)}
                style={{
                  padding: "12px",
                  fontFamily: "var(--rm-font-display)",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#ffffff",
                  background: "var(--rm-alert)",
                  border: "none",
                  borderRadius: "var(--rm-radius)",
                  cursor: "pointer",
                }}
              >
                🚨 Auto-alert contacts + nearest police now
              </button>
            )}
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          style={{
            padding: "10px",
            fontFamily: "var(--rm-font-display)",
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--rm-ink-soft)",
            background: "transparent",
            border: "1px solid var(--rm-border)",
            borderRadius: "var(--rm-radius)",
            cursor: "pointer",
          }}
        >
          I'm safe — close
        </button>
      </div>
    </div>
  );
}

/** Fallback message for the manual (no-dispatch) path — mirrors what
 *  the server composes, without needing a round trip. */
function buildManualMessage(mapsLink: string | null, companionName?: string | null): string {
  const companion = companionName && companionName.trim().length > 0 ? ` I'm on a RouteSync trip with ${companionName.trim()}.` : "";
  return `I need help. My current location: ${mapsLink ?? "my location is unavailable"}.${companion}`;
}

/** Always-available Pakistan emergency helplines. No permission, no
 *  network, no API — the guaranteed floor of the SOS flow. */
function EmergencyServices() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--rm-ink-soft)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        📞 Emergency services
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <a
          href={buildTelLink(POLICE_HELPLINE)}
          style={{ flex: 1, textAlign: "center", padding: "12px 14px", background: "var(--rm-alert)", color: "#ffffff", borderRadius: "var(--rm-radius)", textDecoration: "none", fontWeight: 700, fontSize: "14px" }}
        >
          Call Police · {POLICE_HELPLINE}
        </a>
        <a
          href={buildTelLink(RESCUE_HELPLINE)}
          style={{ flex: 1, textAlign: "center", padding: "12px 14px", background: "transparent", color: "var(--rm-alert)", border: "1.5px solid var(--rm-alert)", borderRadius: "var(--rm-radius)", textDecoration: "none", fontWeight: 700, fontSize: "14px" }}
        >
          Rescue · {RESCUE_HELPLINE}
        </a>
      </div>
    </div>
  );
}

function statusChip(status: DispatchRecipient["status"]): { label: string; color: string; bg: string } {
  switch (status) {
    case "sent":
      return { label: "✓ Sent", color: "#ffffff", bg: "var(--rm-route-green)" };
    case "queued":
      return { label: "Queued", color: "var(--rm-ink)", bg: "var(--rm-signal)" };
    case "failed":
      return { label: "Failed", color: "#ffffff", bg: "var(--rm-danger)" };
    case "logged":
    default:
      return { label: "Ready · tap to send", color: "var(--rm-route-blue)", bg: "transparent" };
  }
}

function RecipientRow({
  recipient,
  nearestPolice,
  geo,
}: {
  recipient: DispatchRecipient;
  nearestPolice: NearbyPoliceStation | null;
  geo: GeoState;
}) {
  const chip = statusChip(recipient.status);
  const isPolice = recipient.kind === "police";

  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--rm-paper)",
        border: "1px solid var(--rm-border)",
        borderRadius: "var(--rm-radius)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--rm-ink)" }}>
          {isPolice ? "🏛️" : "👤"} {recipient.name}
        </span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: chip.color,
            background: chip.bg,
            border: chip.bg === "transparent" ? `1px solid ${chip.color}` : "none",
            borderRadius: "999px",
            padding: "3px 8px",
            whiteSpace: "nowrap",
          }}
        >
          {chip.label}
        </span>
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        {isPolice ? (
          <>
            <a
              href={buildTelLink(POLICE_HELPLINE)}
              style={{ flex: 1, textAlign: "center", padding: "8px 10px", background: "var(--rm-alert)", color: "#ffffff", borderRadius: "8px", textDecoration: "none", fontWeight: 600, fontSize: "13px" }}
            >
              Call Police · {POLICE_HELPLINE}
            </a>
            {geo.kind === "located" && nearestPolice && (
              <a
                href={buildPoliceDirectionsLink(geo.lat, geo.lng, nearestPolice.lat, nearestPolice.lng)}
                target="_blank"
                rel="noreferrer"
                style={{ flex: 1, textAlign: "center", padding: "8px 10px", background: "transparent", color: "var(--rm-route-blue)", border: "1px solid var(--rm-border)", borderRadius: "8px", textDecoration: "none", fontWeight: 600, fontSize: "13px" }}
              >
                Directions · {nearestPolice.distance_km} km
              </a>
            )}
          </>
        ) : (
          recipient.deep_link && (
            <a
              href={recipient.deep_link}
              target="_blank"
              rel="noreferrer"
              style={{ flex: 1, textAlign: "center", padding: "8px 10px", background: "#25d366", color: "#ffffff", borderRadius: "8px", textDecoration: "none", fontWeight: 600, fontSize: "13px" }}
            >
              💬 Open WhatsApp
            </a>
          )
        )}
      </div>
    </div>
  );
}
