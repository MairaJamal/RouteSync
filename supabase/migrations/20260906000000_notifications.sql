-- ─────────────────────────────────────────────────────────────
-- Migration: In-app notification feed.
--
-- PROBLEM: a pending_consent vote (see
-- 20260904000000_group_consent_carbon.sql /
-- 20260905000000_consent_expiry.sql) is invisible to a rider unless
-- they happen to have the app open and PendingConsentsPanel happens
-- to poll while it's still awaiting. Since consent now safely expires
-- after 30 minutes, a real, would-have-been-agreed join can silently
-- time out purely from lack of notice — undercutting the feature we
-- just made safe.
--
-- WHY A FEED, NOT PUSH/SMS: real push needs a device token, and SMS
-- needs a phone number for the RIDER THEMSELVES — today only
-- emergency_contacts.contact_phone exists, not a phone number on
-- `users`. Wiring either also needs an external provider (FCM /
-- Twilio) with credentials this project doesn't have. An in-app feed
-- is the piece that's actually deliverable today, and it's the same
-- foundation real push would sit on later (this migration is the
-- event-producing side; delivery can be layered on without touching
-- it again).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in (
    'consent_requested', 'consent_reminder', 'consent_resolved', 'consent_expired'
  )),
  title text not null,
  body text not null,
  ride_id uuid references public.rides(id) on delete set null,
  booking_id uuid references public.ride_bookings(id) on delete set null,
  created_at timestamp with time zone default now(),
  read_at timestamp with time zone
);

create index if not exists idx_notifications_user_unread
  on public.notifications(user_id, created_at desc)
  where read_at is null;

comment on table public.notifications is
  'In-app notification feed. Written only by SECURITY DEFINER functions triggered from the consent-voting flow — never inserted directly by a client.';

-- A booking is nudged at most once as its deadline approaches.
alter table public.ride_bookings
  add column if not exists nudged_at timestamp with time zone;

comment on column public.ride_bookings.nudged_at is
  'Set once the ~5-minute-left reminder has been sent for this pending_consent booking, so notify_near_expiry_consents() never nudges the same booking twice.';

-- RLS: a rider only ever sees their own notifications.
alter table public.notifications enable row level security;

drop policy if exists notifications_select on public.notifications;
create policy notifications_select
on public.notifications
for select
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

revoke all on public.notifications from public;
grant select on public.notifications to authenticated;

