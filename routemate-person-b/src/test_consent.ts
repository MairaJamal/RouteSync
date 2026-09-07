/* Day 9: Unit tests for group consent — 3+ rider pools must get
 * unanimous agreement before finalizing, while 1:1 joins keep
 * auto-accepting exactly as before. */
import { canAddPassenger, bookPooledRideAtomic, respondToRideConsentAtomic, needsGroupConsent } from "./poolingCapacity";
import { RideWithBookings, PassengerCandidate } from "./types";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

async function runConsentTests() {
  console.log("\n🧪 Running Group Consent Test Suite...\n");

  const mockOrigin = { lat: 33.6844, lng: 73.0479, address_label: "F-10 Markaz" };
  const mockDest = { lat: 33.6432, lng: 72.9902, address_label: "NUST Gate 1" };

  function createBaseRide(): RideWithBookings {
    return {
      id: `ride-${Math.random().toString(36).slice(2)}`,
      driver_id: "driver-1",
      origin: mockOrigin,
      destination: mockDest,
      departure_time: new Date().toISOString(),
      total_seats: 4,
      available_seats: 4,
      driver_max_co_passengers: 5,
      status: "active",
      passengers: [],
    };
  }

  function candidate(id: string): PassengerCandidate {
    return {
      passenger_id: id,
      seats_requested: 1,
      max_co_passengers: -1,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };
  }

  // TEST 1: first passenger (driver + 1 = 2 total riders) auto-accepts, no consent needed.
  {
    const ride = createBaseRide();
    assert(needsGroupConsent(ride) === false, "1:1 join (driver + first passenger) needs no consent");
    const result = await bookPooledRideAtomic(ride, candidate("rider-A"));
    assert(result.success === true && result.booking?.status === "accepted", "First passenger books straight to accepted");
    assert(result.consents === undefined, "No consent rows created for a 1:1 join");
  }

  // TEST 2: second passenger (3 total riders) requires unanimous consent from driver + rider-A + rider-B.
  {
    const ride = createBaseRide();
    const first = await bookPooledRideAtomic(ride, candidate("rider-A"));
    assert(first.booking?.status === "accepted", "Setup: first passenger accepted");

    assert(needsGroupConsent(ride) === true, "Adding a 3rd rider requires group consent");
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    assert(second.success === true, "3rd rider's join is accepted into the pool (pending consent)");
    assert(second.booking?.status === "pending_consent", "3rd rider's booking status is pending_consent, not accepted");
    assert((second.consents?.length ?? 0) === 3, "Consent requested from driver + rider-A + rider-B (3 voters)");
    assert(ride.available_seats === 2, "Seat is reserved immediately even while consent is pending (4 - 1 - 1)");

    const bookingId = second.booking!.id;

    // Not everyone has voted yet — booking must stay pending.
    const voteDriver = respondToRideConsentAtomic(ride, bookingId, "driver-1", true);
    assert(voteDriver.bookingStatus === "pending_consent" && voteDriver.reason === "AWAITING_OTHERS", "Still awaiting others after driver agrees");

    const voteA = respondToRideConsentAtomic(ride, bookingId, "rider-A", true);
    assert(voteA.bookingStatus === "pending_consent" && voteA.reason === "AWAITING_OTHERS", "Still awaiting rider-B's own vote");

    const voteB = respondToRideConsentAtomic(ride, bookingId, "rider-B", true);
    assert(voteB.bookingStatus === "accepted" && voteB.reason === "ALL_AGREED", "Booking finalizes once everyone has agreed");
    assert(ride.passengers.find((p) => p.id === bookingId)?.status === "accepted", "Booking row reflects accepted status");
  }

  // TEST 3: a single decline cancels the join and restores the seat.
  {
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    const bookingId = second.booking!.id;
    const seatsBeforeDecline = ride.available_seats;

    const decline = respondToRideConsentAtomic(ride, bookingId, "rider-A", false);
    assert(decline.bookingStatus === "cancelled" && decline.reason === "DECLINED", "One decline cancels the pending booking");
    assert(ride.available_seats === seatsBeforeDecline + 1, "Declined booking's seat is restored");
    assert(ride.passengers.find((p) => p.id === bookingId)?.status === "cancelled", "Booking row reflects cancelled status");

    // Someone who already agreed can't flip the outcome after a decline closed it out.
    const lateVote = respondToRideConsentAtomic(ride, bookingId, "driver-1", true);
    assert(lateVote.success === false && lateVote.reason === "NOT_AWAITING_CONSENT", "Voting on an already-decided booking is rejected");
  }

  // TEST 4: a rider not part of the vote can't respond.
  {
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    const bookingId = second.booking!.id;

    const outsider = respondToRideConsentAtomic(ride, bookingId, "stranger-1", true);
    assert(outsider.success === false && outsider.reason === "NOT_A_VOTER_ON_THIS_BOOKING", "A rider not in the pool cannot vote on it");
  }

  // TEST 5: capacity checks still run before consent is even requested.
  {
    const ride = createBaseRide();
    ride.driver_max_co_passengers = 1;
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const check = canAddPassenger(candidate("rider-B"), ride);
    assert(check.canAdd === false && check.reason === "DRIVER_CAP_EXCEEDED", "Driver cap still blocks a 3rd rider before any consent is requested");
  }

  console.log("\n🎉 All Group Consent Tests Passed!\n");
}

runConsentTests().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
