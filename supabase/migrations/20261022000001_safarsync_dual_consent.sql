-- ─────────────────────────────────────────────────────────────
-- Migration: SafarSync DUAL CONSENT (PHASE 2). Idempotent.
--
-- CHANGE from the 20260904 / 20260905 / 20260906 unanimous model:
-- a 3rd/4th/5th rider's join is now approved by EXACTLY TWO people —
-- the ride's driver (host_driver) and its primary rider (host_rider) —
-- not by every existing passenger. Other riders already in the pool get
-- a read-only 'ride_update' notice, no vote.
--
--   * The FIRST passenger to join (the 1:1 auto-accept) is designated
--     the primary rider: their booking role = 'host_rider' and
--     rides.primary_rider_id is set (if not already). This is the second
--     approver for every later join.
--   * rides.driver_id AND rides.primary_rider_id are de-duplicated, so a
--     solo driver who is also the primary rider yields ONE consent row.
--   * If primary_rider_id is still null (a legacy ride with no
--     designated primary), only the driver approves.
--
-- The 1:1 fast path is otherwise unchanged (auto-accept, no consent).
-- Seat reservation already honoured p_seats_requested (Phase 1 added the
-- 1..4 range CHECK); that behaviour is preserved.
--
-- respond_to_ride_consent(): unchanged terminal rules — any decline
-- cancels + restores seats + closes remaining votes; when the (now two)
-- approvals are all in, the booking flips to 'accepted'. Group chat for
-- the accepted joiner unlocks automatically via the ride_messages RLS
-- policy added in Phase 1 (an accepted participant can read/write the
-- ride channel), so no explicit "create chat" step lives in this RPC.
-- ─────────────────────────────────────────────────────────────

-- 'ride_update' joins the notification vocabulary for read-only pings to
-- non-approver riders.
alter table public.notifications
  drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'consent_requested', 'consent_reminder', 'consent_resolved', 'consent_expired',
    'ride_update'
  ));

