export interface FareLeg {
  leg_index: number;
  from_label: string;
  to_label: string;
  distance_m: number;
  duration_s: number; // 👈 Add this to the base interface
}

export interface RiderFareShare {
  user_id: string;
  total_fare: number;
  /** Share of total rider-km (0–100). Set for ride-hailing km splits. */
  distance_share_pct?: number;
  /** Kilometres this rider travels on the combined trip. */
  distance_km?: number;
}

/**
 * calculateOwnerPassengerFare — Day 8: for an asymmetric match (one rider
 * has a car/bike, the other doesn't), the vehicle owner isn't "sharing a
 * cost" the way two peers would — they're providing the ride. So unlike
 * calculateMultiStopFareSplit (which divides each leg's cost among its
 * occupants), this charges the passenger the FULL per-km cost, but ONLY
 * for legs where the owner is actually present too — a passenger can't be
 * billed for a leg the owner's vehicle wasn't even on. (The pipeline's
 * waypoint model always attributes "solo" legs to whichever rider is the
 * `requester`, independent of who owns the vehicle — see
 * buildWaypointsAndLegTemplate in matchPipeline.ts — so this intersection
 * is what keeps the fare honest regardless of which side is which.)
 */
export function calculateOwnerPassengerFare(
  legs: FareLeg[],
  ratePerKm: number,
  ownerUserId: string,
  passengerUserId: string,
  riderLegMap: Record<string, number[]>
): RiderFareShare[] {
  const ownerLegs = new Set(riderLegMap[ownerUserId] ?? []);
  const passengerLegs = new Set(riderLegMap[passengerUserId] ?? []);
  let passengerTotal = 0;
  for (const leg of legs) {
    if (ownerLegs.has(leg.leg_index) && passengerLegs.has(leg.leg_index)) {
      passengerTotal += (leg.distance_m / 1000) * ratePerKm;
    }
  }
  return [
    { user_id: ownerUserId, total_fare: 0 },
    { user_id: passengerUserId, total_fare: Math.round(passengerTotal * 100) / 100 },
  ];
}

export interface MultiStopFareSplitInput {
  legs: FareLeg[];
  ratePerKm: number; // e.g. PKR/km
  riderLegMap: Record<string, number[]>; // user_id -> leg_indexes they occupy
}

/**
 * calculateMultiStopFareSplit — divides each leg's cost (distance * rate)
 * evenly among the riders actively occupying that leg, then sums per rider
 * across all legs they rode.
 */
export function calculateMultiStopFareSplit(
  input: MultiStopFareSplitInput
): RiderFareShare[] {
  const { legs, ratePerKm, riderLegMap } = input;

  const legCosts = new Map<number, number>();
  for (const leg of legs) {
    legCosts.set(leg.leg_index, (leg.distance_m / 1000) * ratePerKm);
  }

  const totals = new Map<string, number>();
  for (const userId of Object.keys(riderLegMap)) totals.set(userId, 0);

  for (const leg of legs) {
    const cost = legCosts.get(leg.leg_index) ?? 0;
    const ridersOnLeg = Object.entries(riderLegMap).filter(([, legIdxs]) =>
      legIdxs.includes(leg.leg_index)
    );
    if (ridersOnLeg.length === 0) continue;
    const perRiderShare = cost / ridersOnLeg.length;
    for (const [userId] of ridersOnLeg) {
      totals.set(userId, (totals.get(userId) ?? 0) + perRiderShare);
    }
  }

  return Array.from(totals.entries()).map(([user_id, total_fare]) => ({
    user_id,
    total_fare: Math.round(total_fare * 100) / 100,
  }));
}

/**
 * Sum how many kilometres each rider travels (legs they occupy).
 * Shared legs count fully for every occupant — that's "km travelled by
 * each person", not an exclusive allocation of road distance.
 */
export function riderKilometres(
  legs: FareLeg[],
  riderLegMap: Record<string, number[]>
): Record<string, number> {
  const byUser: Record<string, number> = {};
  for (const userId of Object.keys(riderLegMap)) byUser[userId] = 0;
  for (const leg of legs) {
    const km = (leg.distance_m || 0) / 1000;
    for (const [userId, idxs] of Object.entries(riderLegMap)) {
      if (idxs.includes(leg.leg_index)) {
        byUser[userId] = (byUser[userId] ?? 0) + km;
      }
    }
  }
  return byUser;
}

/**
 * calculateSharedHailingFareSplit — for a ride_hailing match, nobody drove:
 * there's a single fixed fare (Yango/inDrive/Careem quote) to divide among
 * the people in the car. Each person's share is proportional to the km
 * they travel on the combined trip:
 *
 *   share_i = totalFare × (km_i / Σ km)
 *
 * Everyone pays — including whoever booked the quote. Shares always sum
 * to EXACTLY totalFarePkr (rounding remainder goes to the largest km
 * rider, then first rider as tie-break).
 *
 * If distances are missing/zero, falls back to an even N-way split.
 */
export function calculateSharedHailingFareSplit(
  totalFarePkr: number,
  legs: FareLeg[],
  riderLegMap: Record<string, number[]>
): RiderFareShare[] {
  const riderUserIds = Object.keys(riderLegMap);
  if (riderUserIds.length === 0) return [];

  const kmByUser = riderKilometres(legs, riderLegMap);
  const totalKm = riderUserIds.reduce((s, id) => s + (kmByUser[id] ?? 0), 0);

  // Equal / missing distances → even split (still exact-sum rounded).
  if (!(totalKm > 0)) {
    const evenShare = Math.floor((totalFarePkr / riderUserIds.length) * 100) / 100;
    const shares = riderUserIds.map((user_id) => ({
      user_id,
      total_fare: evenShare,
      distance_share_pct: Math.round(100 / riderUserIds.length),
      distance_km: 0,
    }));
    const shortfall = Math.round((totalFarePkr - evenShare * riderUserIds.length) * 100) / 100;
    if (shortfall !== 0) {
      shares[0].total_fare = Math.round((shares[0].total_fare + shortfall) * 100) / 100;
    }
    return shares;
  }

  // Floor each proportional share to the cent, then put remainder on the
  // rider with the most km so the long-haul person absorbs 1-rupee dust.
  const provisional = riderUserIds.map((user_id) => {
    const km = kmByUser[user_id] ?? 0;
    const raw = totalFarePkr * (km / totalKm);
    return {
      user_id,
      total_fare: Math.floor(raw * 100) / 100,
      distance_km: Math.round(km * 1000) / 1000,
      distance_share_pct: Math.round((km / totalKm) * 100),
    };
  });

  const allocated = provisional.reduce((s, r) => s + r.total_fare, 0);
  const shortfall = Math.round((totalFarePkr - allocated) * 100) / 100;
  if (shortfall !== 0) {
    let adjustIdx = 0;
    let bestKm = -1;
    provisional.forEach((r, i) => {
      if ((r.distance_km ?? 0) > bestKm) {
        bestKm = r.distance_km ?? 0;
        adjustIdx = i;
      }
    });
    provisional[adjustIdx].total_fare =
      Math.round((provisional[adjustIdx].total_fare + shortfall) * 100) / 100;
  }

  return provisional;
}
