/* Changed: Flexible Ride-Pooling Capacity matching module implementing "most restrictive passenger wins", seat reservation, and atomic row-locking concurrency simulation. */
import {
  RideWithBookings,
  PassengerCandidate,
  CapacityCheckResult,
  RideBooking,
  RideConsent,
  Gender,
  GenderPreference,
} from "./types";
import { pushNotification, notificationText } from "./notifications";

/**
 * Day 7 group-safety rule. A mixed-gender ride with only 2 total riders
 * (driver + one passenger, i.e. a 1:1 pairing) is allowed ONLY when both
 * riders explicitly opted into sharing with anyone (preference 'any').
 * Same-gender pairings and pools of 3+ riders are unaffected.
 *
 * Interpreted strictly per the spec's normative sentence: "Mixed-gender
 * pairing under 3 total riders requires BOTH sides to have
 * gender_preference: 'any'." This is deliberately the safer reading.
 */
export function isGroupSafePairing(
  aGender: Gender,
  aPreference: GenderPreference,
  bGender: Gender,
  bPreference: GenderPreference
): boolean {
  if (aGender === bGender) return true;
  return aPreference === "any" && bPreference === "any";
}

/**
 * Day 9 group-consent rule, now DUAL (RouteSync Phase 2) and counted in
 * PEOPLE (party-size migration). A join that keeps the ride at 2 total
 * people (driver + this one solo passenger) auto-accepts exactly like
 * before — and that first passenger becomes the primary rider / second
 * approver. Once a join would bring the ride to 3+ TOTAL PEOPLE (a
 * party of 2 joining a driver-only car makes 3 people, so it lands here
 * too), the request is approved by EXACTLY TWO people — the driver and
 * the primary rider — not every existing passenger. Other riders are
 * notified read-only. Mirrors the v_total_riders check in
 * book_pooled_ride() (see
 * supabase/migrations/20261023000000_party_size.sql).
 *
 * joinerPartySize defaults to 1 so pre-party callers keep the old
 * "what if one more solo rider joined" semantics.
 */
export function needsGroupConsent(ride: RideWithBookings, joinerPartySize = 1): boolean {
  const activePassengers = ride.passengers.filter(
    (b) => b.status === "accepted" || b.status === "pending" || b.status === "pending_consent"
  );
  const activePeople = activePassengers.reduce((n, b) => n + (b.seats_requested ?? 1), 0);
  const totalPeopleAfterJoin = activePeople + joinerPartySize + 1; // +driver/host
  return totalPeopleAfterJoin >= 3;
}

/**
 * The two dual-consent approvers for a ride: the driver (host_driver)
 * and the primary rider (host_rider), de-duplicated — a solo driver who
 * is also the designated primary yields a single approver. If no primary
 * rider has been designated yet (legacy ride with no 1:1 auto-accept),
 * only the driver approves. Mirrors the driver_id UNION primary_rider_id
 * SELECT DISTINCT in book_pooled_ride() (Phase 2 migration).
 */
export function getConsentApprovers(ride: RideWithBookings): string[] {
  const ids = new Set<string>([ride.driver_id]);
  if (ride.primary_rider_id) ids.add(ride.primary_rider_id);
  return Array.from(ids);
}

/**
 * Calculates the effective maximum co-passengers allowed on a ride.
 * It is the MINIMUM of:
 *  - driver_max_co_passengers
 *  - every active passenger's max_co_passengers (ignoring -1 / unlimited)
 */
export function getEffectiveRideCapacity(ride: RideWithBookings): number {
  let minCap = ride.driver_max_co_passengers;

  for (const p of ride.passengers) {
    if (p.status !== "cancelled" && p.status !== "completed" && p.max_co_passengers !== -1 && p.max_co_passengers !== null) {
      if (p.max_co_passengers < minCap) {
        minCap = p.max_co_passengers;
      }
    }
  }

  return minCap;
}

/**
 * Core Matching Function: canAddPassenger
 * Evaluates whether a candidate passenger P (a whole PARTY — one
 * booking of P.seats_requested people) can join an existing ride without
 * violating driver constraints, physical seats, P's own limit, or any
 * existing rider's co-passenger limit ("most restrictive passenger
 * wins"). Every count is in PEOPLE, not bookings, per
 * supabase/migrations/20261023000000_party_size.sql.
 */
