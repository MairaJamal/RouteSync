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

/** wa.me deep links take the phone number with NO "+" and URL-encoded
 *  text. No API key, no account, no gateway — free by construction. */
export function buildWhatsAppLink(e164Phone: string, message: string): string {
  return `https://wa.me/${e164Phone.replace(/^\+/, "")}?text=${encodeURIComponent(message)}`;
}

export function buildSosMessage(mapsLink: string, companionName?: string): string {
  const companion = companionName && companionName.trim().length > 0
    ? ` I'm on a RouteSync trip with ${companionName.trim()}.`
    : "";
  return `I need help. My current location: ${mapsLink}.${companion}`;
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
