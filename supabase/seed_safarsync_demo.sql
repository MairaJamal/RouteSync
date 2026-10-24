-- ─────────────────────────────────────────────────────────────
-- SafarSync — Phase 5 DEMO SEED (Islamabad ⇄ Rawalpindi)
--
-- Purpose: populate the pooled-ride surface built across Phases 1-4 so the
-- hackathon demo has believable data without clicking through a live match:
--   • car_pool ride in DUAL CONSENT (driver + primary rider) — Phase 2
--   • an in-app GROUP CHAT keyed by ride_id — Phase 1/3 (ride_messages)
--   • LIVE LOCATION sharing (who's sharing + current fixes) — Phase 1/3
--     (trip_tracking_state + live_locations)
--   • a ride_hail_share cab where joiner details are MASKED to fellow
--     riders by get_ride_participants() — Phase 1/3
--
-- RUN ORDER (this file is idempotent; re-run safely):
--   1. supabase/seed.sql                (base users 0001..0006 + the
--                                         'ebc53584…' Demo Commuter — see
--                                         COMPLETE_SETUP.sql "Seed Data")
--   2. migrations 20260822 … 20260909    (original pooling + safety + consent)
--   3. migrations 20261022000000/01/02  (SafarSync Phases 1-3)
--   4. supabase/seed_day4.sql, seed_day7.sql
--   5. THIS FILE
--
-- Users referenced: ebc53584-…-056bbe (Demo Commuter, has auth_user_id →
-- sign in as this to drive Ride A), and V-users 0001..0007 (no auth, used as
-- co-riders). All timestamps are relative to now() so departure stays in the
-- future and "live" fixes stay fresh on every re-run.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- RIDE A — car_pool morning run: F-8 Markaz → NUST Gate 1.
-- Driver = Demo Commuter (host). 0002 is the primary rider (2nd approver),
-- 0003 already accepted, 0004 is a NEW joiner parked in pending_consent whose
-- seat is reserved and whose two approvals (driver + primary) are still
-- 'awaiting' — the exact state PendingConsentsPanel is built to act on.
-- ─────────────────────────────────────────────────────────────
insert into public.rides (
  id, driver_id,
  origin_lat, origin_lng, origin_label,
  destination_lat, destination_lng, destination_label,
  departure_time, total_seats, available_seats,
  driver_max_co_passengers, status,
  ride_mode, primary_rider_id, booked_by
) values (
  '40000000-0000-4000-8000-000000000001',
  'ebc53584-8f5c-4148-8900-9e8afe056bbe',
  33.7050, 73.0380, 'F-8 Markaz',
  33.6484, 72.9922, 'NUST Gate 1',
  now() + interval '3 hours', 4, 1,
  3, 'active',
  'car_pool', '10000000-0000-4000-8000-000000000002', null
)
on conflict (id) do update set
  status = excluded.status,
  available_seats = excluded.available_seats,
  ride_mode = excluded.ride_mode,
  primary_rider_id = excluded.primary_rider_id,
  departure_time = excluded.departure_time;

-- Accepted bookings. 0002 is the host_rider (primary); 0003 a normal joiner.
insert into public.ride_bookings (
  id, ride_id, passenger_id,
  pickup_lat, pickup_lng, pickup_label,
  dropoff_lat, dropoff_lng, dropoff_label,
  seats_requested, max_co_passengers, status, role
) values
  (
    '41000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    33.6880, 73.0250, 'G-9 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    1, 3, 'accepted', 'host_rider'
  ),
  (
    '41000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    33.6844, 73.0479, 'F-10 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    1, 3, 'accepted', 'passenger_joiner'
  ),
  -- 0004's pending_consent booking reserves the 4th seat (4 − 3 = 1 … and the
  -- reserved seat is why available_seats is 1 above once it is accepted).
  (
    '41000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    33.7050, 73.0380, 'F-8 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    1, 3, 'pending_consent', 'passenger_joiner'
  )
on conflict (id) do update set
  status = excluded.status,
  role = excluded.role,
  expires_at = case
    when excluded.status = 'pending_consent' then now() + interval '25 minutes'
    else public.ride_bookings.expires_at end;

