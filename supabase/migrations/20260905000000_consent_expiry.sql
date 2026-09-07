-- ─────────────────────────────────────────────────────────────
-- Migration: Consent expiry.
--
-- PROBLEM: 20260904000000_group_consent_carbon.sql introduced
-- pending_consent bookings that reserve a seat immediately but only
-- ever leave that state via respond_to_ride_consent(). If any one
-- rider in the group simply never votes, the booking sits in
-- pending_consent forever, the seat stays reserved forever, and
-- nothing in the system can recover it. That's a real gap, not a
-- theoretical one — real users disengage from apps constantly.
--
-- FIX: give every pending_consent booking a deadline. Past it, the
-- booking is treated as cancelled, the seat is restored, and any
-- still-"awaiting" votes are marked "expired" (distinct from
-- "declined" — nobody said no, the clock just ran out).
-- ─────────────────────────────────────────────────────────────

-- 1. Every pending_consent booking gets a deadline.
alter table public.ride_bookings
  add column if not exists expires_at timestamp with time zone;

comment on column public.ride_bookings.expires_at is
  'Only meaningful while status = pending_consent. Past this timestamp the booking is stale and must be treated as cancelled — see expire_stale_consent_bookings().';

comment on column public.ride_bookings.status is
  'pending | pending_consent (awaiting unanimous group consent, 3+ riders, until expires_at) | accepted | completed | cancelled';

-- 2. "expired" joins the vote vocabulary alongside awaiting/agreed/declined.
alter table public.ride_consents
  drop constraint if exists ride_consents_status_check;
alter table public.ride_consents
  add constraint ride_consents_status_check
  check (status in ('awaiting', 'agreed', 'declined', 'expired'));

-- 3. book_pooled_ride(): identical to before, except a pending_consent
--    booking now gets a 30-minute deadline.
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
  v_expires_at TIMESTAMPTZ;
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
  v_total_riders := v_proposed_count + 1;

  IF v_ride.driver_max_co_passengers IS NOT NULL AND v_proposed_count > v_ride.driver_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'DRIVER_CAP_EXCEEDED';
    RETURN;
  END IF;

  IF p_max_co_passengers IS NOT NULL AND p_max_co_passengers != -1 AND v_proposed_count > p_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'PASSENGER_CAP_EXCEEDED';
    RETURN;
  END IF;

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

  IF v_ride.available_seats < p_seats_requested THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'INSUFFICIENT_SEATS';
    RETURN;
  END IF;

  IF v_total_riders >= 3 THEN
    v_status := 'pending_consent';
    v_reason := 'AWAITING_GROUP_CONSENT';
    v_expires_at := now() + interval '30 minutes';
  ELSE
    v_status := 'accepted';
    v_reason := 'SUCCESS';
    v_expires_at := NULL;
  END IF;

  INSERT INTO ride_bookings (
    ride_id, passenger_id, pickup_lat, pickup_lng, pickup_label,
    dropoff_lat, dropoff_lng, dropoff_label, seats_requested, max_co_passengers, status, expires_at
  ) VALUES (
    p_ride_id, p_passenger_id, p_pickup_lat, p_pickup_lng, p_pickup_label,
    p_dropoff_lat, p_dropoff_lng, p_dropoff_label, p_seats_requested, p_max_co_passengers, v_status, v_expires_at
  ) RETURNING id INTO v_new_booking_id;

  UPDATE rides
  SET available_seats = available_seats - p_seats_requested
  WHERE id = p_ride_id;

  IF v_status = 'pending_consent' THEN
    INSERT INTO ride_consents (ride_id, booking_id, rider_id, status)
    VALUES (p_ride_id, v_new_booking_id, p_passenger_id, 'awaiting');

    INSERT INTO ride_consents (ride_id, booking_id, rider_id, status)
    VALUES (p_ride_id, v_new_booking_id, v_ride.driver_id, 'awaiting');

    INSERT INTO ride_consents (ride_id, booking_id, rider_id, status)
    SELECT p_ride_id, v_new_booking_id, rb.passenger_id, 'awaiting'
    FROM ride_bookings rb
    WHERE rb.ride_id = p_ride_id
      AND rb.status = 'accepted'
      AND rb.id != v_new_booking_id;
  END IF;

  RETURN QUERY SELECT v_new_booking_id, TRUE, v_reason;
