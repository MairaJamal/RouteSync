// ─────────────────────────────────────────────────────────────
// Day 7: Safety & Trust — pure helpers shared by the API (validation)
// and the frontend (link building). Everything here is synchronous and
// network-free so it can be unit tested without mocks.
// ─────────────────────────────────────────────────────────────

import { ReportReason } from "./types";

/** ITU-T E.164: leading +, country code 1-9, 8-15 digits total.
 *  Covers every Pakistani mobile (+92 3xx ...) and rejects spaces,
 *  dashes, and local-format numbers the wa.me link would mangle. */
const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

export function isValidE164(phone: string): boolean {
  return typeof phone === "string" && E164_REGEX.test(phone.trim());
}

/** Normalize common human input ("+92 300 123-4567") before validating. */
export function normalizePhoneInput(raw: string): string {
  return raw.replace(/[\s\-().]/g, "");
}

export function buildGoogleMapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Google Maps turn-by-turn directions from the rider's current
 *  position to a station. Walks the "get me there" path a caller needs
 *  when they're close enough to reach a station on foot or by cab. */
export function buildPoliceDirectionsLink(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): string {
  return (
    `https://www.google.com/maps/dir/?api=1`
    + `&origin=${fromLat.toFixed(6)},${fromLng.toFixed(6)}`
    + `&destination=${toLat.toFixed(6)},${toLng.toFixed(6)}`
    + `&travelmode=driving`
  );
}

/** tel: deep link. On a phone this opens the dialer pre-filled; on
 *  desktop it's a no-op the OS may hand to a softphone. Whitespace and
 *  formatting stripped so iOS/Android dialers parse it reliably. */
export function buildTelLink(phone: string): string {
  const digits = phone.replace(/[^0-9+]/g, "");
  return `tel:${digits}`;
}

// Pakistan emergency helplines. These are the guaranteed, always-
// available way to reach police/rescue — they need no location
// permission, no network, and no third-party API, so the SOS modal
// surfaces them even when the nearest-station lookup returns nothing.
//   15   → Police
//   1122 → Rescue (ambulance / fire / disaster)
export const POLICE_HELPLINE = "15";
export const RESCUE_HELPLINE = "1122";

/** wa.me deep links take the phone number with NO "+" and URL-encoded
 *  text. No API key, no account, no gateway — free by construction. */
export function buildWhatsAppLink(e164Phone: string, message: string): string {
  return `https://wa.me/${e164Phone.replace(/^\+/, "")}?text=${encodeURIComponent(message)}`;
}

export function buildSosMessage(
  mapsLink: string,
  companionName?: string,
  policeStationName?: string
): string {
  const companion = companionName && companionName.trim().length > 0
    ? ` I'm on a RouteSync trip with ${companionName.trim()}.`
    : "";
  const police = policeStationName && policeStationName.trim().length > 0
    ? ` Nearest police station I could find: ${policeStationName.trim()}.`
    : "";
  return `I need help. My current location: ${mapsLink}.${companion}${police}`;
}

export const REPORT_REASONS: ReportReason[] = [
  "unsafe_driving",
  "inappropriate_behavior",
  "no_show",
  "other",
];

export function isValidReportReason(reason: unknown): reason is ReportReason {
  return typeof reason === "string" && (REPORT_REASONS as string[]).includes(reason);
}

export const MAX_EMERGENCY_CONTACTS = 3;

/** Server-side hard validation for a new contact. Returns an error code
 *  or null when the row is acceptable. Mirrors the DB check constraints
 *  in 20260901000100_sos_safety_tables.sql. */
export function validateEmergencyContact(
  contactName: unknown,
  contactPhone: unknown
): "MISSING_FIELDS" | "INVALID_CONTACT_NAME" | "INVALID_CONTACT_PHONE" | null {
  if (typeof contactName !== "string" || typeof contactPhone !== "string") {
    return "MISSING_FIELDS";
  }
  const name = contactName.trim();
  if (name.length < 1 || name.length > 80) return "INVALID_CONTACT_NAME";
  if (!isValidE164(normalizePhoneInput(contactPhone))) return "INVALID_CONTACT_PHONE";
  return null;
}

/** Stars must be an integer 1-5; comments optional but capped at 500. */
export function validateRatingInput(
  stars: unknown,
  comment: unknown
): "INVALID_STARS" | "COMMENT_TOO_LONG" | null {
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return "INVALID_STARS";
  }
  if (comment != null && (typeof comment !== "string" || comment.trim().length > 500)) {
    return "COMMENT_TOO_LONG";
  }
  return null;
}
