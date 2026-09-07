/* Day 10: Unit tests for consent expiry. Group consent
 * (test_consent.ts) has a gap on its own — a pending_consent booking
 * only ever leaves that state via a vote, so one unresponsive rider
 * can hold a seat hostage forever. These tests exercise the fix:
 * every pending_consent booking gets a deadline, and past it the seat
 * is recovered automatically, whether via a lazy vote-time check or a
 * bulk sweep. */
import {
  bookPooledRideAtomic,
  respondToRideConsentAtomic,
  expireStaleConsentBookings,
  isConsentExpired,
  rideConsents,
  CONSENT_EXPIRY_MINUTES,
} from "./poolingCapacity";
import { RideWithBookings, PassengerCandidate } from "./types";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

async function runConsentExpiryTests() {
  console.log("\n🧪 Running Consent Expiry Test Suite...\n");

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

  async function buildPendingConsentBooking(ride: RideWithBookings) {
    await bookPooledRideAtomic(ride, candidate("rider-A")); // 1:1, auto-accepts
    const second = await bookPooledRideAtomic(ride, candidate("rider-B")); // 3rd rider -> pending_consent
    return second.booking!;
  }

  // TEST 1: a fresh pending_consent booking gets a ~30 minute deadline.
  {
    const ride = createBaseRide();
    const booking = await buildPendingConsentBooking(ride);
    assert(!!booking.expires_at, "pending_consent booking has expires_at set");
    const minutesUntilExpiry = (new Date(booking.expires_at!).getTime() - Date.now()) / 60_000;
    assert(
      minutesUntilExpiry > CONSENT_EXPIRY_MINUTES - 1 && minutesUntilExpiry <= CONSENT_EXPIRY_MINUTES,
      `Deadline is ~${CONSENT_EXPIRY_MINUTES} minutes out, not something arbitrary`
    );
    assert(isConsentExpired(booking) === false, "A brand-new booking is not yet expired");
  }

  // TEST 2: once the deadline passes, a vote is rejected with
  // CONSENT_EXPIRED instead of being recorded — and the seat comes back.
  {
    const ride = createBaseRide();
    const booking = await buildPendingConsentBooking(ride);
    const seatsWhilePending = ride.available_seats;
    assert(seatsWhilePending === 2, "Seat reserved while consent is pending (4 - 1 - 1)");

    const future = new Date(Date.now() + (CONSENT_EXPIRY_MINUTES + 1) * 60_000);
    assert(isConsentExpired(booking, future) === true, "Booking is expired once its deadline has passed");

    const lateVote = respondToRideConsentAtomic(ride, booking.id, "driver-1", true, future);
    assert(
      lateVote.success === false && lateVote.reason === "CONSENT_EXPIRED",
      "A vote arriving after the deadline is rejected as CONSENT_EXPIRED, not recorded"
    );
    assert(booking.status === "cancelled", "Expired booking is flipped to cancelled");
    assert(ride.available_seats === seatsWhilePending + 1, "Expiry restores the reserved seat");

    const votes = rideConsents.get(booking.id) ?? [];
    assert(
      votes.every((v) => v.status === "expired"),
      "Every still-awaiting vote is marked 'expired', not silently dropped or marked 'declined'"
    );
  }

  // TEST 3: a vote that arrives BEFORE the deadline still works exactly
  // as before — expiry must not affect the normal happy path.
  {
    const ride = createBaseRide();
    const booking = await buildPendingConsentBooking(ride);
    const soon = new Date(Date.now() + 5 * 60_000); // well inside the 30 min window

    const vote = respondToRideConsentAtomic(ride, booking.id, "driver-1", true, soon);
    assert(
      vote.success === true && vote.bookingStatus === "pending_consent" && vote.reason === "AWAITING_OTHERS",
      "A timely vote is recorded normally and does not trigger expiry logic"
    );
  }

  // TEST 4: expireStaleConsentBookings() bulk-sweeps every stale
  // booking on a ride in one pass, leaving fresh ones untouched.
  {
    const ride = createBaseRide();
    const staleBooking = await buildPendingConsentBooking(ride);

    // A second, independent 3rd-rider join on a *different* ride,
    // still fresh — must not be swept just because another ride's
    // booking expired.
    const freshRide = createBaseRide();
    const freshBooking = await buildPendingConsentBooking(freshRide);

    const future = new Date(Date.now() + (CONSENT_EXPIRY_MINUTES + 1) * 60_000);
    const { expired } = expireStaleConsentBookings(ride, future);

    assert(expired.length === 1 && expired[0].id === staleBooking.id, "Sweep expires exactly the one stale booking on this ride");
    assert(staleBooking.status === "cancelled", "Swept booking is cancelled");
    assert(freshBooking.status === "pending_consent", "A booking on a different ride is untouched by this ride's sweep");

    // Sweeping again is a no-op — nothing left to expire on this ride.
    const { expired: secondPass } = expireStaleConsentBookings(ride, future);
    assert(secondPass.length === 0, "Re-sweeping an already-expired ride finds nothing left to do (idempotent)");
  }

  // TEST 5: expiring one stale booking must not disturb another
  // still-pending booking on the SAME ride.
  {
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A")); // 1:1, accepted
    const staleJoin = await bookPooledRideAtomic(ride, candidate("rider-B")); // pending_consent, will go stale
    // rider-B's booking already exists; simulate a second, independent
    // pending_consent booking on the same ride by directly seeding one
    // with a fresh deadline so we can assert it survives the sweep.
    const freshJoin = await bookPooledRideAtomic(ride, candidate("rider-C"));

    const staleBookingRow = ride.passengers.find((p) => p.id === staleJoin.booking!.id)!;
    const freshBookingRow = ride.passengers.find((p) => p.id === freshJoin.booking!.id)!;
    // Force only the first join's deadline into the past.
    staleBookingRow.expires_at = new Date(Date.now() - 60_000).toISOString();

    const { expired } = expireStaleConsentBookings(ride);
    assert(expired.length === 1 && expired[0].id === staleBookingRow.id, "Only the actually-expired booking is swept");
    assert(freshBookingRow.status === "pending_consent", "A sibling booking on the same ride, still within its window, is left alone");
  }

  console.log("\n🎉 All Consent Expiry Tests Passed!\n");
}

runConsentExpiryTests().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