-- ─────────────────────────────────────────────────────────────
-- book_pooled_ride(): dual-consent version.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION book_pooled_ride(
  p_ride_id UUID,
  p_passenger_id UUID,
  p_pickup_lat NUMERIC,
  p_pickup_lng NUMERIC,
  p_pickup_label TEXT,
  p_dropoff_lat NUMERIC,
  p_dropoff_lng NUMERIC,
  p_dropoff_label TEXT,
  p_seats_requested INT,
  p_max_co_passengers INT
)
RETURNS TABLE (
  booking_id UUID,
  success BOOLEAN,
  reason TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ride RECORD;
  v_existing_booking RECORD;
  v_proposed_count INT;
  v_total_riders INT;
  v_new_booking_id UUID;
  v_status TEXT;
  v_reason TEXT;
  v_role TEXT;
  v_expires_at TIMESTAMPTZ;
  v_joiner_name TEXT;
  v_voter RECORD;
BEGIN
  SELECT * INTO v_ride
  FROM rides
  WHERE id = p_ride_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'RIDE_NOT_FOUND';
    RETURN;
  END IF;

  IF v_ride.status != 'active' THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'RIDE_NOT_ACTIVE';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_proposed_count
  FROM ride_bookings
  WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending', 'pending_consent');

  v_proposed_count := v_proposed_count + 1;
  v_total_riders := v_proposed_count + 1; -- + driver

  -- 1. Driver Cap
  IF v_ride.driver_max_co_passengers IS NOT NULL AND v_proposed_count > v_ride.driver_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'DRIVER_CAP_EXCEEDED';
    RETURN;
  END IF;

  -- 2. Candidate Passenger Cap
  IF p_max_co_passengers IS NOT NULL AND p_max_co_passengers != -1 AND v_proposed_count > p_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'PASSENGER_CAP_EXCEEDED';
    RETURN;
  END IF;

  -- 3. Existing Passengers' Caps ("most restrictive passenger wins")
  FOR v_existing_booking IN
    SELECT max_co_passengers
    FROM ride_bookings
    WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending', 'pending_consent')
  LOOP
    IF v_existing_booking.max_co_passengers IS NOT NULL
       AND v_existing_booking.max_co_passengers != -1
       AND v_proposed_count > v_existing_booking.max_co_passengers THEN
      RETURN QUERY SELECT NULL::UUID, FALSE, 'EXISTING_PASSENGER_CAP_VIOLATED';
      RETURN;
    END IF;
  END LOOP;

  -- 4. Seat Availability
  IF v_ride.available_seats < p_seats_requested THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'INSUFFICIENT_SEATS';
    RETURN;
  END IF;

  -- 2 total riders (driver + this passenger, pool was empty) auto-accepts
  -- AND this passenger is designated the primary rider / second approver.
  -- 3+ total riders requires dual consent from driver + primary rider.
  IF v_total_riders >= 3 THEN
    v_status := 'pending_consent';
    v_reason := 'AWAITING_GROUP_CONSENT';
    v_role := 'passenger_joiner';
    v_expires_at := now() + interval '30 minutes';
  ELSE
    v_status := 'accepted';
    v_reason := 'SUCCESS';
    v_role := 'host_rider';
    v_expires_at := NULL;
  END IF;

  INSERT INTO ride_bookings (
    ride_id, passenger_id, pickup_lat, pickup_lng, pickup_label,
    dropoff_lat, dropoff_lng, dropoff_label, seats_requested, max_co_passengers,
    role, status, expires_at
  ) VALUES (
    p_ride_id, p_passenger_id, p_pickup_lat, p_pickup_lng, p_pickup_label,
    p_dropoff_lat, p_dropoff_lng, p_dropoff_label, p_seats_requested, p_max_co_passengers,
    v_role, v_status, v_expires_at
  ) RETURNING id INTO v_new_booking_id;

  -- Reserve seats immediately either way (declines restore them below).
  UPDATE rides
  SET available_seats = available_seats - p_seats_requested
  WHERE id = p_ride_id;

  -- Designate the primary rider on the 1:1 auto-accept, if unset.
  IF v_status = 'accepted' AND v_ride.primary_rider_id IS NULL THEN
    UPDATE rides SET primary_rider_id = p_passenger_id WHERE id = p_ride_id;
  END IF;

  SELECT display_name INTO v_joiner_name FROM users WHERE id = p_passenger_id;
  v_joiner_name := COALESCE(v_joiner_name, 'A rider');

  IF v_status = 'pending_consent' THEN
    -- DUAL CONSENT: exactly two approvers, driver + primary rider,
    -- de-duplicated, nulls skipped.
    INSERT INTO ride_consents (ride_id, booking_id, rider_id, status)
    SELECT DISTINCT p_ride_id, v_new_booking_id, approver.rid, 'awaiting'
    FROM (
      SELECT v_ride.driver_id AS rid
      UNION ALL
      SELECT v_ride.primary_rider_id
    ) approver
    WHERE approver.rid IS NOT NULL;

    -- Notify each approver that a vote is waiting.
    FOR v_voter IN
      SELECT rc.rider_id FROM ride_consents rc WHERE rc.booking_id = v_new_booking_id
    LOOP
      INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
      VALUES (
        v_voter.rider_id,
        'consent_requested',
        'Approval needed',
        v_joiner_name || ' wants to join your shared ride. The driver and primary rider must both approve.',
        p_ride_id,
        v_new_booking_id
      );
    END LOOP;

    -- The joiner sees their own request as pending in their feed (no vote).
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (
      p_passenger_id,
      'consent_requested',
      'Request sent',
      'Your request to join was sent and is awaiting host approval.',
      p_ride_id,
      v_new_booking_id
    );

    -- Read-only notice to every OTHER accepted rider (not an approver):
    -- their ride is changing, but they don't vote.
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    SELECT rb.passenger_id, 'ride_update', 'A rider asked to join',
           v_joiner_name || ' asked to join your ride. The hosts are reviewing it.',
           p_ride_id, v_new_booking_id
    FROM ride_bookings rb
    WHERE rb.ride_id = p_ride_id
      AND rb.status = 'accepted'
      AND rb.id != v_new_booking_id
      AND rb.passenger_id <> v_ride.driver_id
      AND rb.passenger_id <> v_ride.primary_rider_id;
  END IF;

  RETURN QUERY SELECT v_new_booking_id, TRUE, v_reason;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- respond_to_ride_consent(): unchanged decision rules (any decline
-- cancels; both approvals accept) plus read-only 'ride_update' pings to
-- non-approver riders at each terminal outcome, so "everyone is notified"
-- even though only two people actually vote.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION respond_to_ride_consent(
  p_booking_id UUID,
  p_rider_id UUID,
  p_agree BOOLEAN
)
RETURNS TABLE (
  success BOOLEAN,
  booking_status TEXT,
  reason TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking RECORD;
  v_ride RECORD;
  v_consent RECORD;
  v_awaiting_count INT;
  v_declined_count INT;
  v_joiner_name TEXT;
BEGIN
  SELECT * INTO v_booking
  FROM ride_bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, 'BOOKING_NOT_FOUND';
    RETURN;
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = v_booking.ride_id;

  SELECT display_name INTO v_joiner_name FROM users WHERE id = v_booking.passenger_id;
  v_joiner_name := COALESCE(v_joiner_name, 'A rider');

  -- A vote arriving after the deadline must not resurrect a booking
  -- whose seat may already be considered forfeited.
  IF v_booking.status = 'pending_consent' AND v_booking.expires_at IS NOT NULL AND v_booking.expires_at < now() THEN
    UPDATE ride_bookings SET status = 'cancelled' WHERE id = p_booking_id;
    UPDATE rides SET available_seats = available_seats + v_booking.seats_requested WHERE id = v_booking.ride_id;
    UPDATE ride_consents rc SET status = 'expired', responded_at = now()
      WHERE rc.booking_id = p_booking_id AND rc.status = 'awaiting';

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (v_booking.passenger_id, 'consent_expired', 'Join request expired',
            'Nobody finished approving in time, so your request to join was automatically cancelled.',
            v_booking.ride_id, p_booking_id);

    RETURN QUERY SELECT FALSE, 'cancelled', 'CONSENT_EXPIRED';
    RETURN;
  END IF;

  IF v_booking.status != 'pending_consent' THEN
    RETURN QUERY SELECT FALSE, v_booking.status, 'NOT_AWAITING_CONSENT';
    RETURN;
  END IF;

  SELECT * INTO v_consent
  FROM ride_consents
  WHERE booking_id = p_booking_id AND rider_id = p_rider_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, v_booking.status, 'NOT_A_VOTER_ON_THIS_BOOKING';
    RETURN;
  END IF;

  IF v_consent.status != 'awaiting' THEN
    RETURN QUERY SELECT FALSE, v_booking.status, 'ALREADY_RESPONDED';
    RETURN;
  END IF;

  UPDATE ride_consents
  SET status = CASE WHEN p_agree THEN 'agreed' ELSE 'declined' END,
      responded_at = now()
  WHERE id = v_consent.id;

  IF NOT p_agree THEN
    UPDATE ride_bookings SET status = 'cancelled' WHERE id = p_booking_id;
    UPDATE rides SET available_seats = available_seats + v_booking.seats_requested WHERE id = v_booking.ride_id;
    UPDATE ride_consents rc SET status = 'declined', responded_at = now()
      WHERE rc.booking_id = p_booking_id AND rc.status = 'awaiting';

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (v_booking.passenger_id, 'consent_resolved', 'Your request was answered',
            'A host declined your request to join.', v_booking.ride_id, p_booking_id);

    -- Read-only heads-up to the other riders that the pending join fell through.
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    SELECT rb.passenger_id, 'ride_update', 'Join request closed',
           v_joiner_name || '''s join request was not approved.', v_booking.ride_id, p_booking_id
    FROM ride_bookings rb
    WHERE rb.ride_id = v_booking.ride_id AND rb.status = 'accepted' AND rb.id != p_booking_id
      AND rb.passenger_id <> v_ride.driver_id
      AND rb.passenger_id <> v_ride.primary_rider_id;

    RETURN QUERY SELECT TRUE, 'cancelled', 'DECLINED';
    RETURN;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE status = 'awaiting'),
    COUNT(*) FILTER (WHERE status = 'declined')
  INTO v_awaiting_count, v_declined_count
  FROM ride_consents
  WHERE booking_id = p_booking_id;

  IF v_declined_count > 0 THEN
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    SELECT v_booking.passenger_id, 'consent_resolved', 'Your request was answered',
           'A host declined your request to join.', v_booking.ride_id, p_booking_id
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications WHERE booking_id = p_booking_id AND kind = 'consent_resolved'
    );
    RETURN QUERY SELECT TRUE, 'cancelled', 'DECLINED';
    RETURN;
  END IF;

  IF v_awaiting_count = 0 THEN
    UPDATE ride_bookings SET status = 'accepted' WHERE id = p_booking_id;

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (v_booking.passenger_id, 'consent_resolved', 'Your request was answered',
            'Both hosts approved your request to join.', v_booking.ride_id, p_booking_id);

    -- Read-only confirmation to the other riders that a new member joined.
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    SELECT rb.passenger_id, 'ride_update', 'A rider joined',
           v_joiner_name || ' was approved and joined your ride.', v_booking.ride_id, p_booking_id
    FROM ride_bookings rb
    WHERE rb.ride_id = v_booking.ride_id AND rb.status = 'accepted' AND rb.id != p_booking_id
      AND rb.passenger_id <> v_ride.driver_id
      AND rb.passenger_id <> v_ride.primary_rider_id;

    RETURN QUERY SELECT TRUE, 'accepted', 'ALL_AGREED';
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'pending_consent', 'AWAITING_OTHERS';
END;
$$;

-- Same grants as the prior versions (idempotent re-assert).
revoke all on function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
) from public;
grant execute on function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
) to authenticated;
alter function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
) security definer set search_path = public;

revoke all on function public.respond_to_ride_consent(uuid, uuid, boolean) from public;
grant execute on function public.respond_to_ride_consent(uuid, uuid, boolean) to authenticated;
alter function public.respond_to_ride_consent(uuid, uuid, boolean)
  security definer set search_path = public;
