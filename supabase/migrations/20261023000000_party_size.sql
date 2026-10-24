-- ─────────────────────────────────────────────────────────────
-- Migration: Party size ("I am 2 people") + people-count occupancy.
-- Idempotent: every statement is safe to re-run (IF NOT EXISTS /
-- CREATE OR REPLACE / drop-then-add constraints / drop-then-create
-- function with the new signature).
--
-- DEFINITIONS (stated once here; used everywhere these rules flow —
-- the RPCs below, the poolingCapacity.ts TS mirror, and apiHandler.ts):
--   * party_size = number of people travelling together under ONE
--     account (1..4). The account holder is the lead. Optional
--     party_member_names (text[], max 3) so the driver knows who else
--     is coming.
--   * A party is ONE booking with seats_requested = party_size. Never
--     one booking per person.
--   * Occupancy is counted in PEOPLE, not bookings:
--     occupied_people = the host slot counts as 1 person (driver in
--     car_pool; the booker in ride_hail_share) UNLESS that same user
--     already holds an active booking — their own party booking then
--     includes them as its lead, so the slot adds nothing — PLUS
--     SUM(seats_requested) over bookings with status in
--     ('accepted','pending','pending_consent'). pending and
--     pending_consent are RESERVED seats and count toward occupancy.
--   * rides.total_seats stays PASSENGER seats (excluding the driver);
--     available_seats = total_seats - SUM(reserved seats). The UI shows
--     PEOPLE including the driver: a "max 3 people" car is
--     total_seats = 2. For ride_mode = 'ride_hail_share' the booker
--     declares the cab's TOTAL people capacity (usually 4) in
--     total_seats, and the booker's own party are the first occupants.
--
-- WHAT THIS FILE DOES:
--   1. trip_requests.party_size (int, 1..4, default 1).
--   2. ride_bookings.party_member_names (text[], max 3) and re-asserts
--      the seats_requested 1..4 range CHECK.
--   3. Replaces book_pooled_ride(): every COUNT(*)-of-bookings capacity
--      check now counts PEOPLE (driver cap, candidate max_co_passengers
--      cap, "most restrictive passenger wins" loop). Adds rejection
--      reason PARTY_TOO_LARGE_FOR_REMAINING_SEATS (remaining_seats is
--      included in the returned data); every existing reason code is
--      unchanged. The SELECT ... FOR UPDATE row lock is kept so
--      concurrent joins cannot overbook. Consent rule is unchanged: a
--      join that brings the ride to 3+ TOTAL PEOPLE needs dual consent
--      from the driver and the primary rider only — so a party of 2
--      joining a driver-only car (3 people) also needs consent.
--   4. Adds get_ride_occupancy(ride_id): total_people_capacity,
--      occupied_people, seats_left, status ('open'|'full') and
--      co_riders[] with server-side redaction.
--
-- ASSUMPTION (the task spec was cut off mid-sentence at "in
-- ride_hail_share only booked_by sees …"): joiner-detail redaction
-- follows the rule ALREADY SHIPPED in get_ride_participants — in
-- ride_hail_share only a host (driver / primary rider / booked_by) or
-- the joiner themself sees a joiner's name, party size and party
-- member names; every other viewer sees a masked "Fellow rider" with
-- null party details. car_pool never masks. Aggregate counts
-- (occupied_people, seats_left) are never masked — they carry no PII.
-- ─────────────────────────────────────────────────────────────

-- 1. trip_requests.party_size — the real trip request table is
--    public.trip_requests (20260822000000_trip_matching.sql).
alter table public.trip_requests
  add column if not exists party_size int not null default 1;

alter table public.trip_requests
  drop constraint if exists trip_requests_party_size_check;
alter table public.trip_requests
  add constraint trip_requests_party_size_check
  check (party_size between 1 and 4);

comment on column public.trip_requests.party_size is
  'People travelling together under this one account (lead included), 1..4. A party is ONE request/booking with seats_requested = party_size — never one per person.';

-- 2. ride_bookings.party_member_names + seats range re-assert.
alter table public.ride_bookings
  add column if not exists party_member_names text[] not null default '{}'::text[];

alter table public.ride_bookings
  drop constraint if exists ride_bookings_party_member_names_max;
alter table public.ride_bookings
  add constraint ride_bookings_party_member_names_max
  check (coalesce(array_length(party_member_names, 1), 0) <= 3);

comment on column public.ride_bookings.party_member_names is
  'Optional names of the people joining the lead (max 3) so the driver knows who is coming. The lead is never in this list; party size is seats_requested.';

alter table public.ride_bookings
  drop constraint if exists ride_bookings_seats_requested_range;
alter table public.ride_bookings
  add constraint ride_bookings_seats_requested_range
  check (seats_requested between 1 and 4);

-- ─────────────────────────────────────────────────────────────
-- 3. book_pooled_ride(): people-count version. The previous signature
--    (10 args) is dropped so PostgREST resolves exactly one function;
--    p_party_member_names is a NEW trailing arg with a default, so
--    existing callers that omit it keep working unchanged. The return
--    table gains remaining_seats (set on seat rejections and on
--    success), which is why a drop-then-create is required — CREATE OR
--    REPLACE cannot change a return type.
-- ─────────────────────────────────────────────────────────────
drop function if exists public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int
);