export function canAddPassenger(
  P: PassengerCandidate,
  ride: RideWithBookings
): CapacityCheckResult {
  if (ride.status !== "active") {
    return { canAdd: false, proposedCoPassengerCount: 0, reason: "RIDE_NOT_ACTIVE" };
  }

  // Active passengers currently in the ride
  const activePassengers = ride.passengers.filter(
    (b) => b.status === "accepted" || b.status === "pending" || b.status === "pending_consent"
  );

  // People (not bookings) in the ride after P's party joins, minus the
  // driver: pending / pending_consent parties hold RESERVED seats and
  // count toward occupancy.
  const activePeople = activePassengers.reduce((n, b) => n + (b.seats_requested ?? 1), 0);

  // Total non-driver people in the car after P's party joins
  const proposedTotalPassengers = activePeople + P.seats_requested;

  // Number of OTHER people each rider will share with after P joins
  const proposedCoPassengersCount = activePeople;

  // 0. Day 7 group-safety rule (cheapest safety check first, mirroring the
  //    matchPipeline ordering): a 1:1 mixed-gender ride requires BOTH riders
  //    to have opted into 'any'. Only applies when the resulting ride is
  //    exactly driver + P (2 people total) and both carry gender metadata —
  //    callers without metadata (older flows) behave exactly as before.
  const proposedTotalRiders = proposedTotalPassengers + 1; // +driver/host
  if (
    proposedTotalRiders === 2 &&
    ride.driver_gender &&
    ride.driver_preference &&
    P.passenger_gender &&
    P.passenger_preference &&
    !isGroupSafePairing(ride.driver_gender, ride.driver_preference, P.passenger_gender, P.passenger_preference)
  ) {
    return {
      canAdd: false,
      proposedCoPassengerCount: proposedCoPassengersCount,
      reason: "GROUP_SAFETY_MIXED_PAIR",
      effectiveRideCap: getEffectiveRideCapacity(ride),
    };
  }

  // 1. Driver's own limit check (max passengers driver accepts)
  if (
    ride.driver_max_co_passengers !== -1 &&
    ride.driver_max_co_passengers !== null &&
    proposedTotalPassengers > ride.driver_max_co_passengers
  ) {
    return {
      canAdd: false,
      proposedCoPassengerCount: proposedCoPassengersCount,
      reason: "DRIVER_CAP_EXCEEDED",
      effectiveRideCap: getEffectiveRideCapacity(ride),
    };
  }

  // 2. Candidate P's own limit check (max OTHER passengers P accepts)
  if (
    P.max_co_passengers !== -1 &&
    P.max_co_passengers !== null &&
    proposedCoPassengersCount > P.max_co_passengers
  ) {
    return {
      canAdd: false,
      proposedCoPassengerCount: proposedCoPassengersCount,
      reason: "PASSENGER_CAP_EXCEEDED",
      effectiveRideCap: getEffectiveRideCapacity(ride),
    };
  }

  // 3. Existing passengers' limits check ("most restrictive passenger wins")
  for (const E of activePassengers) {
    if (
      E.max_co_passengers !== -1 &&
      E.max_co_passengers !== null &&
      proposedCoPassengersCount > E.max_co_passengers
    ) {
      return {
        canAdd: false,
        proposedCoPassengerCount: proposedCoPassengersCount,
        reason: "EXISTING_PASSENGER_CAP_VIOLATED",
        effectiveRideCap: getEffectiveRideCapacity(ride),
      };
    }
  }

  // 4. Physical available seats check. A solo rider who can't fit keeps
  //    the original INSUFFICIENT_SEATS code; a PARTY that doesn't fit
  //    gets PARTY_TOO_LARGE_FOR_REMAINING_SEATS plus the free seat count
  //    so the UI can explain why (mirrors book_pooled_ride()).
  if (ride.available_seats < P.seats_requested) {
    return {
      canAdd: false,
      proposedCoPassengerCount: proposedCoPassengersCount,
      reason: P.seats_requested > 1 ? "PARTY_TOO_LARGE_FOR_REMAINING_SEATS" : "INSUFFICIENT_SEATS",
      effectiveRideCap: getEffectiveRideCapacity(ride),
      remainingSeats: Math.max(ride.available_seats, 0),
    };
  }

  return {
    canAdd: true,
    proposedCoPassengerCount: proposedCoPassengersCount,
    effectiveRideCap: getEffectiveRideCapacity(ride),
  };
}


