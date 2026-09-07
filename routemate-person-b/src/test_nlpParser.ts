// Tests for the natural-language trip request parser (nlpParser.ts).
// Deliberately exercises ONLY the offline heuristic fallback path — no
// QWEN_API_KEY is set in this test run, so parseTripRequestText() always
// falls through to heuristicParse(), which is pure and needs no network.
// A real Qwen-key smoke test belongs in a separate, opt-in script (see
// README) since it costs money and needs network access this sandbox
// doesn't have.
import { parseTripRequestText } from "./nlpParser";

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

async function run() {
  console.log("\n🧪 Running NLP Parser (heuristic fallback) Test Suite...\n");

  const ref = new Date("2026-09-02T08:00:00.000Z");

  const r1 = await parseTripRequestText("I need to get from G-9 to NUST by 9am", ref);
  assert(r1.parsed_by === "heuristic_fallback", "Falls back to heuristic parser without QWEN_API_KEY");
  assert(r1.origin_text === "G-9", "Extracts origin from 'from X to Y' phrasing");
  assert(r1.destination_text === "NUST", "Extracts destination from 'from X to Y' phrasing");
  assert(r1.requested_departure_at !== null, "Resolves a clock time into an ISO timestamp");
  assert(r1.window_minutes === 15, "Applies default 15-minute window when a time is found");

  const r2 = await parseTripRequestText("women only please, going to F-10", ref);
  assert(r2.preference === "female_only", "'women only' maps to female_only");
  assert(r2.destination_text === "F-10", "Extracts destination-only phrasing ('to Y')");
  assert(r2.origin_text === null, "Origin stays null when not stated, not guessed");

  const r3 = await parseTripRequestText("men only ride to Blue Area", ref);
  assert(r3.preference === "male_only", "'men only' maps to male_only");

  const r4 = await parseTripRequestText("also want the driver to be a woman, to Saddar", ref);
  assert(r4.require_driver_gender_match === true, "Detects 'driver to be a woman' as require_driver_gender_match");

  const r5 = await parseTripRequestText("just heading to town", ref);
  assert(r5.preference === null, "No gender preference stated -> null, never defaulted");
  assert(r5.requested_departure_at === null, "No time stated -> requested_departure_at null");
  assert(r5.window_minutes === null, "No time stated -> window_minutes null (no default applied)");

  const r6 = await parseTripRequestText("leaving in 30 minutes to Aabpara", ref);
  assert(r6.requested_departure_at === new Date(ref.getTime() + 30 * 60 * 1000).toISOString(),
    "Resolves relative 'in N minutes' phrasing against the reference time");

  const r7 = await parseTripRequestText("", ref);
  assert(r7.fallback_reason === "EMPTY_INPUT", "Empty input is handled without throwing");

  const r8 = await parseTripRequestText("give or take 20 min, from H-8 to E-11 at 6pm", ref);
  assert(r8.window_minutes === 20, "Explicit 'give or take N min' overrides the default window");

  console.log(`\n📋 NLP Parser Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("❌ Some NLP parser tests failed.");
    process.exit(1);
  }
  console.log("🎉 All NLP Parser (heuristic fallback) Tests Passed!\n");
}

run();
