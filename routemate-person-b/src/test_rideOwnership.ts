import { resolveRideParticipants } from "./rideOwnership";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
    console.log(`✅ ${message}`);
  } else {
    failed += 1;
    console.error(`❌ ${message}`);
  }
}

const driver = "driver-1";
const passenger = "passenger-1";

const passengerAcceptsDriver = resolveRideParticipants(passenger, {
  candidateUserId: driver,
  matchType: "owner_passenger",
  ownerUserId: driver,
  passengerUserId: passenger,
  vehicleType: "car",
});
assert(passengerAcceptsDriver.driverUserId === driver, "Passenger accepting a car match records the owner as driver");
assert(passengerAcceptsDriver.passengerUserId === passenger, "Passenger accepting a car match records self as passenger");
assert(passengerAcceptsDriver.createsOwnedRide, "A car match creates a RouteSync-owned ride");

const driverAcceptsPassenger = resolveRideParticipants(driver, {
  candidateUserId: passenger,
  matchType: "owner_passenger",
  ownerUserId: driver,
  passengerUserId: passenger,
  vehicleType: "car",
});
assert(driverAcceptsPassenger.driverUserId === driver, "Driver accepting a passenger match remains the driver");
assert(driverAcceptsPassenger.passengerUserId === passenger, "Driver accepting a passenger match records candidate as passenger");

const peerShare = resolveRideParticipants(driver, {
  candidateUserId: passenger,
  matchType: "peer_share",
});
assert(peerShare.driverUserId === driver, "Peer-share preserves the requester as lead driver");
assert(peerShare.passengerUserId === passenger, "Peer-share records the other rider as passenger");

const rideHailing = resolveRideParticipants(passenger, {
  candidateUserId: driver,
  matchType: "shared_ride_hailing",
  vehicleType: "ride_hailing",
});
assert(rideHailing.driverUserId === null, "Ride-hailing split has no RouteSync driver");
assert(rideHailing.passengerUserId === null, "Ride-hailing split does not create a fake passenger booking");
assert(!rideHailing.createsOwnedRide, "Ride-hailing split does not create a driver-owned ride");

console.log(`\nOwnership tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