/**
 * Simulated Atomic Booking with Row-Level Mutex Locking.
 * Prevents concurrent booking requests from overbooking available seats
 * or violating capacity rules in high-concurrency scenarios.
 *
 * Day 9 (now DUAL, RouteSync Phase 2) + PARTY SIZE: if this join keeps
 * the ride at 2 total people, it books straight to "accepted" exactly
 * as before, and that first passenger is designated the ride's primary
 * rider (the second approver). If it would bring the ride to 3+ TOTAL
 * PEOPLE (a party of 2 joining a driver-only car makes 3 people, so it
 * lands here too), the seats are still reserved immediately (so nobody
 * else races for them) but the booking is created as
 * "pending_consent", and a RideConsent row is created for the TWO
 * approvers only — the driver and the primary rider (de-duplicated).
 * The booking becomes "accepted" once both of those rows are "agreed"
 * — see respondToRideConsentAtomic. Every OTHER already-accepted rider
 * gets a read-only notification, not a vote. This mirrors
 * book_pooled_ride() in
 * supabase/migrations/20261023000000_party_size.sql, so the in-memory
 * simulation used here for tests behaves the same as the real
 * DB-backed RPC apiHandler.ts calls in production.
 */
/** How long a rider has to vote before a pending_consent booking is
 *  treated as stale and auto-cancelled, restoring the reserved seat.
 *  Without this, a single unresponsive rider can hold a seat hostage
 *  forever — the booking would sit in pending_consent indefinitely
 *  since nothing else ever transitions it out of that state. Mirrors
 *  the same constant in
 *  supabase/migrations/20260905000000_consent_expiry.sql. */
export const CONSENT_EXPIRY_MINUTES = 30;

const rideLocks = new Map<string, Promise<void>>();
export const rideConsents = new Map<string, RideConsent[]>(); // keyed by booking_id

/** True once a pending_consent booking's voting window has passed.
 *  A booking with no expires_at (shouldn't happen post-migration, but
 *  guards older rows) is never considered expired. */
export function isConsentExpired(booking: RideBooking, now: Date = new Date()): boolean {
  if (booking.status !== "pending_consent" || !booking.expires_at) return false;
  return new Date(booking.expires_at).getTime() < now.getTime();
}

/** Cancels one stale pending_consent booking: restores its seat,
 *  marks any still-"awaiting" votes as "expired" (not "declined" —
 *  nobody said no, the clock just ran out), and flips the booking to
 *  "cancelled". Idempotent: calling it on an already-resolved booking
 *  is a no-op. */
function expireBooking(ride: RideWithBookings, booking: RideBooking, now: Date): void {
  if (booking.status !== "pending_consent") return;
  booking.status = "cancelled";
  ride.available_seats += booking.seats_requested;
  if (ride.status === "full" && ride.available_seats > 0) ride.status = "active";

  const consents = rideConsents.get(booking.id) ?? [];
  for (const c of consents) {
    if (c.status === "awaiting") {
      c.status = "expired";
      c.responded_at = now.toISOString();
    }
  }

  const { title, body } = notificationText("consent_expired", {
    joinerName: booking.passenger_name ?? "A rider",
  });
  pushNotification(
    { user_id: booking.passenger_id, kind: "consent_expired", title, body, ride_id: ride.id, booking_id: booking.id },
    now
  );
}

/** Sweeps every pending_consent booking within CONSENT_NUDGE_MINUTES
 *  of expiring and, for anyone still "awaiting" on it, sends one
 *  "5 minutes left" reminder — never more than once per booking, so
 *  reconnecting/re-polling can't spam the same rider. Mirrors
 *  notify_near_expiry_consents() in
 *  supabase/migrations/20260906000000_notifications.sql. */
export const CONSENT_NUDGE_MINUTES = 5;

export function nudgeNearExpiryConsents(
  ride: RideWithBookings,
  now: Date = new Date()
): { nudged: RideBooking[] } {
  const nudged: RideBooking[] = [];
  for (const booking of ride.passengers) {
    if (booking.status !== "pending_consent" || !booking.expires_at || booking.nudged_at) continue;
    const msLeft = new Date(booking.expires_at).getTime() - now.getTime();
    if (msLeft <= 0 || msLeft > CONSENT_NUDGE_MINUTES * 60_000) continue;

    const awaitingVoters = (rideConsents.get(booking.id) ?? []).filter((c) => c.status === "awaiting");
    const { title, body } = notificationText("consent_reminder", {
      joinerName: booking.passenger_name ?? "A rider",
    });
    for (const voter of awaitingVoters) {
      pushNotification(
        { user_id: voter.rider_id, kind: "consent_reminder", title, body, ride_id: ride.id, booking_id: booking.id },
        now
      );
    }
    booking.nudged_at = now.toISOString();
    nudged.push(booking);
  }
  return { nudged };
}