CREATE OR REPLACE FUNCTION book_pooled_ride(
  p_ride_id UUID,
  p_passenger_id UUID,
  p_pickup_lat NUMERIC,
  p_pickup_lng NUMERIC,
  p_pickup_label TEXT,
  p_dropoff_lat NUMERIC,
  p_dropoff_lng NUMERIC,
  p_dropoff_label TEXT,
  p_seats_requested INT, -- = party_size: ONE booking for the whole party
  p_max_co_passengers INT,
  p_party_member_names TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  booking_id UUID,
  success BOOLEAN,
  reason TEXT,
  remaining_seats INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ride RECORD;
  v_existing_booking RECORD;
  v_current_people INT;
  v_host_persons INT;
  v_proposed_count INT;
  v_total_riders INT;
  v_new_booking_id UUID;
  v_status TEXT;
  v_reason TEXT;
  v_role TEXT;
  v_expires_at TIMESTAMPTZ;
  v_joiner_name TEXT;
  v_joiner_label TEXT;
  v_party_names TEXT[];
  v_voter RECORD;
BEGIN
  SELECT * INTO v_ride
  FROM rides
  WHERE id = p_ride_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'RIDE_NOT_FOUND', NULL::INT;
    RETURN;
  END IF;

  IF v_ride.status != 'active' THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'RIDE_NOT_ACTIVE', NULL::INT;
    RETURN;
  END IF;

  -- PEOPLE, not bookings: every active booking reserves
  -- seats_requested = its party's size (pending / pending_consent
  -- included — reserved seats count toward occupancy).
  SELECT COALESCE(SUM(seats_requested), 0) INTO v_current_people
  FROM ride_bookings
  WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending', 'pending_consent');

  -- Host slot = driver (car_pool) or booker (ride_hail_share), counting
  -- as 1 person — unless that user holds an active booking themselves,
  -- in which case their party booking's seats_requested already counts
  -- them as its lead and the slot adds nothing.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM ride_bookings rb
    WHERE rb.ride_id = p_ride_id
      AND rb.status IN ('accepted', 'pending', 'pending_consent')
      AND rb.passenger_id = COALESCE(v_ride.driver_id, v_ride.booked_by)
  ) THEN 0 ELSE 1 END INTO v_host_persons;

  v_proposed_count := v_current_people + p_seats_requested; -- total people excluding the host slot
  v_total_riders := v_proposed_count + v_host_persons;     -- everyone in the car after this join

  -- 1. Driver Cap (people)
  IF v_ride.driver_max_co_passengers IS NOT NULL AND v_proposed_count > v_ride.driver_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'DRIVER_CAP_EXCEEDED', GREATEST(v_ride.available_seats, 0);
    RETURN;
  END IF;

  -- 2. Candidate Passenger Cap (people)
  IF p_max_co_passengers IS NOT NULL AND p_max_co_passengers != -1 AND v_proposed_count > p_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'PASSENGER_CAP_EXCEEDED', GREATEST(v_ride.available_seats, 0);
    RETURN;
  END IF;

  -- 3. Existing Passengers' Caps ("most restrictive passenger wins", people)
  FOR v_existing_booking IN
    SELECT max_co_passengers
    FROM ride_bookings
    WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending', 'pending_consent')
  LOOP
    IF v_existing_booking.max_co_passengers IS NOT NULL
       AND v_existing_booking.max_co_passengers != -1
       AND v_proposed_count > v_existing_booking.max_co_passengers THEN
      RETURN QUERY SELECT NULL::UUID, FALSE, 'EXISTING_PASSENGER_CAP_VIOLATED', GREATEST(v_ride.available_seats, 0);
      RETURN;
    END IF;
  END LOOP;

  -- 4. Seat Availability (available_seats = total_seats - SUM(reserved seats),
  --    maintained by the decrements below). A solo rider still sees the
  --    original INSUFFICIENT_SEATS code; a PARTY that simply doesn't fit
  --    gets the new PARTY_TOO_LARGE_FOR_REMAINING_SEATS with the seat
  --    count it needs to show the user.
  IF v_ride.available_seats < p_seats_requested THEN
    IF p_seats_requested > 1 THEN
      RETURN QUERY SELECT NULL::UUID, FALSE, 'PARTY_TOO_LARGE_FOR_REMAINING_SEATS', GREATEST(v_ride.available_seats, 0);
    ELSE
      RETURN QUERY SELECT NULL::UUID, FALSE, 'INSUFFICIENT_SEATS', GREATEST(v_ride.available_seats, 0);
    END IF;
    RETURN;
  END IF;

  -- 3+ TOTAL PEOPLE (host + everyone booked, pending parties included)
  -- requires dual consent from driver + primary rider. A party of 2
  -- joining a driver-only car makes 3 people, so it lands here too.
  -- 2 people (host + one solo passenger) auto-accepts as before.
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

  v_party_names := COALESCE(p_party_member_names, '{}'::text[]);
  IF array_length(v_party_names, 1) > 3 THEN
    v_party_names := v_party_names[1:3]; -- defensive; the CHECK caps at 3 too
  END IF;

  INSERT INTO ride_bookings (
    ride_id, passenger_id, pickup_lat, pickup_lng, pickup_label,
    dropoff_lat, dropoff_lng, dropoff_label, seats_requested, max_co_passengers,
    role, status, expires_at, party_member_names
  ) VALUES (
    p_ride_id, p_passenger_id, p_pickup_lat, p_pickup_lng, p_pickup_label,
    p_dropoff_lat, p_dropoff_lng, p_dropoff_label, p_seats_requested, p_max_co_passengers,
    v_role, v_status, v_expires_at, v_party_names
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
  v_joiner_label := v_joiner_name ||
    CASE WHEN p_seats_requested > 1
         THEN ' (party of ' || p_seats_requested || ')'
         ELSE '' END;

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
        v_joiner_label || ' wants to join your shared ride. The driver and primary rider must both approve.',
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
           v_joiner_label || ' asked to join your ride. The hosts are reviewing it.',
           p_ride_id, v_new_booking_id
    FROM ride_bookings rb
    WHERE rb.ride_id = p_ride_id
      AND rb.status = 'accepted'
      AND rb.id != v_new_booking_id
      AND rb.passenger_id <> v_ride.driver_id
      AND rb.passenger_id <> v_ride.primary_rider_id;
  END IF;

  RETURN QUERY SELECT v_new_booking_id, TRUE, v_reason, v_ride.available_seats - p_seats_requested;
END;
$$;

-- Same lockdown as the prior versions, re-asserted for the new signature.
revoke all on function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int, text[]
) from public;
grant execute on function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int, text[]
) to authenticated;
alter function public.book_pooled_ride(
  uuid, uuid, numeric, numeric, text, numeric, numeric, text, int, int, text[]
) security definer set search_path = public;

