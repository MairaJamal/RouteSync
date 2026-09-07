import { TripRequest, LocationPoint, OSRMRouteResult, Gender, GenderPreference, VehicleType } from "./types";
import { getRoute } from "./osrmClient";
import { routeOverlapPct } from "./routeOverlap";
import { evaluateDetour, DETOUR_CAP_MINUTES } from "./detourCap";
import {
  calculateMultiStopFareSplit,
  calculateOwnerPassengerFare,
  calculateSharedHailingFareSplit,
  FareLeg,
  RiderFareShare,
} from "./fareSplit";
import { isGenderCompatible } from "./matchEngine";
import { isGroupSafePairing } from "./poolingCapacity";

export type LegColor = "blue" | "green" | "purple";

export interface LabeledLeg extends FareLeg {
  name: string;
  color: LegColor;
  occupant_user_ids: string[];
}

export interface FullMatchResult {
  should_match: boolean;
  reason?:
    | "MUTUAL_GENDER_MISMATCH"
    | "DRIVER_GENDER_MISMATCH"
    | "GROUP_SAFETY_MIXED_PAIR"
    | "INSUFFICIENT_OVERLAP"
    | "DETOUR_CAP_EXCEEDED"
    | "RIDE_HAILING_FARE_MISSING";
  overlap_pct: number;
  detour_added_minutes: number | null;
  legs: LabeledLeg[];
  fare_split: RiderFareShare[];
  /** Day 8: "peer_share" is the original behavior — two riders who each
   *  already have their own way there, splitting the route's cost.
   *  "owner_passenger" means exactly one side brought a car/bike; that
   *  side pays nothing and the other pays the full per-km fare (see
   *  calculateOwnerPassengerFare in fareSplit.ts). When both riders have
   *  a vehicle, or neither does, this stays "peer_share" — picking which
   *  of two vehicle-owners "wins" isn't something this pipeline decides.
   *  Day 11: "shared_ride_hailing" means at least one side is splitting a
   *  Yango/inDrive/Careem fare — nobody here owns the vehicle, so unlike
   *  owner_passenger EVERYONE pays a share (see
   *  calculateSharedHailingFareSplit), from the fixed quoted fare weighted
   *  by how many km each person travels. */
  match_type: "peer_share" | "owner_passenger" | "shared_ride_hailing";
  owner_user_id?: string;
  passenger_user_id?: string;
  vehicle_type?: VehicleType;
  /** Only set when match_type === "shared_ride_hailing" — the total
   *  fare (PKR) that was split. If both riders had independently
   *  entered a ride-hailing quote, this is their average and
   *  shared_fare_note explains that. */
  shared_fare_pkr?: number;
  shared_fare_note?: string;
  requester_route_geometry: OSRMRouteResult["geometry"] | null;
  candidate_route_geometry: OSRMRouteResult["geometry"] | null;
  combined_route_geometry: OSRMRouteResult["geometry"] | null;
}

const MIN_OVERLAP_PCT = Number(process.env.MIN_OVERLAP_PCT ?? 50);
const RATE_PER_KM = Number(process.env.FARE_RATE_PER_KM ?? 30); // PKR/km

/** Mirrors Person A's SQL gender_preference_allows(): does a preference
 *  admit a rider of the given gender? */
function genderPreferenceAllows(pref: GenderPreference, gender: Gender): boolean {
  if (pref === "any") return true;
  if (pref === "male_only") return gender === "male";
  return gender === "female"; // female_only
}

function sameLocation(a: LocationPoint, b: LocationPoint): boolean {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
}

/** Day 8/11: resolves which rider (if either) is the vehicle owner for
 *  this match, or whether this is a ride_hailing fare-split instead.
 *  Undefined/"none" vehicle_type is treated the same — most existing
 *  rows predate this field entirely. */