/** Sweeps every pending_consent booking on this ride and expires any
 *  whose voting window has passed. Call this opportunistically before
 *  reading or acting on pending consents (mirrors calling
 *  expire_stale_consent_bookings() before reading ride_consents in
 *  apiHandler.ts) — there's no background scheduler in the in-memory
 *  test simulation, so expiry only ever happens lazily, on read. */
export function expireStaleConsentBookings(
  ride: RideWithBookings,
  now: Date = new Date()
): { expired: RideBooking[] } {
  const expired: RideBooking[] = [];
  for (const booking of ride.passengers) {
    if (isConsentExpired(booking, now)) {
      expireBooking(ride, booking, now);
      expired.push(booking);
    }
  }
  return { expired };
}

export async function bookPooledRideAtomic(
  ride: RideWithBookings,
  P: PassengerCandidate
): Promise<{ success: boolean; booking?: RideBooking; reason?: string; consents?: RideConsent[] }> {
  // Simple in-memory mutex simulating PostgreSQL SELECT ... FOR UPDATE row lock
  while (rideLocks.has(ride.id)) {
    await rideLocks.get(ride.id);
  }

  let releaseLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  rideLocks.set(ride.id, lockPromise);

  try {
    const check = canAddPassenger(P, ride);
    if (!check.canAdd) {
      return { success: false, reason: check.reason };
    }

    const requiresConsent = needsGroupConsent(ride, P.seats_requested);

    const newBooking: RideBooking = {
      id: `booking-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      ride_id: ride.id,
      passenger_id: P.passenger_id,
      passenger_name: P.passenger_name,
      pickup_point: P.pickup_point,
      dropoff_point: P.dropoff_point,
      seats_requested: P.seats_requested,
      party_member_names: P.party_member_names ?? [],
      max_co_passengers: P.max_co_passengers,
      status: requiresConsent ? "pending_consent" : "accepted",
      role: requiresConsent ? "passenger_joiner" : "host_rider",
      expires_at: requiresConsent
        ? new Date(Date.now() + CONSENT_EXPIRY_MINUTES * 60_000).toISOString()
        : null,
    };

    // Mutate state atomically under lock. Seat is reserved either way,
    // so a decline later must restore it (see respondToRideConsentAtomic).
    ride.passengers.push(newBooking);
    ride.available_seats -= P.seats_requested;
    if (ride.available_seats <= 0 && newBooking.status === "accepted") {
      ride.status = "full";
    }

    // The first passenger to auto-accept becomes the ride's primary
    // rider — the second dual-consent approver for every later join.
    if (!requiresConsent && !ride.primary_rider_id) {
      ride.primary_rider_id = P.passenger_id;
    }

    let consents: RideConsent[] | undefined;
    if (requiresConsent) {
      // DUAL CONSENT: exactly two approvers — driver + primary rider,
      // de-duplicated. The joiner does not vote (already consented by
      // requesting); other riders are read-only.
      const approverIds = getConsentApprovers(ride);

      consents = approverIds.map((riderId) => ({
        id: `consent-${newBooking.id}-${riderId}`,
        ride_id: ride.id,
        booking_id: newBooking.id,
        rider_id: riderId,
        status: "awaiting" as const,
        requested_at: new Date().toISOString(),
      }));
      rideConsents.set(newBooking.id, consents);

      // Each approver is told a vote is waiting on them.
      const { title, body } = notificationText("consent_requested", {
        joinerName: P.passenger_name ?? "A rider",
      });
      for (const riderId of approverIds) {
        pushNotification({
          user_id: riderId,
          kind: "consent_requested",
          title,
          body,
          ride_id: ride.id,
          booking_id: newBooking.id,
        });
      }

      // The joiner sees their own request reflected as pending in their
      // feed too (they are not a voter).
      pushNotification({
        user_id: P.passenger_id,
        kind: "consent_requested",
        title: "Request sent",
        body: "Your request to join was sent and is awaiting host approval.",
        ride_id: ride.id,
        booking_id: newBooking.id,
      });

      // Everyone ELSE already in the pool (not a host, not the joiner)
      // gets a read-only heads-up — their ride is changing, but no vote.
      notifyOtherRiders(
        ride,
        newBooking,
        new Set(approverIds),
        `${P.passenger_name ?? "A rider"} asked to join your ride. The hosts are reviewing it.`
      );
    }

    return { success: true, booking: newBooking, consents };
  } finally {
    rideLocks.delete(ride.id);
    releaseLock();
  }
}

/**
 * Records one rider's vote on a pending_consent booking. Mirrors
 * respond_to_ride_consent() in
 * supabase/migrations/20260904000000_group_consent_carbon.sql:
 *  - any single decline cancels the booking and restores the seat
 *  - once every vote is "agreed", the booking flips to "accepted"
 */
export function respondToRideConsentAtomic(
  ride: RideWithBookings,
  bookingId: string,
  riderId: string,
  agree: boolean,
  now: Date = new Date()
): { success: boolean; bookingStatus?: RideBooking["status"]; reason: string } {
  const booking = ride.passengers.find((b) => b.id === bookingId);
  if (!booking) return { success: false, reason: "BOOKING_NOT_FOUND" };

  // Lazily expire this booking first if its window has passed — a
  // vote arriving after the deadline must not be able to resurrect a
  // booking whose seat may have already been implicitly forfeited.
  if (isConsentExpired(booking, now)) {
    expireBooking(ride, booking, now);
    return { success: false, bookingStatus: "cancelled", reason: "CONSENT_EXPIRED" };
  }

  if (booking.status !== "pending_consent") {
    return { success: false, bookingStatus: booking.status, reason: "NOT_AWAITING_CONSENT" };
  }

  const consents = rideConsents.get(bookingId) ?? [];
  const vote = consents.find((c) => c.rider_id === riderId);
  if (!vote) return { success: false, bookingStatus: booking.status, reason: "NOT_A_VOTER_ON_THIS_BOOKING" };
  if (vote.status !== "awaiting") {
    return { success: false, bookingStatus: booking.status, reason: "ALREADY_RESPONDED" };
  }

  vote.status = agree ? "agreed" : "declined";
  vote.responded_at = new Date().toISOString();

  if (!agree) {
    booking.status = "cancelled";
    ride.available_seats += booking.seats_requested;
    consents.filter((c) => c.status === "awaiting").forEach((c) => {
      c.status = "declined";
      c.responded_at = new Date().toISOString();
    });
    notifyJoinerResolved(ride, booking, now);
    notifyOtherRiders(
      ride,
      booking,
      new Set(consents.map((c) => c.rider_id)),
      `${booking.passenger_name ?? "A rider"}'s request to join was declined.`
    );
    return { success: true, bookingStatus: "cancelled", reason: "DECLINED" };
  }

  const anyDeclined = consents.some((c) => c.status === "declined");
  if (anyDeclined) {
    notifyJoinerResolved(ride, booking, now);
    notifyOtherRiders(
      ride,
      booking,
      new Set(consents.map((c) => c.rider_id)),
      `${booking.passenger_name ?? "A rider"}'s request to join was declined.`
    );
    return { success: true, bookingStatus: "cancelled", reason: "DECLINED" };
  }

  const allAgreed = consents.every((c) => c.status === "agreed");
  if (allAgreed) {
    booking.status = "accepted";
    if (ride.available_seats <= 0) ride.status = "full";
    notifyJoinerResolved(ride, booking, now);
    notifyOtherRiders(
      ride,
      booking,
      new Set(consents.map((c) => c.rider_id)),
      `${booking.passenger_name ?? "A rider"} has joined your ride.`
    );
    return { success: true, bookingStatus: "accepted", reason: "ALL_AGREED" };
  }

  return { success: true, bookingStatus: "pending_consent", reason: "AWAITING_OTHERS" };
}