-- Move the pending booking's expiry forward on every re-run so the demo's
-- dual-consent window never sits stale/expired.
update public.ride_bookings
  set expires_at = now() + interval '25 minutes'
  where id = '41000000-0000-4000-8000-000000000003' and status = 'pending_consent';

-- DUAL CONSENT votes for 0004's join: exactly TWO approvers (driver + primary
-- rider), both still awaiting. The joiner (0004) does NOT vote; other accepted
-- riders (0003) do NOT vote — read-only notice only. This mirrors what
-- book_pooled_ride() writes after the Phase 2 rewrite.
insert into public.ride_consents (id, ride_id, booking_id, rider_id, status, requested_at) values
  (
    '42000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003',
    'ebc53584-8f5c-4148-8900-9e8afe056bbe',
    'awaiting', now() - interval '6 minutes'
  ),
  (
    '42000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    'awaiting', now() - interval '6 minutes'
  )
on conflict (booking_id, rider_id) do update set
  status = excluded.status,
  requested_at = excluded.requested_at;

-- GROUP CHAT for Ride A between the already-accepted members.
insert into public.ride_messages (id, ride_id, sender_id, body, created_at) values
  (
    '43000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'ebc53584-8f5c-4148-8900-9e8afe056bbe',
    'Assalam-o-Alaikum! Leaving F-8 Markaz in ~5 minutes.',
    now() - interval '12 minutes'
  ),
  (
    '43000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'Perfect — I''m at the G-9 Markaz gate, white helmet.',
    now() - interval '9 minutes'
  ),
  (
    '43000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    'On my way from F-10, see you both shortly 🙏',
    now() - interval '4 minutes'
  )
on conflict (id) do update set body = excluded.body, created_at = excluded.created_at;

-- LIVE LOCATION: driver + primary rider are actively sharing; 0003 is not.
-- trip_tracking_state.sharing drives "who appears on the map"; the GET
-- /locations endpoint hides anyone whose toggle is off.
insert into public.trip_tracking_state (ride_id, user_id, sharing, started_at, stopped_at) values
  (
    '40000000-0000-4000-8000-000000000001',
    'ebc53584-8f5c-4148-8900-9e8afe056bbe',
    true, now() - interval '11 minutes', null
  ),
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    true, now() - interval '8 minutes', null
  )
on conflict (ride_id, user_id) do update set
  sharing = excluded.sharing,
  started_at = excluded.started_at,
  stopped_at = null;

insert into public.live_locations (ride_id, user_id, lat, lng, accuracy, heading, updated_at) values
  (
    '40000000-0000-4000-8000-000000000001',
    'ebc53584-8f5c-4148-8900-9e8afe056bbe',
    33.7012, 73.0331, 11.0, 198.0, now() - interval '20 seconds'
  ),
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    33.6880, 73.0250, 7.0, 205.0, now() - interval '35 seconds'
  )
on conflict (ride_id, user_id) do update set
  lat = excluded.lat, lng = excluded.lng,
  accuracy = excluded.accuracy, heading = excluded.heading,
  updated_at = excluded.updated_at;

-- ─────────────────────────────────────────────────────────────
-- RIDE B — ride_hail_share (a booked Yango cab split by km):
-- Blue Area → Saddar, Rawalpindi. 0005 booked the cab (driver + booked_by,
-- no primary rider), so 0005 sees everyone's details; 0001 and 0007 are
-- fellow joiners whom get_ride_participants() MASKS to "Fellow rider" for
-- EACH OTHER (ride_hail_share + passenger_joiner + non-host viewer). 0004 is
-- a pending_consent joiner whose single approval is 0005 — demonstrating the
-- Phase 2 fold (primary rider null → approvers collapse to the driver only).
-- ─────────────────────────────────────────────────────────────
insert into public.rides (
  id, driver_id,
  origin_lat, origin_lng, origin_label,
  destination_lat, destination_lng, destination_label,
  departure_time, total_seats, available_seats,
  driver_max_co_passengers, status,
  ride_mode, primary_rider_id, booked_by
) values (
  '40000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000005',
  33.5978, 73.0459, 'Blue Area',
  33.5704, 73.0043, 'Saddar',
  now() + interval '2 hours', 4, 1,
  3, 'active',
  'ride_hail_share', null, '10000000-0000-4000-8000-000000000005'
)
on conflict (id) do update set
  status = excluded.status,
  available_seats = excluded.available_seats,
  ride_mode = excluded.ride_mode,
  booked_by = excluded.booked_by,
  departure_time = excluded.departure_time;