function resolveVehicleRoles(
  requester: TripRequest,
  candidate: TripRequest
): {
  match_type: "peer_share" | "owner_passenger" | "shared_ride_hailing";
  owner_user_id?: string;
  passenger_user_id?: string;
  vehicle_type?: VehicleType;
  shared_fare_pkr?: number;
  shared_fare_note?: string;
  fare_missing?: boolean;
} {
  const requesterHailing = requester.vehicle_type === "ride_hailing";
  const candidateHailing = candidate.vehicle_type === "ride_hailing";

  // Day 11: ride_hailing takes priority over the car/bike owner logic
  // below — nobody here owns a vehicle, the "vehicle" is a Yango/
  // inDrive/Careem car outside the app entirely, so the owner/passenger
  // free-ride model doesn't apply. Whichever side already has a quote
  // supplies the fare to split; if both do (each independently priced
  // the same trip), split their average and say so rather than
  // silently picking one arbitrarily.
  if (requesterHailing || candidateHailing) {
    const requesterFare = requesterHailing ? requester.ride_hailing_fare_pkr : undefined;
    const candidateFare = candidateHailing ? candidate.ride_hailing_fare_pkr : undefined;

    if (requesterFare != null && candidateFare != null) {
      const average = Math.round(((requesterFare + candidateFare) / 2) * 100) / 100;
      return {
        match_type: "shared_ride_hailing",
        vehicle_type: "ride_hailing",
        shared_fare_pkr: average,
        shared_fare_note:
          `Both riders entered a fare quote (Rs ${requesterFare} and Rs ${candidateFare}) — ` +
          `split from their average, Rs ${average}.`,
      };
    }
    const fare = requesterFare ?? candidateFare;
    if (fare == null) {
      // Declared ride_hailing but nobody actually entered what the
      // ride-hailing app quoted — there's nothing to split. This is a
      // data problem, not a routing one, so it's surfaced distinctly
      // from INSUFFICIENT_OVERLAP/DETOUR_CAP_EXCEEDED.
      return { match_type: "shared_ride_hailing", vehicle_type: "ride_hailing", fare_missing: true };
    }
    return { match_type: "shared_ride_hailing", vehicle_type: "ride_hailing", shared_fare_pkr: fare };
  }

  const requesterHasVehicle = requester.vehicle_type && requester.vehicle_type !== "none";
  const candidateHasVehicle = candidate.vehicle_type && candidate.vehicle_type !== "none";

  if (requesterHasVehicle && !candidateHasVehicle) {
    return {
      match_type: "owner_passenger",
      owner_user_id: requester.user_id,
      passenger_user_id: candidate.user_id,
      vehicle_type: requester.vehicle_type,
    };
  }
  if (candidateHasVehicle && !requesterHasVehicle) {
    return {
      match_type: "owner_passenger",
      owner_user_id: candidate.user_id,
      passenger_user_id: requester.user_id,
      vehicle_type: candidate.vehicle_type,
    };
  }
  // Both have a vehicle, or neither does — no clear owner, fall back to
  // the original symmetric peer-share economics.
  return { match_type: "peer_share" };
}

/**
 * Builds the waypoint order + leg/color/occupancy structure for a 2-rider
 * match, matching the Day 5 map convention:
 *   Blue   = lead leg (requester alone, before pickup)
 *   Green  = shared leg (both riders aboard)
 *   Purple = final dropoff leg (requester alone, after candidate's dropoff)
 * The purple leg only exists when the two destinations differ.
 */
function buildWaypointsAndLegTemplate(
  requester: TripRequest,
  candidate: TripRequest
): { waypoints: LocationPoint[]; legTemplate: { color: LegColor; occupants: string[] }[] } {
  const sameDestination = sameLocation(requester.destination, candidate.destination);

  if (sameDestination) {
    return {
      waypoints: [requester.origin, candidate.origin, requester.destination],
      legTemplate: [
        { color: "blue", occupants: [requester.user_id] },
        { color: "green", occupants: [requester.user_id, candidate.user_id] },
      ],
    };
  }

  // Different destinations: candidate rides the shared middle leg, then
  // drops off before the requester's final stop.
  return {
    waypoints: [requester.origin, candidate.origin, candidate.destination, requester.destination],
    legTemplate: [
      { color: "blue", occupants: [requester.user_id] },
      { color: "green", occupants: [requester.user_id, candidate.user_id] },
      { color: "purple", occupants: [requester.user_id] },
    ],
  };
}

