/* Day 12: tests for the self-attestation vehicle details helpers.
 * The one rule that matters most here: maskCnicToLast4 must NEVER
 * return more than 4 characters, no matter what garbage goes in —
 * this is the one function standing between a full CNIC and
 * accidental exposure. */
import {
  isValidPakistaniCnic,
  normalizeCnic,
  maskCnicToLast4,
  isValidVehiclePlate,
  normalizeVehiclePlate,
} from "./vehicleDeclaration";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${label}`);
  } else {
    fail++;
    console.log(`❌ ${label}${detail ? " — " + detail : ""}`);
  }
}

// ── CNIC format ────────────────────────────────────────────────
check("valid CNIC accepted", isValidPakistaniCnic("42101-1234567-1") === true);
check("CNIC with surrounding whitespace still accepted (normalized first)", isValidPakistaniCnic("  42101-1234567-1  ") === true);
check("CNIC missing dashes rejected", isValidPakistaniCnic("4210112345671") === false);
check("CNIC with wrong digit grouping rejected", isValidPakistaniCnic("421011-234567-1") === false);
check("CNIC with letters rejected", isValidPakistaniCnic("4210A-1234567-1") === false);
check("CNIC too short rejected", isValidPakistaniCnic("1234-123456-1") === false);
check("empty string rejected", isValidPakistaniCnic("") === false);
check("non-string input rejected without throwing", isValidPakistaniCnic(null as any) === false);

check("normalizeCnic trims whitespace only, doesn't alter digits/dashes", normalizeCnic("  42101-1234567-1  ") === "42101-1234567-1");

// ── CNIC masking — the security-critical function ───────────────
check("mask returns exactly the last 4 digits", maskCnicToLast4("42101-1234567-1") === "5671");
check("mask never returns more than 4 characters, even with extra input", maskCnicToLast4("42101-1234567-1").length <= 4);
check("mask strips dashes before slicing (doesn't accidentally include one)", !maskCnicToLast4("42101-1234567-1").includes("-"));
check("mask of an all-digit string with no dashes still works", maskCnicToLast4("4210112345671") === "5671");
check("mask of a too-short input doesn't throw, just returns what's there", maskCnicToLast4("12") === "12");
check("mask of an empty string returns empty, not an error", maskCnicToLast4("") === "");

// ── Vehicle plate ────────────────────────────────────────────────
check("realistic plate 'ISB-1234' accepted", isValidVehiclePlate("ISB-1234") === true);
check("realistic plate with province+city code 'LEA-20-1234' accepted", isValidVehiclePlate("LEA-20-1234") === true);
check("lowercase plate accepted (normalized before validating)", isValidVehiclePlate("isb-1234") === true);
check("plate with extra spaces accepted (normalized)", isValidVehiclePlate("ISB 1234") === true);
check("plate with only letters (no digit) rejected", isValidVehiclePlate("ABCDEF") === false);
check("plate with only digits (no letter) rejected", isValidVehiclePlate("123456") === false);
check("plate that's just dashes rejected", isValidVehiclePlate("----") === false);
check("empty plate rejected", isValidVehiclePlate("") === false);
check("plate with disallowed characters rejected", isValidVehiclePlate("ISB@1234") === false);
check("absurdly long plate rejected", isValidVehiclePlate("ABC-1234567890123456") === false);

check("normalizeVehiclePlate uppercases and collapses spaces to a dash", normalizeVehiclePlate("isb 1234") === "ISB-1234");
check("normalizeVehiclePlate trims leading/trailing whitespace", normalizeVehiclePlate("  isb-1234  ") === "ISB-1234");

console.log(`\n📋 Vehicle Declaration Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\n🚨 Some tests failed!");
  process.exit(1);
} else {
  console.log("\n🎉 All Vehicle Declaration Tests Passed!");
}