END;
$$;

-- 4. respond_to_ride_consent(): now checks the deadline first. A vote
--    arriving after expires_at must not be able to resurrect a
--    booking whose seat may already be considered forfeited.
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
  v_consent RECORD;
  v_awaiting_count INT;
  v_declined_count INT;
BEGIN
  SELECT * INTO v_booking
  FROM ride_bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, 'BOOKING_NOT_FOUND';
    RETURN;
  END IF;

  IF v_booking.status = 'pending_consent' AND v_booking.expires_at IS NOT NULL AND v_booking.expires_at < now() THEN
    UPDATE ride_bookings SET status = 'cancelled' WHERE id = p_booking_id;
    UPDATE rides SET available_seats = available_seats + v_booking.seats_requested WHERE id = v_booking.ride_id;
    UPDATE ride_consents SET status = 'expired', responded_at = now()
      WHERE booking_id = p_booking_id AND status = 'awaiting';

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
    UPDATE ride_consents SET status = 'declined', responded_at = now()
      WHERE booking_id = p_booking_id AND status = 'awaiting';

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
    RETURN QUERY SELECT TRUE, 'cancelled', 'DECLINED';
    RETURN;
  END IF;

  IF v_awaiting_count = 0 THEN
    UPDATE ride_bookings SET status = 'accepted' WHERE id = p_booking_id;
    RETURN QUERY SELECT TRUE, 'accepted', 'ALL_AGREED';
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'pending_consent', 'AWAITING_OTHERS';
END;
$$;

-- 5. Bulk sweep, callable from the API layer before any read of
--    pending consents (lazy expiry — no pg_cron dependency required
--    for correctness) and optionally on a schedule if pg_cron is
--    available on this project.
CREATE OR REPLACE FUNCTION expire_stale_consent_bookings()
RETURNS TABLE (booking_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT id, ride_id, seats_requested
    FROM ride_bookings
    WHERE status = 'pending_consent'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    FOR UPDATE
  LOOP
    UPDATE ride_bookings SET status = 'cancelled' WHERE id = v_row.id;
    UPDATE rides SET available_seats = available_seats + v_row.seats_requested WHERE id = v_row.ride_id;
    -- Table alias required: this function's OUT parameter is also
    -- named booking_id, so a bare reference here is ambiguous between
    -- the ride_consents column and the OUT parameter (caught by
    -- actually running this function against a real database, not by
    -- CREATE FUNCTION's parse-time check alone).
    UPDATE ride_consents rc SET status = 'expired', responded_at = now()
      WHERE rc.booking_id = v_row.id AND rc.status = 'awaiting';

    booking_id := v_row.id;
    RETURN NEXT;
  END LOOP;
END;
$$;

revoke all on function public.expire_stale_consent_bookings() from public;
grant execute on function public.expire_stale_consent_bookings() to authenticated, service_role;
alter function public.expire_stale_consent_bookings()
  security definer
  set search_path = public;

-- 6. Best-effort scheduled sweep every 5 minutes, so seats free up
--    even if nobody happens to hit an endpoint that triggers the lazy
--    check. Wrapped in a guard because pg_cron isn't enabled on every
--    Supabase project/tier — if it's missing, this silently no-ops
--    and the lazy per-request expiry (called from apiHandler.ts)
--    still guarantees correctness, just not proactively.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('expire-stale-consent-bookings')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-stale-consent-bookings');

    PERFORM cron.schedule(
      'expire-stale-consent-bookings',
      '*/5 * * * *',
      $sql$SELECT public.expire_stale_consent_bookings();$sql$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron present but this role can't manage jobs, or any other
  -- environment quirk — never fail the migration over a best-effort
  -- scheduling nicety.
  NULL;
END $$;
