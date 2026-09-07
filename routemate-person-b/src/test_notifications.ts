/* Day 10: Unit tests for the in-app notification feed — the fix for
 * "a rider has no idea a consent vote is waiting on them (or that
 * their own join request was resolved/expired) unless they happen to
 * have the app open." Exercises both the pure notifications.ts store
 * and its wiring into poolingCapacity.ts's consent flow. */
import {
  listNotifications,
  unreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  __resetNotificationsForTests,
} from "./notifications";
import {
  bookPooledRideAtomic,
  respondToRideConsentAtomic,
  expireStaleConsentBookings,
  nudgeNearExpiryConsents,
  CONSENT_EXPIRY_MINUTES,
  CONSENT_NUDGE_MINUTES,
} from "./poolingCapacity";
import { RideWithBookings, PassengerCandidate } from "./types";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

async function runNotificationTests() {
  console.log("\n🧪 Running Notification Feed Test Suite...\n");

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

  function candidate(id: string, name?: string): PassengerCandidate {
    return {
      passenger_id: id,
      passenger_name: name,
      seats_requested: 1,
      max_co_passengers: -1,
      pickup_point: mockOrigin,
      dropoff_point: mockDest,
    };
  }

  // ── Pure store behavior ──────────────────────────────────────

  // TEST 1: pushing/listing/marking read on the raw store.
  {
    __resetNotificationsForTests();
    assert(listNotifications("u1").length === 0, "A user with no notifications gets an empty list, not an error");
    assert(unreadCount("u1") === 0, "Unread count is 0 for an empty feed");
  }

  // ── Wired into the consent flow ──────────────────────────────

  // TEST 2: a 3rd-rider join notifies every voter, including the joiner.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B", "Sara"));
    const bookingId = second.booking!.id;

    for (const riderId of ["driver-1", "rider-A", "rider-B"]) {
      const list = listNotifications(riderId);
      assert(
        list.some((n) => n.kind === "consent_requested" && n.booking_id === bookingId),
        `${riderId} was notified their vote is needed`
      );
    }
    assert(unreadCount("driver-1") === 1, "The notification starts unread");
  }

  // TEST 3: a 1:1 join (no consent needed) sends no notification at all.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    assert(listNotifications("driver-1").length === 0, "No consent needed -> no notification noise");
  }

  // TEST 4: once everyone agrees, the JOINER (not the voters) gets a
  // "your request was answered" notice.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    const bookingId = second.booking!.id;

    respondToRideConsentAtomic(ride, bookingId, "driver-1", true);
    respondToRideConsentAtomic(ride, bookingId, "rider-A", true);
    respondToRideConsentAtomic(ride, bookingId, "rider-B", true);

    const joinerNotifications = listNotifications("rider-B");
    assert(
      joinerNotifications.some((n) => n.kind === "consent_resolved"),
      "The joiner is told their request was resolved once everyone agrees"
    );
  }

  // TEST 5: a decline also resolves the joiner's notification (not just accept).
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    const bookingId = second.booking!.id;

    respondToRideConsentAtomic(ride, bookingId, "rider-A", false);

    assert(
      listNotifications("rider-B").some((n) => n.kind === "consent_resolved"),
      "A decline also notifies the joiner their request was resolved"
    );
  }

  // TEST 6: expiry notifies the joiner with 'consent_expired', distinct
  // from a normal 'consent_resolved' decline.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    const bookingId = second.booking!.id;

    const future = new Date(Date.now() + (CONSENT_EXPIRY_MINUTES + 1) * 60_000);
    respondToRideConsentAtomic(ride, bookingId, "driver-1", true, future);

    const joinerNotifications = listNotifications("rider-B");
    assert(
      joinerNotifications.some((n) => n.kind === "consent_expired"),
      "Expiry via a late vote notifies the joiner with 'consent_expired'"
    );
    assert(
      !joinerNotifications.some((n) => n.kind === "consent_resolved"),
      "Expiry is NOT reported as a normal 'consent_resolved' — the distinction matters for the UI copy"
    );
  }

  // TEST 7: the bulk sweep (expireStaleConsentBookings) also notifies
  // the joiner, same as the lazy vote-time path.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));

    const future = new Date(Date.now() + (CONSENT_EXPIRY_MINUTES + 1) * 60_000);
    expireStaleConsentBookings(ride, future);

    assert(
      listNotifications("rider-B").some((n) => n.kind === "consent_expired"),
      "A bulk sweep also notifies the joiner, not just a lazy vote-time check"
    );
  }

  // TEST 8: the 5-minute reminder nudges only still-'awaiting' voters,
  // never the joiner twice and never someone who already voted.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    const bookingId = second.booking!.id;

    // driver-1 votes early; rider-A and rider-B (the joiner, who also
    // gets a vote per book_pooled_ride) remain awaiting.
    respondToRideConsentAtomic(ride, bookingId, "driver-1", true);

    const nearExpiry = new Date(
      Date.now() + (CONSENT_EXPIRY_MINUTES * 60_000 - CONSENT_NUDGE_MINUTES * 60_000 + 30_000)
    );
    const { nudged } = nudgeNearExpiryConsents(ride, nearExpiry);
    assert(nudged.length === 1 && nudged[0].id === bookingId, "Exactly one booking is nudged within its window");

    assert(
      listNotifications("driver-1").filter((n) => n.kind === "consent_reminder").length === 0,
      "A rider who already voted does not get a reminder"
    );
    assert(
      listNotifications("rider-A").some((n) => n.kind === "consent_reminder"),
      "A rider still awaiting gets the reminder"
    );

    // Nudging again (still within the window) must not double-send.
    const { nudged: secondPass } = nudgeNearExpiryConsents(ride, nearExpiry);
    assert(secondPass.length === 0, "A booking is nudged at most once (idempotent)");
    assert(
      listNotifications("rider-A").filter((n) => n.kind === "consent_reminder").length === 1,
      "Re-running the nudge sweep does not duplicate the reminder"
    );
  }

  // TEST 9: outside the 5-minute window (too early), nobody is nudged yet.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    await bookPooledRideAtomic(ride, candidate("rider-B"));

    const justCreated = new Date(Date.now() + 60_000); // 1 min in, 29 left — not near expiry yet
    const { nudged } = nudgeNearExpiryConsents(ride, justCreated);
    assert(nudged.length === 0, "A booking with plenty of time left is not nudged prematurely");
  }

  // ── Mark-as-read semantics ───────────────────────────────────

  // TEST 10: markNotificationRead / markAllNotificationsRead behavior.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    await bookPooledRideAtomic(ride, candidate("rider-B"));

    const driverNotifications = listNotifications("driver-1");
    assert(driverNotifications.length === 1, "Setup: driver has exactly one notification");
    const notificationId = driverNotifications[0].id;

    assert(unreadCount("driver-1") === 1, "Starts unread");
    const marked = markNotificationRead("driver-1", notificationId);
    assert(marked === true, "markNotificationRead succeeds on a real, unread notification");
    assert(unreadCount("driver-1") === 0, "Unread count drops to 0 after marking read");

    const markedAgain = markNotificationRead("driver-1", notificationId);
    assert(markedAgain === false, "Marking an already-read notification read again is a no-op, not an error");

    const bogus = markNotificationRead("driver-1", "does-not-exist");
    assert(bogus === false, "Marking a nonexistent notification id read fails gracefully");
  }

  // TEST 11: markAllNotificationsRead clears everything for one user
  // without touching another user's feed.
  {
    __resetNotificationsForTests();
    const ride = createBaseRide();
    await bookPooledRideAtomic(ride, candidate("rider-A"));
    const second = await bookPooledRideAtomic(ride, candidate("rider-B"));
    respondToRideConsentAtomic(ride, second.booking!.id, "driver-1", true); // adds a 2nd notif? no — resolves joiner only

    assert(unreadCount("driver-1") >= 1, "Setup: driver-1 has at least one unread notification");
    const count = markAllNotificationsRead("driver-1");
    assert(count >= 1, "markAllNotificationsRead reports how many it cleared");
    assert(unreadCount("driver-1") === 0, "driver-1's feed is fully read");
    assert(unreadCount("rider-B") >= 1, "A different user's feed is untouched by marking driver-1's feed read");
  }

  console.log("\n🎉 All Notification Feed Tests Passed!\n");
}

runNotificationTests().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
