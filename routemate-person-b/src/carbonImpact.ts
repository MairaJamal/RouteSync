/* Day 9: Single source of truth for the CO2-avoided number shown at
 * every share touchpoint (fare estimate, match confirm, chat drawer,
 * trip completion, profile running total) — previously this math
 * only lived inline in FareComparisonCard.tsx and only ran once. */

/** kg of CO2 per km for one petrol car doing the trip solo. Same
 * factor FareComparisonCard.tsx used before this file existed —
 * kept here so every caller agrees on one number. */
export const CO2_KG_PER_KM_SOLO_CAR = 0.21;

/**
 * CO2 avoided by pooling `riderCount` people into one vehicle instead
 * of each driving solo, over `distanceKm`. Only the trips that were
 * actually *avoided* count — one car is still on the road, so it's
 * (riderCount - 1) solo trips saved, not riderCount.
 */
export function co2SavedKgTotal(distanceKm: number, riderCount: number): number {
  if (!distanceKm || riderCount <= 1) return 0;
  const soloTripsAvoided = riderCount - 1;
  return Number((distanceKm * CO2_KG_PER_KM_SOLO_CAR * soloTripsAvoided).toFixed(1));
}

/** Same total, split evenly per rider — what a running profile total
 * should accumulate (matches record_ride_carbon_savings() in the
 * 20260904000000_group_consent_carbon.sql migration). */
export function co2SavedKgPerRider(distanceKm: number, riderCount: number): number {
  if (riderCount <= 0) return 0;
  return Number((co2SavedKgTotal(distanceKm, riderCount) / riderCount).toFixed(2));
}

/** Short human-readable line for badges/toasts, e.g.
 * "🌱 2.1 kg CO₂ avoided — sharing with 3 people instead of everyone driving solo". */
export function co2SavedSummary(distanceKm: number, riderCount: number): string {
  const total = co2SavedKgTotal(distanceKm, riderCount);
  if (total <= 0) return "";
  const who = riderCount === 2 ? "1 other rider" : `${riderCount - 1} other riders`;
  return `🌱 ${total} kg CO₂ avoided by sharing with ${who} instead of everyone driving solo`;
}