insert into public.ride_bookings (
  id, ride_id, passenger_id,
  pickup_lat, pickup_lng, pickup_label,
  dropoff_lat, dropoff_lng, dropoff_label,
  seats_requested, max_co_passengers, status, role
) values
  (
    '41000000-0000-4000-8000-000000000011',
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    33.5978, 73.0459, 'Blue Area',
    33.5704, 73.0043, 'Saddar',
    1, 3, 'accepted', 'passenger_joiner'
  ),
  (
    '41000000-0000-4000-8000-000000000012',
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000007',
    33.5810, 73.0200, 'Race Course',
    33.5704, 73.0043, 'Saddar',
    1, 3, 'accepted', 'passenger_joiner'
  ),
  (
    '41000000-0000-4000-8000-000000000013',
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000004',
    33.5904, 73.0409, 'F-6 Markaz',
    33.5704, 73.0043, 'Saddar',
    1, 3, 'pending_consent', 'passenger_joiner'
  )
on conflict (id) do update set
  status = excluded.status,
  role = excluded.role;

update public.ride_bookings
  set expires_at = now() + interval '25 minutes'
  where id = '41000000-0000-4000-8000-000000000013' and status = 'pending_consent';

-- Ride B's pending joiner needs only ONE approval (the booker/driver), because
-- primary_rider_id is null → the dual-consent approver set folds to {driver}.
insert into public.ride_consents (id, ride_id, booking_id, rider_id, status, requested_at) values
  (
    '42000000-0000-4000-8000-000000000011',
    '40000000-0000-4000-8000-000000000002',
    '41000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000005',
    'awaiting', now() - interval '3 minutes'
  )
on conflict (booking_id, rider_id) do update set
  status = excluded.status,
  requested_at = excluded.requested_at;

-- Ride B group chat (the booker coordinates the split).
insert into public.ride_messages (id, ride_id, sender_id, body, created_at) values
  (
    '43000000-0000-4000-8000-000000000011',
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005',
    'Cab booked on Yango, ETA 6 min. Fare split by km each of us rides.',
    now() - interval '5 minutes'
  ),
  (
    '43000000-0000-4000-8000-000000000012',
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'At the Blue Area stop, yellow shelter. 👍',
    now() - interval '2 minutes'
  )
on conflict (id) do update set body = excluded.body, created_at = excluded.created_at;

-- Ride B: the booker is live-sharing so a member opening the ride sees a pin.
insert into public.trip_tracking_state (ride_id, user_id, sharing, started_at, stopped_at) values
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005',
    true, now() - interval '4 minutes', null
  )
on conflict (ride_id, user_id) do update set
  sharing = excluded.sharing,
  started_at = excluded.started_at,
  stopped_at = null;

insert into public.live_locations (ride_id, user_id, lat, lng, accuracy, heading, updated_at) values
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005',
    33.5965, 73.0430, 14.0, 220.0, now() - interval '25 seconds'
  )
on conflict (ride_id, user_id) do update set
  lat = excluded.lat, lng = excluded.lng,
  accuracy = excluded.accuracy, heading = excluded.heading,
  updated_at = excluded.updated_at;

-- ─────────────────────────────────────────────────────────────
-- Done. To see it end-to-end: sign in as the Demo Commuter (ebc53584…) and
-- open Ride A from the dashboard — dual-consent pending (0004), the group
-- chat, and the two live pins all render. Sign in as 0005's counterpart to
-- watch a fellow rider get masked to "Fellow rider" on Ride B (ride_hail_share).
-- ─────────────────────────────────────────────────────────────
