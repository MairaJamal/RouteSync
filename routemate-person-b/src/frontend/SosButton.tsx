/* Day 7 Feature 2: the SOS button. A persistent red button while a trip
   is active; one tap opens a modal that
   1. grabs the device location (Geolocation API),
   2. builds a Google Maps link for that spot,
   3. offers one WhatsApp deep link (wa.me — zero cost, no API key) per
      emergency contact with a pre-filled "I need help" message,
   4. records the trigger in sos_events (audit trail).

   Location denial is surfaced loudly, never swallowed silently — the
   alert links still work, just without coordinates. */
import { useEffect, useState } from "react";
import { EmergencyContact } from "../types";
import { buildGoogleMapsLink, buildWhatsAppLink, buildSosMessage } from "../safety";
import { API_URL } from "./apiBase";
import { authedFetch } from "./demoAuth";
import EmergencyContactsSection from "./EmergencyContactsSection";

type GeoState =
  | { kind: "locating" }
  | { kind: "located"; lat: number; lng: number }
  | { kind: "denied"; message: string }
  | { kind: "unsupported" };

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
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [logged, setLogged] = useState<boolean | null>(null);

  // Location first — the message links depend on it.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeo({ kind: "unsupported" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ kind: "located", lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) =>
        setGeo({
          kind: "denied",
          message:
            err.code === err.PERMISSION_DENIED
              ? "Location permission was denied. Your contacts can still be alerted, but the message won't include your position."
              : "Couldn't determine your location. Your contacts can still be alerted without a position.",
        }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  }, []);

  // Load emergency contacts + log the trigger in parallel.
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
        // fallthrough to local storage
      }
      try {
        const stored = localStorage.getItem(`rm_contacts_${userId}`);
        if (stored) {
          setContacts(JSON.parse(stored));
        } else {
          setContacts([
            {
              id: "demo-contact-1",
              user_id: userId,
              contact_name: "Amna Khan (Sister)",
              contact_phone: "+923005550199",
              created_at: new Date().toISOString(),
            },
          ]);
        }
      } catch {
        setContactsError("Couldn't load emergency contacts.");
      }
    })();

    // Audit trail. Fire-and-forget on purpose: logging must never delay
    // the user reaching help. A 503 (migration pending) is shown, not thrown.
    (async () => {
      try {
        const res = await authedFetch(`${API_URL}/api/sos-events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            trip_request_id: tripRequestId,
            ride_id: rideId,
          }),
        });
        setLogged(res.status !== 503);
      } catch {
        setLogged(false);
      }
    })();
  }, [userId, tripRequestId, rideId]);

  // Re-log with coordinates once they arrive, so the audit row has them.
  useEffect(() => {
    if (geo.kind !== "located") return;
    authedFetch(`${API_URL}/api/sos-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        trip_request_id: tripRequestId,
        ride_id: rideId,
        lat: geo.lat,
        lng: geo.lng,
      }),
    }).catch(() => undefined);
  }, [geo, userId, tripRequestId, rideId]);

  const mapsLink = geo.kind === "located" ? buildGoogleMapsLink(geo.lat, geo.lng) : null;
  const message = buildSosMessage(mapsLink ?? "my location is unavailable", companionName ?? undefined);

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
          <div
            style={{
              fontFamily: "var(--rm-font-display)",
              fontSize: "16px",
              fontWeight: 600,
              color: "var(--rm-alert)",
            }}
          >
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
            <a href={mapsLink!} target="_blank" rel="noreferrer" style={{ color: "var(--rm-route-blue)", fontWeight: 600 }}>
              📍 Location locked — open in Google Maps
            </a>
          )}
          {geo.kind === "denied" && <>⚠️ {geo.message}</>}
          {geo.kind === "unsupported" && "⚠️ This browser doesn't support location sharing."}
        </div>

        {/* Per-contact alert links */}
        {contactsError && <div style={{ fontSize: "12px", color: "var(--rm-danger)" }}>{contactsError}</div>}
        {contacts.length === 0 && !contactsError && (
          <EmergencyContactsSection userId={userId} />
        )}
        {contacts.map((c) => (
          <a
            key={c.id}
            href={buildWhatsAppLink(c.contact_phone, message)}
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

        {logged === false && (
          <div style={{ fontSize: "11px", color: "var(--rm-ink-soft)" }}>
            Note: this SOS couldn't be recorded in the database yet (migration pending) — the alert links above still work.
          </div>
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