/** Lets the joining rider know the group finished voting — either way
 *  — instead of leaving them to keep polling their own request. */
function notifyJoinerResolved(ride: RideWithBookings, booking: RideBooking, now: Date): void {
  const { title, body } = notificationText("consent_resolved", {
    joinerName: booking.passenger_name ?? "A rider",
  });
  pushNotification(
    { user_id: booking.passenger_id, kind: "consent_resolved", title, body, ride_id: ride.id, booking_id: booking.id },
    now
  );
}

/** Read-only 'ride_update' ping to every already-accepted rider who is
 *  NOT a dual-consent approver and NOT the joiner — their ride is
 *  changing but they don't vote. Mirrors the ride_update INSERT blocks
 *  in book_pooled_ride() / respond_to_ride_consent() (Phase 2). */
function notifyOtherRiders(
  ride: RideWithBookings,
  booking: RideBooking,
  approverIds: Set<string>,
  body: string
): void {
  const others = ride.passengers
    .filter((b) => b.status === "accepted" && b.id !== booking.id)
    .map((b) => b.passenger_id)
    .filter((pid) => !approverIds.has(pid) && pid !== booking.passenger_id);
  for (const rid of others) {
    pushNotification(
      { user_id: rid, kind: "ride_update", title: "Ride update", body, ride_id: ride.id, booking_id: booking.id },
      new Date()
    );
  }
}
