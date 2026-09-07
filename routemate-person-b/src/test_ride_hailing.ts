// Day 11: tests for ride_hailing (shared Yango/inDrive/Careem) fare
// splitting. Same OSRM-mocking approach as test_vehicleMatch.ts — this
// is about resolveVehicleRoles()/calculateSharedHailingFareSplit()
// WIRING through evaluateFullMatch, not route-overlap accuracy.
import * as osrmClient from "./osrmClient";
import { TripRequest } from "./types";
import { calculateSharedHailingFareSplit } from "./fareSplit";

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

function mockRouteFor(points: { lat: number; lng: number }[]) {
  const legDistanceM = 4000;
  const legDurationS = 180;
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

async function run() {
  process.env.MIN_OVERLAP_PCT = "0";
  const { evaluateFullMatch } = await import("./matchPipeline");

  const noVehicleRider: TripRequest = {
    request_id: "req_1",
    user_id: "usr_1",
    user_name: "No Vehicle",
    user_gender: "male",
    gender_preference: "any",
    origin: { lat: 33.6844, lng: 73.0479, address_label: "F-10 Markaz" },
    destination: { lat: 33.6484, lng: 72.9922, address_label: "NUST Gate 1" },
    status: "pending",
  };
  const hailingRiderWithFare: TripRequest = {
    ...noVehicleRider,
    request_id: "req_2",
    user_id: "usr_2",
    user_name: "Has A Quote",
    vehicle_type: "ride_hailing",
    ride_hailing_fare_pkr: 900,
    origin: { lat: 33.688, lng: 73.025, address_label: "G-9 Markaz" },
  };
  const hailingRiderNoFare: TripRequest = {
    ...noVehicleRider,
    request_id: "req_3",
    user_id: "usr_3",
    user_name: "Forgot To Enter Fare",
    vehicle_type: "ride_hailing",
    // ride_hailing_fare_pkr intentionally omitted
  };
  const secondHailingRiderWithFare: TripRequest = {
    ...noVehicleRider,
    request_id: "req_4",
    user_id: "usr_4",
    user_name: "Also Has A Quote",
    vehicle_type: "ride_hailing",
    ride_hailing_fare_pkr: 1100,
  };
  const carOwner: TripRequest = {
    ...noVehicleRider,
    request_id: "req_5",
    user_id: "usr_5",
    user_name: "Car Owner",
    vehicle_type: "car",
  };

  // TEST 1: ride_hailing rider + no-vehicle rider -> shared_ride_hailing,
  // BOTH riders pay a share (unlike owner_passenger, where the owner is free).
  {
    const result = await evaluateFullMatch(hailingRiderWithFare, noVehicleRider);
    check("shared_ride_hailing: should_match", result.should_match === true);
    check("shared_ride_hailing: match_type", result.match_type === "shared_ride_hailing");
    check("shared_ride_hailing: shared_fare_pkr = 900", result.shared_fare_pkr === 900);
    const quoterShare = result.fare_split.find((f) => f.user_id === "usr_2")?.total_fare;
    const otherShare = result.fare_split.find((f) => f.user_id === "usr_1")?.total_fare;
    check(
      "shared_ride_hailing: the rider who had the quote ALSO pays (not free, unlike owner_passenger)",
      typeof quoterShare === "number" && quoterShare > 0,
      `got ${quoterShare}`
    );
    check(
      "shared_ride_hailing: both shares sum to the total fare",
      Math.abs((quoterShare ?? 0) + (otherShare ?? 0) - 900) < 0.01
    );
  }

  // TEST 2: a ride_hailing rider who never entered a fare can't match —
  // there's nothing to split, and this must be a distinct reason, not a
  // silent INSUFFICIENT_OVERLAP-style failure.
  {
    const result = await evaluateFullMatch(hailingRiderNoFare, noVehicleRider);
    check("missing fare: should_match = false", result.should_match === false);
    check(
      "missing fare: reason is RIDE_HAILING_FARE_MISSING, not a routing reason",
      result.reason === "RIDE_HAILING_FARE_MISSING"
    );
  }

  // TEST 3: both sides independently entered a ride_hailing quote ->
  // average the two, and say so via shared_fare_note.
  {
    const result = await evaluateFullMatch(hailingRiderWithFare, secondHailingRiderWithFare);
    check("both quoted: should_match", result.should_match === true);
    check("both quoted: fare is the average of 900 and 1100 = 1000", result.shared_fare_pkr === 1000);
    check("both quoted: a note explains the averaging", typeof result.shared_fare_note === "string" && result.shared_fare_note!.length > 0);
  }

  // TEST 4: ride_hailing takes priority over car/bike owner logic — if
  // one side is ride_hailing, it's never treated as owner_passenger even
  // though the other side has no vehicle at all (the classic
  // owner_passenger trigger condition).
  {
    const result = await evaluateFullMatch(hailingRiderWithFare, carOwner);
    check(
      "ride_hailing beats owner_passenger: match_type is still shared_ride_hailing",
      result.match_type === "shared_ride_hailing"
    );
  }

  // TEST 5: calculateSharedHailingFareSplit — km-proportional + exact sum.
  {
    const evenLegs = [
      { leg_index: 0, from_label: "A", to_label: "B", distance_m: 5000, duration_s: 300 },
      { leg_index: 1, from_label: "B", to_label: "C", distance_m: 5000, duration_s: 300 },
    ];
    // Both riders on both legs → equal km → even money.
    const evenSplit = calculateSharedHailingFareSplit(900, evenLegs, {
      a: [0, 1],
      b: [0, 1],
      c: [0, 1],
    });
    const evenSum = evenSplit.reduce((s, r) => s + r.total_fare, 0);
    check("equal-km split: 900/3 riders sums to exactly 900", Math.abs(evenSum - 900) < 0.001, `got ${evenSum}`);
    check("equal-km split: each rider pays exactly 300", evenSplit.every((r) => r.total_fare === 300));

    const oddSplit = calculateSharedHailingFareSplit(1000, evenLegs, {
      a: [0, 1],
      b: [0, 1],
      c: [0, 1],
    });
    const oddSum = oddSplit.reduce((s, r) => s + r.total_fare, 0);
    check(
      "equal-km uneven rupees (1000/3): shares still sum to EXACTLY the total",
      Math.abs(oddSum - 1000) < 0.001,
      `got ${oddSum}`
    );

    // a rides 10km, b rides 5km → a pays 2/3 of 900 = 600, b pays 300.
    const weightedLegs = [
      { leg_index: 0, from_label: "A", to_label: "B", distance_m: 5000, duration_s: 300 },
      { leg_index: 1, from_label: "B", to_label: "C", distance_m: 5000, duration_s: 300 },
    ];
    const weighted = calculateSharedHailingFareSplit(900, weightedLegs, {
      a: [0, 1],
      b: [1],
    });
    const aShare = weighted.find((r) => r.user_id === "a")?.total_fare;
    const bShare = weighted.find((r) => r.user_id === "b")?.total_fare;
    check(
      "km-weighted: longer rider pays more (a=10km → 600, b=5km → 300)",
      aShare === 600 && bShare === 300,
      `got a=${aShare} b=${bShare}`
    );
    check(
      "km-weighted: shares sum to total",
      Math.abs((aShare ?? 0) + (bShare ?? 0) - 900) < 0.001
    );

    const emptySplit = calculateSharedHailingFareSplit(500, [], {});
    check("empty rider list: returns an empty split, not an error", emptySplit.length === 0);
  }

  console.log(`\n📋 Ride Hailing Fare Split Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\n🚨 Some tests failed!");
    process.exit(1);
  } else {
    console.log("\n🎉 All Ride Hailing Fare Split Tests Passed!");
  }
}

run();
