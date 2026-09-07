// Day 8: tests for owner/passenger vehicle matching (car/bike).
// Same OSRM-mocking approach as test_day4.ts's Part 2 — router.project-
// osrm.org isn't reachable from this sandbox, so osrmClient.getRoute is
// monkeypatched with a fixed, overlap-friendly fake route. This test is
// about resolveVehicleRoles()/calculateOwnerPassengerFare() WIRING
// through evaluateFullMatch, not about route-overlap accuracy.
import * as osrmClient from "./osrmClient";
import { TripRequest } from "./types";

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
  const carOwner: TripRequest = {
    ...noVehicleRider,
    request_id: "req_2",
    user_id: "usr_2",
    user_name: "Car Owner",
    vehicle_type: "car",
    origin: { lat: 33.688, lng: 73.025, address_label: "G-9 Markaz" },
  };
  const bikeOwner: TripRequest = {
    ...carOwner,
    request_id: "req_3",
    user_id: "usr_3",
    user_name: "Bike Owner",
    vehicle_type: "bike",
  };
  const anotherCarOwner: TripRequest = {
    ...carOwner,
    request_id: "req_4",
    user_id: "usr_4",
    user_name: "Also Has A Car",
  };
  const noVehiclePeer: TripRequest = {
    ...noVehicleRider,
    request_id: "req_5",
    user_id: "usr_5",
    user_name: "Also No Vehicle",
  };

  // ── Owner/passenger: requester has no vehicle, candidate has a car ──
  const r1 = await evaluateFullMatch(noVehicleRider, carOwner);
  check("Car match: should_match true", r1.should_match === true);
  check("Car match: match_type is owner_passenger", r1.match_type === "owner_passenger");
  check("Car match: owner is the car-having candidate", r1.owner_user_id === "usr_2");
  check("Car match: passenger is the requester", r1.passenger_user_id === "usr_1");
  check("Car match: vehicle_type carried through as 'car'", r1.vehicle_type === "car");
  const ownerFareR1 = r1.fare_split.find((f) => f.user_id === "usr_2")?.total_fare;
  const passengerFareR1 = r1.fare_split.find((f) => f.user_id === "usr_1")?.total_fare;
  check("Car match: owner pays 0", ownerFareR1 === 0);
  check("Car match: passenger pays > 0", (passengerFareR1 ?? 0) > 0);

  // ── Owner/passenger: requester has a bike, candidate has none ──
  const r2 = await evaluateFullMatch(bikeOwner, noVehicleRider);
  check("Bike match: match_type is owner_passenger", r2.match_type === "owner_passenger");
  check("Bike match: owner is the requester (bike owner)", r2.owner_user_id === "usr_3");
  check("Bike match: passenger is the candidate", r2.passenger_user_id === "usr_1");
  check("Bike match: vehicle_type carried through as 'bike'", r2.vehicle_type === "bike");

  // ── Both riders have a vehicle: falls back to peer-share, no owner ──
  const r3 = await evaluateFullMatch(carOwner, anotherCarOwner);
  check("Both have vehicles: match_type stays peer_share", r3.match_type === "peer_share");
  check("Both have vehicles: no owner_user_id assigned", r3.owner_user_id === undefined);
  const bothFareLower = r3.fare_split.find((f) => f.user_id === "usr_2")?.total_fare ?? -1;
  check("Both have vehicles: candidate still pays something (peer split, not free)", bothFareLower > 0);

  // ── Neither rider has a vehicle: classic peer-share, unaffected ──
  const r4 = await evaluateFullMatch(noVehicleRider, noVehiclePeer);
  check("Neither has a vehicle: match_type is peer_share", r4.match_type === "peer_share");
  check("Neither has a vehicle: both riders pay > 0 (split, not free)",
    (r4.fare_split.find((f) => f.user_id === "usr_1")?.total_fare ?? 0) > 0 &&
    (r4.fare_split.find((f) => f.user_id === "usr_5")?.total_fare ?? 0) > 0
  );

  // ── Passenger's fare should equal exactly their occupied-leg distance
  //    at the full (undivided) rate — the whole point of "owner isn't
  //    sharing a cost, they're providing a ride". ──
  const RATE_PER_KM = Number(process.env.FARE_RATE_PER_KM ?? 30);
  const sharedLegKm = 4; // mockRouteFor's fixed 4000m per leg
  const expectedPassengerFare = Math.round(sharedLegKm * RATE_PER_KM * 100) / 100;
  check(
    "Car match: passenger pays full per-km rate for their leg (not divided)",
    passengerFareR1 === expectedPassengerFare,
    `expected ${expectedPassengerFare}, got ${passengerFareR1}`
  );

  console.log(`\n📋 Vehicle Match Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("❌ Some vehicle match tests failed.");
    process.exit(1);
  }
  console.log("🎉 All Vehicle Match Tests Passed!\n");
}

run();