-- ─────────────────────────────────────────────────────────────
-- book_pooled_ride(): identical to the expiry-aware version in
-- 20260905000000_consent_expiry.sql, plus a notification for every
-- voter (including the joiner, so their own request shows in their
-- feed too) the moment a pending_consent booking is created.
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

    SELECT display_name INTO v_joiner_name FROM users WHERE id = p_passenger_id;
    v_joiner_name := COALESCE(v_joiner_name, 'A rider');

    -- Table alias required: this function's OUT parameter is also
    -- named booking_id, so a bare reference is ambiguous between the
    -- ride_consents column and the OUT parameter — caught by actually
    -- running this function, not by CREATE FUNCTION's parse-time
    -- check alone.
    FOR v_voter IN
      SELECT DISTINCT rc.rider_id FROM ride_consents rc WHERE rc.booking_id = v_new_booking_id
    LOOP
      INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
      VALUES (
        v_voter.rider_id,
        'consent_requested',
        'Group approval needed',
        v_joiner_name || ' wants to join your shared ride. Everyone in the group needs to agree.',
        p_ride_id,
        v_new_booking_id
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_new_booking_id, TRUE, v_reason;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- respond_to_ride_consent(): identical logic to the expiry-aware
-- version, plus a "your request was answered" / "expired" notice for
-- the joiner (booking.passenger_id) at each terminal outcome.
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

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (
      v_booking.passenger_id,
      'consent_expired',
      'Join request expired',
      'Nobody finished voting in time, so your request to join was automatically cancelled.',
      v_booking.ride_id,
      p_booking_id
    );

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

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (
      v_booking.passenger_id,
      'consent_resolved',
      'Your request was answered',
      'The group finished voting on your join request.',
      v_booking.ride_id,
      p_booking_id
    );

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
    -- Reached when a later "agree" arrives after someone else already
    -- declined — the booking and seat were already resolved in that
    -- decline's own branch above (or on a prior call to this one), so
    -- there's nothing left to update except guarding against sending
    -- the joiner a second "answered" notice for the same booking.
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    SELECT v_booking.passenger_id, 'consent_resolved', 'Your request was answered',
           'The group finished voting on your join request.', v_booking.ride_id, p_booking_id
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications
      WHERE booking_id = p_booking_id AND kind = 'consent_resolved'
    );

    RETURN QUERY SELECT TRUE, 'cancelled', 'DECLINED';
    RETURN;
  END IF;

  IF v_awaiting_count = 0 THEN
    UPDATE ride_bookings SET status = 'accepted' WHERE id = p_booking_id;

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (
      v_booking.passenger_id,
      'consent_resolved',
      'Your request was answered',
      'The group finished voting on your join request.',
      v_booking.ride_id,
      p_booking_id
    );

    RETURN QUERY SELECT TRUE, 'accepted', 'ALL_AGREED';
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'pending_consent', 'AWAITING_OTHERS';
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- expire_stale_consent_bookings(): identical to
-- 20260905000000_consent_expiry.sql, plus a "your request expired"
-- notice for each swept booking's original joiner.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION expire_stale_consent_bookings()
RETURNS TABLE (booking_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT id, ride_id, seats_requested, passenger_id
    FROM ride_bookings
    WHERE status = 'pending_consent'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    FOR UPDATE
  LOOP
    UPDATE ride_bookings SET status = 'cancelled' WHERE id = v_row.id;
    UPDATE rides SET available_seats = available_seats + v_row.seats_requested WHERE id = v_row.ride_id;
    -- Table alias required — see comment on the same pattern above.
    UPDATE ride_consents rc SET status = 'expired', responded_at = now()
      WHERE rc.booking_id = v_row.id AND rc.status = 'awaiting';

    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    VALUES (
      v_row.passenger_id,
      'consent_expired',
      'Join request expired',
      'Nobody finished voting in time, so your request to join was automatically cancelled.',
      v_row.ride_id,
      v_row.id
    );

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

-- ─────────────────────────────────────────────────────────────
-- notify_near_expiry_consents(): a "5 minutes left" reminder to
-- anyone still 'awaiting' on a booking within its final 5 minutes.
-- nudged_at guarantees at most one reminder per booking, no matter
-- how often this is called (lazily from the API or via pg_cron).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_near_expiry_consents()
RETURNS TABLE (booking_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
  v_joiner_name TEXT;
BEGIN
  FOR v_row IN
    SELECT id, ride_id, passenger_id
    FROM ride_bookings
    WHERE status = 'pending_consent'
      AND expires_at IS NOT NULL
      AND nudged_at IS NULL
      AND expires_at > now()
      AND expires_at <= now() + interval '5 minutes'
    FOR UPDATE
  LOOP
    SELECT display_name INTO v_joiner_name FROM users WHERE id = v_row.passenger_id;
    v_joiner_name := COALESCE(v_joiner_name, 'A rider');

    -- Table alias required — see comment on the same pattern above.
    INSERT INTO notifications (user_id, kind, title, body, ride_id, booking_id)
    SELECT rc.rider_id, 'consent_reminder', '5 minutes left to respond',
           v_joiner_name || '''s join request expires soon — vote now or the seat will be released.',
           v_row.ride_id, v_row.id
    FROM ride_consents rc
    WHERE rc.booking_id = v_row.id AND rc.status = 'awaiting';

    UPDATE ride_bookings SET nudged_at = now() WHERE id = v_row.id;

    booking_id := v_row.id;
    RETURN NEXT;
  END LOOP;
END;
$$;

revoke all on function public.notify_near_expiry_consents() from public;
grant execute on function public.notify_near_expiry_consents() to authenticated, service_role;
alter function public.notify_near_expiry_consents()
  security definer
  set search_path = public;

-- ─────────────────────────────────────────────────────────────
-- Mark-as-read, scoped to the caller's own notifications only.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mark_notification_read(p_notification_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE notifications
  SET read_at = now()
  WHERE id = p_notification_id AND user_id = p_user_id AND read_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION mark_all_notifications_read(p_user_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE notifications
  SET read_at = now()
  WHERE user_id = p_user_id AND read_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

revoke all on function public.mark_notification_read(uuid, uuid) from public;
grant execute on function public.mark_notification_read(uuid, uuid) to authenticated, service_role;
alter function public.mark_notification_read(uuid, uuid)
  security definer
  set search_path = public;

revoke all on function public.mark_all_notifications_read(uuid) from public;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated, service_role;
alter function public.mark_all_notifications_read(uuid)
  security definer
  set search_path = public;

revoke all on function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
) from public;
grant execute on function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
) to authenticated;
alter function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
) security definer
set search_path = public;

revoke all on function public.respond_to_ride_consent(uuid, uuid, boolean) from public;
grant execute on function public.respond_to_ride_consent(uuid, uuid, boolean) to authenticated;
alter function public.respond_to_ride_consent(uuid, uuid, boolean)
  security definer
  set search_path = public;

-- Best-effort proactive sweep alongside the existing expiry job (see
-- 20260905000000_consent_expiry.sql) — same pg_cron guard, same
-- graceful no-op if the extension isn't available on this project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('notify-near-expiry-consents')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-near-expiry-consents');

    PERFORM cron.schedule(
      'notify-near-expiry-consents',
      '* * * * *',
      $sql$SELECT public.notify_near_expiry_consents();$sql$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
