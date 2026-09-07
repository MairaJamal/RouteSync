import { isGenderCompatible } from "./matchEngine";

// ─────────────────────────────────────────────────────────────
// Part 1: isGenderCompatible edge cases — this is the exact logic that
// diverged from the DB's RLS policy (Day 4 Bug 2: male_only was dropped).
// ─────────────────────────────────────────────────────────────

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

check(
  "male_only requester + male candidate -> compatible",
  isGenderCompatible("male", "male_only", "male", "any") === true
);
check(
  "male_only requester + female candidate -> blocked",
  isGenderCompatible("male", "male_only", "female", "any") === false
);
check(
  "female_only requester + female candidate -> compatible",
  isGenderCompatible("female", "female_only", "female", "any") === true
);
check(
  "any + any, non_binary riders -> compatible",
  isGenderCompatible("non_binary", "any", "non_binary", "any") === true
);
check(
  "male_only requester + non_binary candidate -> blocked (non_binary isn't 'male')",
  isGenderCompatible("male", "male_only", "non_binary", "any") === false
);
check(
  "female (male_only pref) + male (any pref) -> compatible (requester is male)",
  isGenderCompatible("male", "any", "female", "male_only") === true
);
check(
  "female (male_only pref) + female (any pref) -> blocked (requester isn't male)",
  isGenderCompatible("female", "any", "female", "male_only") === false
);

console.log(`\nGender edge cases: ${pass} passed, ${fail} failed so far.\n`);

// ─────────────────────────────────────────────────────────────
// Part 2: mocked evaluateFullMatch pipeline (Day 3/4). Monkeypatches
// osrmClient.getRoute since router.project-osrm.org isn't reachable from
// this sandbox — same caveat as test.ts. Verifies the leg/color/fare-split
// wiring end to end without needing a live network call.
// ─────────────────────────────────────────────────────────────

import * as osrmClient from "./osrmClient";
import { TripRequest } from "./types";

const originalGetRoute = osrmClient.getRoute;

function mockRouteFor(points: { lat: number; lng: number }[]) {
  // Fabricate distance/duration proportional to number of hops so the
  // detour-cap math has something realistic to compare against.
  const legDistanceM = 4000;
  const legDurationS = 180; // 3 min/leg — keeps the 3-hop combined route
  // under the 15-min detour cap so this test can focus on wiring, not detour math.
  const legs = [];
  for (let i = 0; i < points.length - 1; i++) {
    legs.push({ distance_m: legDistanceM, duration_s: legDurationS });
  }
  return {
    distance_m: legDistanceM * (points.length - 1),
    duration_s: legDurationS * (points.length - 1),
    geometry: {
      type: "LineString" as const,
      coordinates: points.map((p) => [p.lng, p.lat] as [number, number]),
    },
    legs,
  };
}

(osrmClient as any).getRoute = async (points: any[]) => mockRouteFor(points);

async function runPipelineTests() {
  // Force the overlap gate open — this test validates leg/color/fare
  // WIRING, not routeOverlapPct's accuracy (that's covered in test.ts).
  process.env.MIN_OVERLAP_PCT = "0";
  const { evaluateFullMatch } = await import("./matchPipeline");

  const requester: TripRequest = {
    request_id: "req_1",
    user_id: "usr_1",
    user_name: "Requester",
    user_gender: "male",
    gender_preference: "any",
    origin: { lat: 33.6844, lng: 73.0479, address_label: "F-10 Markaz" },
    destination: { lat: 33.6484, lng: 72.9922, address_label: "NUST Gate 1" },
    status: "pending",
  };
  const candidateSameDest: TripRequest = {
    request_id: "req_2",
    user_id: "usr_2",
    user_name: "Candidate",
    user_gender: "male",
    gender_preference: "any",
    origin: { lat: 33.688, lng: 73.025, address_label: "G-9 Markaz" },
    destination: { lat: 33.6484, lng: 72.9922, address_label: "NUST Gate 1" }, // same dest
    status: "pending",
  };
  const candidateDiffDest: TripRequest = {
    ...candidateSameDest,
    request_id: "req_3",
    user_id: "usr_3",
    destination: { lat: 33.66, lng: 73.0, address_label: "Somewhere else" },
  };
  const candidateWrongGender: TripRequest = {
    ...candidateSameDest,
    request_id: "req_4",
    user_id: "usr_4",
    user_gender: "female",
    gender_preference: "female_only",
  };

  // NOTE: the mock always returns the same overlap-friendly geometry
  // regardless of input coords, so overlap_pct here reflects the mock's
  // fixed geometry, not real distances — this test is about the pipeline's
  // WIRING (legs, colors, fare split, gender short-circuit), not about
  // validating routeOverlapPct itself (that's covered in test.ts).

  const r1 = await evaluateFullMatch(requester, candidateWrongGender);
  check("Pipeline: gender mismatch short-circuits before any OSRM call", r1.reason === "MUTUAL_GENDER_MISMATCH");
  check("Pipeline: gender mismatch returns should_match=false", r1.should_match === false);

  const r2 = await evaluateFullMatch(requester, candidateSameDest);
  check("Pipeline (same destination): 2 legs produced", r2.legs.length === 2);
  check("Pipeline (same destination): leg 0 is blue, requester only", r2.legs[0]?.color === "blue" && r2.legs[0]?.occupant_user_ids.length === 1);
  check("Pipeline (same destination): leg 1 is green, both riders", r2.legs[1]?.color === "green" && r2.legs[1]?.occupant_user_ids.length === 2);
  check("Pipeline (same destination): candidate only billed for the shared leg", (r2.fare_split.find((f) => f.user_id === "usr_2")?.total_fare ?? 0) > 0 && (r2.fare_split.find((f) => f.user_id === "usr_2")?.total_fare ?? 0) < (r2.fare_split.find((f) => f.user_id === "usr_1")?.total_fare ?? 0));

  const r3 = await evaluateFullMatch(requester, candidateDiffDest);
  check("Pipeline (different destinations): 3 legs produced (blue/green/purple)", r3.legs.length === 3);
  check(
    "Pipeline (different destinations): leg colors in order",
    r3.legs.map((l) => l.color).join(",") === "blue,green,purple"
  );
  check(
    "Pipeline (different destinations): purple leg is requester-only (post candidate dropoff)",
    r3.legs[2]?.occupant_user_ids.length === 1 && r3.legs[2]?.occupant_user_ids[0] === "usr_1"
  );

  (osrmClient as any).getRoute = originalGetRoute;

  console.log(`\nTotal (gender edge cases + pipeline wiring): ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

runPipelineTests();
