// Day 7: unit tests for safety.ts — E.164 validation, zero-cost SOS link
// builders (Google Maps + wa.me), and server-side input validation for
// emergency contacts, ratings, and report reasons.
import {
  isValidE164,
  normalizePhoneInput,
  buildGoogleMapsLink,
  buildWhatsAppLink,
  buildSosMessage,
  REPORT_REASONS,
  isValidReportReason,
  MAX_EMERGENCY_CONTACTS,
  validateEmergencyContact,
  validateRatingInput,
} from "./safety";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failed += 1;
    return;
  }
  passed += 1;
  console.log(`✅ PASS: ${message}`);
}

console.log("\n🧪 Running Day 7 Safety & Trust Helper Test Suite...\n");

// ─────────────────────────────────────────────────────────────
// E.164 phone validation
// ─────────────────────────────────────────────────────────────
assert(isValidE164("+923001234567") === true, "Valid Pakistani mobile +923001234567 accepted");
assert(isValidE164("+12345678") === true, "Minimum-length (8 digit) number accepted");
assert(isValidE164("+123456789012345") === true, "Maximum-length (15 digit) number accepted");
assert(isValidE164("+92 300 1234567") === false, "Spaces rejected (must normalize first)");
assert(isValidE164("+92-300-1234567") === false, "Dashes rejected");
assert(isValidE164("923001234567") === false, "Missing leading '+' rejected");
assert(isValidE164("03001234567") === false, "Local format (03xx...) rejected");
assert(isValidE164("+0123456789") === false, "Country code starting with 0 rejected");
assert(isValidE164("+1234567") === false, "Too short (7 digits) rejected");
assert(isValidE164("+1234567890123456") === false, "Too long (16 digits) rejected");
assert(isValidE164("") === false, "Empty string rejected");
assert(isValidE164(42 as unknown as string) === false, "Non-string rejected");

// normalizePhoneInput strips human separators
assert(
  normalizePhoneInput("+92 300 123-4567") === "+923001234567",
  "normalizePhoneInput strips spaces and dashes"
);
assert(
  normalizePhoneInput("(+92) 300.123.4567") === "+923001234567",
  "normalizePhoneInput strips parentheses and dots"
);
assert(
  isValidE164(normalizePhoneInput("+92 300 123-4567")) === true,
  "normalize → validate pipeline accepts human-formatted input"
);

// ─────────────────────────────────────────────────────────────
// Google Maps link builder
// ─────────────────────────────────────────────────────────────
assert(
  buildGoogleMapsLink(33.6844, 73.0479) === "https://www.google.com/maps?q=33.684400,73.047900",
  "Google Maps link formats coordinates to 6 decimals"
);

// ─────────────────────────────────────────────────────────────
// WhatsApp deep link (zero-cost delivery channel)
// ─────────────────────────────────────────────────────────────
{
  const msg = "I need help. My current location: https://www.google.com/maps?q=33.684400,73.047900.";
  const link = buildWhatsAppLink("+923001234567", msg);
  assert(
    link === `https://wa.me/923001234567?text=${encodeURIComponent(msg)}`,
    "wa.me link strips the '+' and URL-encodes the message"
  );
  assert(link.startsWith("https://wa.me/923001234567"), "wa.me link targets the right number");
  assert(!link.includes("+92"), "No '+' survives in the wa.me number segment");
}

// ─────────────────────────────────────────────────────────────
// SOS message builder
// ─────────────────────────────────────────────────────────────
{
  const mapsLink = "https://www.google.com/maps?q=33.684400,73.047900";
  assert(
    buildSosMessage(mapsLink) === `I need help. My current location: ${mapsLink}.`,
    "SOS message without companion name"
  );
  assert(
    buildSosMessage(mapsLink, "Sara") ===
      `I need help. My current location: ${mapsLink}. I'm on a RouteMate trip with Sara.`,
    "SOS message with companion name"
  );
  assert(
    buildSosMessage(mapsLink, "   ") === `I need help. My current location: ${mapsLink}.`,
    "Blank companion name treated as absent"
  );
}

// ─────────────────────────────────────────────────────────────
// Report reasons
// ─────────────────────────────────────────────────────────────
assert(
  REPORT_REASONS.length === 4 &&
    REPORT_REASONS.includes("unsafe_driving") &&
    REPORT_REASONS.includes("inappropriate_behavior") &&
    REPORT_REASONS.includes("no_show") &&
    REPORT_REASONS.includes("other"),
  "REPORT_REASONS exposes the four spec'd reasons"
);
assert(isValidReportReason("unsafe_driving") === true, "unsafe_driving is a valid reason");
assert(isValidReportReason("other") === true, "other is a valid reason");
assert(isValidReportReason("because_i_said_so") === false, "Unknown reason rejected");
assert(isValidReportReason(123) === false, "Non-string reason rejected");

// ─────────────────────────────────────────────────────────────
// Emergency contact validation
// ─────────────────────────────────────────────────────────────
assert(MAX_EMERGENCY_CONTACTS === 3, "Contact limit is 3");
assert(
  validateEmergencyContact("Sara Khan", "+923001234567") === null,
  "Valid contact accepted"
);
assert(
  validateEmergencyContact("Sara Khan", "+92 300 1234567") === null,
  "Human-formatted phone normalized before validation"
);
assert(
  validateEmergencyContact("", "+923001234567") === "INVALID_CONTACT_NAME",
  "Empty name rejected"
);
assert(
  validateEmergencyContact("x".repeat(81), "+923001234567") === "INVALID_CONTACT_NAME",
  "81-char name rejected"
);
assert(
  validateEmergencyContact("x".repeat(80), "+923001234567") === null,
  "80-char name accepted (boundary)"
);
assert(
  validateEmergencyContact("Sara", "03001234567") === "INVALID_CONTACT_PHONE",
  "Local-format phone rejected"
);
assert(
  validateEmergencyContact(undefined, "+923001234567") === "MISSING_FIELDS",
  "Missing name flagged MISSING_FIELDS"
);
assert(
  validateEmergencyContact("Sara", null) === "MISSING_FIELDS",
  "Missing phone flagged MISSING_FIELDS"
);

// ─────────────────────────────────────────────────────────────
// Rating input validation
// ─────────────────────────────────────────────────────────────
assert(validateRatingInput(5, null) === null, "5 stars with no comment accepted");
assert(validateRatingInput(1, "bad ride") === null, "1 star with comment accepted");
assert(validateRatingInput(5, "x".repeat(500)) === null, "500-char comment accepted (boundary)");
assert(validateRatingInput(5, "x".repeat(501)) === "COMMENT_TOO_LONG", "501-char comment rejected");
assert(validateRatingInput(5, 123) === "COMMENT_TOO_LONG", "Non-string comment rejected");
assert(validateRatingInput(0, null) === "INVALID_STARS", "0 stars rejected");
assert(validateRatingInput(6, null) === "INVALID_STARS", "6 stars rejected");
assert(validateRatingInput(4.5, null) === "INVALID_STARS", "Fractional stars rejected");
assert(validateRatingInput("5" as unknown as number, null) === "INVALID_STARS", "String stars rejected");

console.log(`\n📋 Day 7 Safety Helper Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("🎉 All Day 7 Safety & Trust Helper Tests Passed!\n");