-- ─────────────────────────────────────────────────────────────
-- 4. get_ride_occupancy(ride_id): live occupancy in PEOPLE.
--    total_people_capacity = total_seats + 1 for car_pool (passenger
--    seats + the driver); = total_seats for ride_hail_share (the booker
--    declared the cab's total people capacity, everyone aboard
--    including the booker's party is a "passenger seat" user).
--    occupied_people = host slot + SUM(reserved seats), per the
--    DEFINITIONS above. seats_left never goes negative. status is
--    'open' while seats_left > 0, else 'full'.
--    co_riders[] = the people aboard or reserved: the host slot (only
--    when they hold no booking of their own) plus every active booking
--    with its party. Redaction mirrors get_ride_participants: in
--    ride_hail_share, a joiner's name / party_size / party_member_names
--    are hidden from non-host viewers ("Fellow rider"); hosts and the
--    joiner themself always see full details; car_pool never redacts.
--    Only ride participants may call this (0 rows otherwise) — the
--    same is_ride_participant gate the RLS policies use.
-- ─────────────────────────────────────────────────────────────
create or replace function public.get_ride_occupancy(
  p_ride_id uuid,
  p_viewer_id uuid default public.current_user_id()
)
returns table (
  ride_id uuid,
  total_people_capacity int,
  occupied_people int,
  seats_left int,
  status text,
  co_riders jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select id, driver_id, primary_rider_id, booked_by, ride_mode, total_seats
    from public.rides
    where id = p_ride_id
  ),
  active as (
    select rb.passenger_id, rb.role, rb.status, rb.seats_requested,
           rb.party_member_names, rb.created_at
    from public.ride_bookings rb
    where rb.ride_id = p_ride_id
      and rb.status in ('accepted', 'pending', 'pending_consent')
  ),
  hostslot as (
    select
      coalesce(r.driver_id, r.booked_by) as host_id,
      case when exists (
        select 1 from active a
        where a.passenger_id = coalesce(r.driver_id, r.booked_by)
      ) then 0 else 1 end as host_persons
    from r
  ),
  counts as (
    select
      coalesce((select sum(seats_requested) from active), 0)::int as current_people,
      (case when r.ride_mode = 'ride_hail_share'
            then r.total_seats
            else r.total_seats + 1 end)::int as capacity,
      hs.host_persons
    from r, hostslot hs
  ),
  metrics as (
    select
      c.capacity as total_people_capacity,
      (c.host_persons + c.current_people) as occupied_people,
      greatest(c.capacity - (c.host_persons + c.current_people), 0) as seats_left
    from counts c
  ),
  riders as (
    select coalesce(jsonb_strip_nulls(jsonb_agg(rid.orderable -> 'entry' order by rid.orderable ->> 'sort_key')), '[]'::jsonb) as co_riders
    from (
      -- Host slot row (only when the host isn't represented by their own booking).
      select jsonb_build_object(
        'sort_key', '0',
        'entry', jsonb_build_object(
          'user_id', hs.host_id,
          'role', case when r.driver_id is not null then 'host_driver' else 'booker' end,
          'display_name', u.display_name,
          'is_verified', coalesce(u.is_verified, false),
          'party_size', 1,
          'party_member_names', '[]'::jsonb,
          'status', 'accepted'
        )
      ) as orderable
      from r, hostslot hs
      join public.users u on u.id = hs.host_id
      where hs.host_persons = 1 and hs.host_id is not null

      union all

      -- One entry per active booking (a party = one entry, party_size > 1).
      select jsonb_build_object(
        'sort_key', '1',
        'entry', jsonb_build_object(
          'user_id', a.passenger_id,
          'role', coalesce(a.role, 'passenger_joiner'),
          'display_name', case when m.mask then 'Fellow rider' else u.display_name end,
          'is_verified', coalesce(u.is_verified, false),
          'party_size', case when m.mask then null else a.seats_requested end,
          'party_member_names', case when m.mask then null else to_jsonb(coalesce(a.party_member_names, '{}'::text[])) end,
          'status', a.status
        )
      ) as orderable
      from active a
      join public.users u on u.id = a.passenger_id
      cross join r
      cross join lateral (
        select (
          r.ride_mode = 'ride_hail_share'
          and coalesce(a.role, 'passenger_joiner') = 'passenger_joiner'
          and a.passenger_id <> p_viewer_id
          and not (
            p_viewer_id = r.driver_id
            or p_viewer_id = r.primary_rider_id
            or (r.booked_by is not null and p_viewer_id = r.booked_by)
          )
        ) as mask
      ) m
    ) rid
  )
  select r.id, mt.total_people_capacity, mt.occupied_people, mt.seats_left,
         case when mt.seats_left > 0 then 'open' else 'full' end,
         rd.co_riders
  from r, metrics mt, riders rd
  where public.is_ride_participant(p_ride_id, p_viewer_id);
$$;

revoke all on function public.get_ride_occupancy(uuid, uuid) from public;
grant execute on function public.get_ride_occupancy(uuid, uuid) to authenticated;
