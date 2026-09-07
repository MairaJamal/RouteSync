-- ─────────────────────────────────────────────────────────────
-- Migration: Group consent for 3+ rider pools, + carbon savings
-- ledger shown on every share.
--
-- PROBLEM: book_pooled_ride() today inserts a passenger straight as
-- 'accepted' the moment capacity/safety checks pass. That's fine for
-- a 1:1 match (both sides already agreed by matching + chatting), but
-- once a THIRD rider joins an existing pool, the ride changes for
-- everyone already in it (new co-passenger, longer detour, less
-- privacy) and none of them were asked. This migration adds an
-- explicit unanimous-consent gate for any booking that would bring
-- the ride to 3+ total riders (driver + passengers).
--
-- FLOW:
--  1. book_pooled_ride() runs the same capacity/safety checks as
--     before. If they pass and the resulting pool is STILL <= 2
--     total riders, it books straight to 'accepted' exactly as today
--     — no behavior change for simple 1:1 matches.
--  2. If they pass and the resulting pool would be >= 3 total riders,
--     the seat is reserved (available_seats decremented so nobody
--     else races for it) but the booking is inserted as
--     'pending_consent', and a ride_consents row is created for the
--     driver, every existing active passenger, AND the new
--     candidate — everyone gets a vote on the new group shape.
--  3. respond_to_ride_consent() records each rider's answer.
--       - Any single decline cancels the pending booking, restores
--         the seat, and closes out the remaining consent rows.
--       - Once every consent row for that booking is 'agreed', the
--         booking flips to 'accepted' and the pool is finalized.
--  4. record_ride_carbon_savings() is called once a ride completes,
--     writing one ledger row per rider so the app can show a running
--     "CO2 avoided" total, not just a one-off number on the fare
--     card.
-- ─────────────────────────────────────────────────────────────

-- 1. ride_consents: one row per (booking, rider) vote.
create table if not exists public.ride_consents (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  booking_id uuid not null references public.ride_bookings(id) on delete cascade,
  rider_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'awaiting', -- 'awaiting' | 'agreed' | 'declined'
  requested_at timestamp with time zone default now(),
  responded_at timestamp with time zone,
  unique (booking_id, rider_id)
);

alter table public.ride_consents
  drop constraint if exists ride_consents_status_check;
alter table public.ride_consents
  add constraint ride_consents_status_check
  check (status in ('awaiting', 'agreed', 'declined'));

create index if not exists idx_ride_consents_booking on public.ride_consents(booking_id, status);
create index if not exists idx_ride_consents_rider on public.ride_consents(rider_id, status);

comment on table public.ride_consents is
  'Per-rider votes gating any booking that would bring a pooled ride to 3+ total riders. All rows for a booking must be agreed before the booking leaves pending_consent.';

-- 2. Loosen the implicit status vocabulary on ride_bookings to include
--    'pending_consent' (no CHECK constraint existed before this, so
--    nothing to alter — documenting it here for clarity).
comment on column public.ride_bookings.status is
  'pending | pending_consent (awaiting unanimous group consent, 3+ riders) | accepted | completed | cancelled';

-- 3. Carbon savings ledger — one row per rider per completed ride, so
--    the app can show a running total, not just a per-share estimate.
create table if not exists public.carbon_savings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  rider_id uuid not null references public.users(id) on delete cascade,
  co2_saved_kg numeric(8,2) not null,
  rider_count int not null,
  distance_km numeric(8,2) not null,
  created_at timestamp with time zone default now(),
  unique (ride_id, rider_id)
);

create index if not exists idx_carbon_savings_rider on public.carbon_savings(rider_id);

comment on table public.carbon_savings is
  'CO2 avoided per rider per completed ride, vs. everyone in the pool driving solo. Sum by rider_id for a profile-level running total.';

-- 4. Replace book_pooled_ride(): same signature/checks as before, but
--    routes 3+-rider pools through the consent table instead of
--    auto-accepting.
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
  v_proposed_count INT;         -- co-passengers after join (excludes driver)
  v_total_riders INT;           -- driver + co-passengers after join
  v_new_booking_id UUID;
  v_status TEXT;
  v_reason TEXT;
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

  -- Decide status: 2 total riders (driver + this passenger, nobody
  -- else in the pool) auto-accepts exactly like before. 3+ total
  -- riders requires unanimous consent from everyone in the new group.
  IF v_total_riders >= 3 THEN
    v_status := 'pending_consent';
    v_reason := 'AWAITING_GROUP_CONSENT';
  ELSE
    v_status := 'accepted';
    v_reason := 'SUCCESS';
  END IF;

  INSERT INTO ride_bookings (
    ride_id, passenger_id, pickup_lat, pickup_lng, pickup_label,
    dropoff_lat, dropoff_lng, dropoff_label, seats_requested, max_co_passengers, status
  ) VALUES (
    p_ride_id, p_passenger_id, p_pickup_lat, p_pickup_lng, p_pickup_label,
    p_dropoff_lat, p_dropoff_lng, p_dropoff_label, p_seats_requested, p_max_co_passengers, v_status
  ) RETURNING id INTO v_new_booking_id;

  -- Reserve the seat immediately either way, so nobody else can race
  -- for it while consent is pending. Declines restore it (see
  -- respond_to_ride_consent below).
  UPDATE rides
  SET available_seats = available_seats - p_seats_requested
  WHERE id = p_ride_id;

  IF v_status = 'pending_consent' THEN
    -- One consent row for the joining candidate...
    INSERT INTO ride_consents (ride_id, booking_id, rider_id, status)
    VALUES (p_ride_id, v_new_booking_id, p_passenger_id, 'awaiting');

    -- ...and one for the driver...
    INSERT INTO ride_consents (ride_id, booking_id, rider_id, status)
    VALUES (p_ride_id, v_new_booking_id, v_ride.driver_id, 'awaiting');

    -- ...and one for every other currently-accepted passenger in the
    -- pool (people already riding, whose ride is about to change).
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