/**
 * evaluateFullMatch — the Day 3 "combine modules" pipeline. Given two active
 * trip requests, this fetches live OSRM routes, scores overlap, enforces the
 * 15-minute detour cap, and returns a proportional fare split — everything
 * the matches/fare_estimates tables need in one call.
 */
export async function evaluateFullMatch(
  requester: TripRequest,
  candidate: TripRequest
): Promise<FullMatchResult> {
  const empty: FullMatchResult = {
    should_match: false,
    overlap_pct: 0,
    detour_added_minutes: null,
    legs: [],
    fare_split: [],
    match_type: "peer_share",
    requester_route_geometry: null,
    candidate_route_geometry: null,
    combined_route_geometry: null,
  };

  // 1. Gender check first — cheapest, and must never be bypassed by a
  //    network error further down.
  if (
    !isGenderCompatible(
      requester.user_gender,
      requester.gender_preference,
      candidate.user_gender,
      candidate.gender_preference
    )
  ) {
    return { ...empty, reason: "MUTUAL_GENDER_MISMATCH" };
  }

  // 1b. Day 7: require_driver_gender_match. The leg convention in this
  //     pipeline makes the REQUESTER the ride owner/driver of the combined
  //     route (blue lead leg is theirs, detour is measured against their
  //     solo route) — so "the driver must match my preference" resolves to:
  //       - candidate set the flag → requester's gender must satisfy the
  //         candidate's preference;
  //       - requester set the flag → they ARE the driver, so their own
  //         gender must satisfy their own preference (defensive; the UI
  //         only offers the checkbox when this already holds).
  //     Same ordering rationale as the gender check: cheapest, and a safety
  //     gate must never be bypassed by a downstream network error.
  if (
    candidate.require_driver_gender_match &&
    !genderPreferenceAllows(candidate.gender_preference, requester.user_gender)
  ) {
    return { ...empty, reason: "DRIVER_GENDER_MISMATCH" };
  }
  if (
    requester.require_driver_gender_match &&
    !genderPreferenceAllows(requester.gender_preference, requester.user_gender)
  ) {
    return { ...empty, reason: "DRIVER_GENDER_MISMATCH" };
  }

  // 1c. Day 7 group-safety rule: a match here always forms a 2-rider (1:1)
  //     ride, so mixed-gender pairs require BOTH riders to have opted into
  //     'any'. Rule lives in poolingCapacity.ts; enforced here too because
  //     this pipeline is the other place a 1:1 pairing gets created.
  if (
    !isGroupSafePairing(
      requester.user_gender,
      requester.gender_preference,
      candidate.user_gender,
      candidate.gender_preference
    )
  ) {
    return { ...empty, reason: "GROUP_SAFETY_MIXED_PAIR" };
  }

  // 1d. Day 11: if this would be a ride_hailing split, there must be an
  //     actual fare to split. Checked here — before the OSRM calls below
  //     — because it's a data problem, not a routing one; no point
  //     spending a network round-trip on a match that can't proceed
  //     regardless of overlap/detour.
  const vehicleRolesPreCheck = resolveVehicleRoles(requester, candidate);
  if (vehicleRolesPreCheck.fare_missing) {
    return {
      ...empty,
      match_type: "shared_ride_hailing",
      vehicle_type: "ride_hailing",
      reason: "RIDE_HAILING_FARE_MISSING",
    };
  }

  // 2. Fetch each rider's solo route from OSRM (real road geometry, not a
  //    straight line) so the overlap score means something.
  const [requesterRoute, candidateRoute] = await Promise.all([
    getRoute([requester.origin, requester.destination]),
    getRoute([candidate.origin, candidate.destination]),
  ]);

  const overlap_pct = routeOverlapPct(requesterRoute.geometry, candidateRoute.geometry);

  if (overlap_pct < MIN_OVERLAP_PCT) {
    return {
      ...empty,
      overlap_pct,
      reason: "INSUFFICIENT_OVERLAP",
      requester_route_geometry: requesterRoute.geometry,
      candidate_route_geometry: candidateRoute.geometry,
    };
  }

  // 3. Build the combined multi-stop route and check the detour cap.
  const { waypoints, legTemplate } = buildWaypointsAndLegTemplate(requester, candidate);
  const combinedRoute = await getRoute(waypoints);
  const detour = evaluateDetour(requesterRoute.duration_s, combinedRoute.duration_s);

  if (!detour.approved) {
    return {
      ...empty,
      overlap_pct,
      detour_added_minutes: detour.added_minutes,
      reason: "DETOUR_CAP_EXCEEDED",
      requester_route_geometry: requesterRoute.geometry,
      candidate_route_geometry: candidateRoute.geometry,
      combined_route_geometry: combinedRoute.geometry,
    };
  }

  // 4. Fare split — use OSRM's per-leg distances from the combined route
  //    (falls back to an even split of total distance if OSRM didn't
  //    return a legs breakdown for this profile/version).
  const osrmLegs = combinedRoute.legs;
const legs: FareLeg[] = legTemplate.map((t, i) => ({
  leg_index: i,
  from_label: i === 0 ? requester.origin.address_label : waypoints[i].address_label,
  to_label: waypoints[i + 1].address_label,
  distance_m:
    osrmLegs && osrmLegs[i]
      ? osrmLegs[i].distance_m
      : combinedRoute.distance_m / legTemplate.length,
  duration_s:
    osrmLegs && osrmLegs[i]
      ? osrmLegs[i].duration_s
      : combinedRoute.duration_s / legTemplate.length, // 👈 Added duration_s
}));

  const riderLegMap: Record<string, number[]> = {};
  legTemplate.forEach((t, i) => {
    for (const userId of t.occupants) {
      riderLegMap[userId] = [...(riderLegMap[userId] ?? []), i];
    }
  });

  // Day 8/11: owner/passenger vs. peer-share vs. shared_ride_hailing
  // economics. Reuses vehicleRolesPreCheck computed in step 1d rather
  // than recomputing — resolveVehicleRoles is pure/cheap, but there's
  // no reason to call it twice. Note on bike capacity: this pipeline
  // only ever evaluates a single 1:1 pairing, so "a bike carries
  // exactly one passenger" is automatically satisfied here — a
  // trip_request's status flips to 'matched' once accepted and stops
  // surfacing as a match candidate, so a bike owner can't end up
  // matched to two passengers from this flow at once.
  const vehicleRoles = vehicleRolesPreCheck;
  const fare_split =
    vehicleRoles.match_type === "owner_passenger" && vehicleRoles.owner_user_id && vehicleRoles.passenger_user_id
      ? calculateOwnerPassengerFare(
          legs,
          RATE_PER_KM,
          vehicleRoles.owner_user_id,
          vehicleRoles.passenger_user_id,
          riderLegMap
        )
      : vehicleRoles.match_type === "shared_ride_hailing" && vehicleRoles.shared_fare_pkr != null
      ? calculateSharedHailingFareSplit(vehicleRoles.shared_fare_pkr, legs, riderLegMap)
      : calculateMultiStopFareSplit({ legs, ratePerKm: RATE_PER_KM, riderLegMap });

const labeledLegs: LabeledLeg[] = legs.map((leg, i) => {
  const template = legTemplate[i];

  return {
    ...leg,
    name: `Leg ${i + 1}`, // Generate the name since legTemplate doesn't have it
    color: template?.color ?? ("blue" as LegColor),
    occupant_user_ids: template?.occupants ?? [],
  };
});

  return {
    should_match: true,
    overlap_pct,
    detour_added_minutes: detour.added_minutes,
    legs: labeledLegs,
    fare_split,
    match_type: vehicleRoles.match_type,
    owner_user_id: vehicleRoles.owner_user_id,
    passenger_user_id: vehicleRoles.passenger_user_id,
    vehicle_type: vehicleRoles.vehicle_type,
    shared_fare_pkr: vehicleRoles.shared_fare_pkr,
    shared_fare_note: vehicleRoles.shared_fare_note,
    requester_route_geometry: requesterRoute.geometry,
    candidate_route_geometry: candidateRoute.geometry,
    combined_route_geometry: combinedRoute.geometry,
  };
}

export { DETOUR_CAP_MINUTES, MIN_OVERLAP_PCT };
