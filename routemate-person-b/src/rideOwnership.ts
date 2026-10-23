import { VehicleType } from "./types";

export type OwnershipMatchType = "peer_share" | "owner_passenger" | "shared_ride_hailing";

export interface OwnershipMatchInput {
  candidateUserId: string;
  matchType?: OwnershipMatchType;
  ownerUserId?: string;
  passengerUserId?: string;
  vehicleType?: VehicleType;
}

export interface RideParticipantResolution {
  /** The RouteSync user recorded as the ride owner/driver, when applicable. */
  driverUserId: string | null;
  /** The RouteSync user recorded as the passenger, when applicable. */
  passengerUserId: string | null;
  /** External ride-hailing trips have no RouteSync driver-owned ride. */
  createsOwnedRide: boolean;
}

/**
 * Resolve ride participants from the perspective of the currently signed-in
 * user. The old acceptance flow always used currentUserId as driver, which
 * incorrectly turned a passenger accepting a driver's match into the driver.
 */
export function resolveRideParticipants(
  currentUserId: string,
  match: OwnershipMatchInput
): RideParticipantResolution {
  if (match.matchType === "shared_ride_hailing" || match.vehicleType === "ride_hailing") {
    return { driverUserId: null, passengerUserId: null, createsOwnedRide: false };
  }

  if (match.matchType === "owner_passenger" && match.ownerUserId) {
    const passengerUserId =
      match.passengerUserId ??
      (match.ownerUserId === currentUserId ? match.candidateUserId : currentUserId);
    return {
      driverUserId: match.ownerUserId,
      passengerUserId,
      createsOwnedRide: true,
    };
  }

  // Peer-share has no canonical vehicle owner. Preserve the existing lead-user
  // convention while still explicitly recording the other rider as passenger.
  return {
    driverUserId: currentUserId,
    passengerUserId: match.candidateUserId,
    createsOwnedRide: true,
  };
}