-- 5. respond_to_ride_consent(): records one rider's vote and
--    finalizes or rejects the booking once everyone has answered.
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
  -- Lock the booking row so two simultaneous votes can't both think
  -- they're the one finalizing it.
  SELECT * INTO v_booking
  FROM ride_bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, 'BOOKING_NOT_FOUND';
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
    -- One decline is enough to cancel this join. Restore the
    -- reserved seat and close out the remaining votes.
    UPDATE ride_bookings SET status = 'cancelled' WHERE id = p_booking_id;
    UPDATE rides SET available_seats = available_seats + v_booking.seats_requested WHERE id = v_booking.ride_id;
    UPDATE ride_consents SET status = 'declined', responded_at = now()
      WHERE booking_id = p_booking_id AND status = 'awaiting';

    RETURN QUERY SELECT TRUE, 'cancelled', 'DECLINED';
    RETURN;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE status = 'awaiting') ,
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

-- 6. record_ride_carbon_savings(): call once when a ride completes.
--    Splits the CO2 avoided (vs. every rider driving solo) evenly
--    across the driver + accepted passengers and writes one ledger
--    row per rider for a running profile total.
CREATE OR REPLACE FUNCTION record_ride_carbon_savings(
  p_ride_id UUID,
  p_distance_km NUMERIC,
  p_co2_kg_per_km_solo NUMERIC DEFAULT 0.21
)
RETURNS SETOF public.carbon_savings
LANGUAGE plpgsql
AS $$
DECLARE
  v_ride RECORD;
  v_rider_count INT;
  v_total_saved NUMERIC;
  v_per_rider NUMERIC;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*) + 1 INTO v_rider_count -- +1 for the driver
  FROM ride_bookings
  WHERE ride_id = p_ride_id AND status = 'accepted';

  IF v_rider_count < 2 THEN
    RETURN; -- solo ride, nothing shared, nothing avoided
  END IF;

  -- (riders - 1) solo trips avoided, at p_co2_kg_per_km_solo per km.
  v_total_saved := p_distance_km * p_co2_kg_per_km_solo * (v_rider_count - 1);
  v_per_rider := round(v_total_saved / v_rider_count, 2);

  INSERT INTO carbon_savings (ride_id, rider_id, co2_saved_kg, rider_count, distance_km)
  VALUES (p_ride_id, v_ride.driver_id, v_per_rider, v_rider_count, p_distance_km)
  ON CONFLICT (ride_id, rider_id) DO NOTHING;

  INSERT INTO carbon_savings (ride_id, rider_id, co2_saved_kg, rider_count, distance_km)
  SELECT p_ride_id, rb.passenger_id, v_per_rider, v_rider_count, p_distance_km
  FROM ride_bookings rb
  WHERE rb.ride_id = p_ride_id AND rb.status = 'accepted'
  ON CONFLICT (ride_id, rider_id) DO NOTHING;

  RETURN QUERY SELECT * FROM carbon_savings WHERE ride_id = p_ride_id;
END;
$$;

-- 7. RLS: ride_consents follows the same auth_user_id -> users.id
--    pattern as ride_bookings/rides (20260826000000_pooling_rls.sql).
--    A rider can only ever see/answer their own vote — not the whole
--    group's ballot.
alter table public.ride_consents enable row level security;

drop policy if exists ride_consents_select on public.ride_consents;
create policy ride_consents_select
on public.ride_consents
for select
to authenticated
using (
  rider_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- No direct insert/update policy: rows are only ever written by the
-- SECURITY DEFINER functions below, never by a client-side write.
revoke all on public.ride_consents from public;
grant select on public.ride_consents to authenticated;

alter table public.carbon_savings enable row level security;

drop policy if exists carbon_savings_select on public.carbon_savings;
create policy carbon_savings_select
on public.carbon_savings
for select
to authenticated
using (
  rider_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

revoke all on public.carbon_savings from public;
grant select on public.carbon_savings to authenticated;

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

revoke all on function public.record_ride_carbon_savings(uuid, numeric, numeric) from public;
grant execute on function public.record_ride_carbon_savings(uuid, numeric, numeric) to authenticated;
alter function public.record_ride_carbon_savings(uuid, numeric, numeric)
  security definer
  set search_path = public;
