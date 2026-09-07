// Day 7: unit tests for the verified-badge email allowlist (verification.ts)
import { matchVerifiedDomain, UNIVERSITY_EMAIL_DOMAINS } from "./verification";

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

console.log("\n🧪 Running Verified Badge (email allowlist) Test Suite...\n");

// Allowlist sanity
assert(UNIVERSITY_EMAIL_DOMAINS.length >= 15, "Allowlist contains a healthy number of domains");
assert(
  UNIVERSITY_EMAIL_DOMAINS.every((d) => d === d.toLowerCase() && !d.includes("@")),
  "Every allowlist entry is lowercase and contains no '@'"
);

// Exact match
assert(
  matchVerifiedDomain("sara@nust.edu.pk") === "nust.edu.pk",
  "Exact domain match: sara@nust.edu.pk → nust.edu.pk"
);

// Case-insensitive
assert(
  matchVerifiedDomain("SARA@NUST.EDU.PK") === "nust.edu.pk",
  "Case-insensitive match: SARA@NUST.EDU.PK → nust.edu.pk"
);

// Subdomain tolerance
assert(
  matchVerifiedDomain("ali@student.cs.nust.edu.pk") === "nust.edu.pk",
  "Subdomain match: ali@student.cs.nust.edu.pk → nust.edu.pk"
);

// Second domain sanity check
assert(
  matchVerifiedDomain("hamza@lums.edu.pk") === "lums.edu.pk",
  "Second allowlist entry works: hamza@lums.edu.pk → lums.edu.pk"
);

// Rejections
assert(matchVerifiedDomain("x@gmail.com") === null, "Personal email (gmail.com) rejected");
assert(matchVerifiedDomain("x@yahoo.com") === null, "Personal email (yahoo.com) rejected");
assert(
  matchVerifiedDomain("user@notnust.edu.pk") === null,
  "Look-alike domain (notnust.edu.pk) is NOT a subdomain and rejected"
);
assert(matchVerifiedDomain("user@nust.edu.pk.evil.com") === null, "Suffix-spoof domain rejected");
assert(matchVerifiedDomain("plainstring") === null, "Input without '@' rejected");
assert(matchVerifiedDomain("@nust.edu.pk") === null, "Missing local part rejected");
assert(matchVerifiedDomain("user@") === null, "Missing domain rejected");
assert(matchVerifiedDomain("") === null, "Empty string rejected");
assert(matchVerifiedDomain(null) === null, "Null input rejected");
assert(matchVerifiedDomain(undefined) === null, "Undefined input rejected");
assert(matchVerifiedDomain(42 as unknown as string) === null, "Non-string input rejected");

// Whitespace tolerance on the domain part
assert(
  matchVerifiedDomain("sara@ nust.edu.pk ") === "nust.edu.pk",
  "Whitespace around the domain is trimmed before matching"
);

console.log(`\n📋 Verified Badge Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("🎉 All Verified Badge Tests Passed!\n");
