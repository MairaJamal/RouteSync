-- Day 7 demo seed. Run AFTER the four 20260901_* migrations and the
-- original seed.sql (users 10000000-...-0001..0006 must exist).
-- Idempotent: every statement carries an ON CONFLICT branch.

-- ─── Verified profiles (Feature 3) ──────────────────────────
-- Real Auth signups earn the badge automatically via POST
-- /api/verify-student; seeded users have no auth email, so the demo
-- flips the flag directly for a believable badge/filter showcase.
update public.users set is_verified = true, verified_domain = 'comsats.edu.pk'
  where id = '10000000-0000-4000-8000-000000000002';
update public.users set is_verified = true, verified_domain = 'nust.edu.pk'
  where id = '10000000-0000-4000-8000-000000000003';
update public.users set is_verified = true, verified_domain = 'qau.edu.pk'
  where id = '10000000-0000-4000-8000-000000000006';

-- ─── Completed rides to power the rating flow (Feature 4) ───
insert into public.rides (
  id, driver_id,
  origin_lat, origin_lng, origin_label,
  destination_lat, destination_lng, destination_label,
  departure_time, total_seats, available_seats, status
) values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    33.6844, 73.0479, 'F-10 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    '2026-08-30 08:00:00+05', 4, 2, 'completed'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005',
    33.6844, 73.0479, 'F-10 Markaz',
    33.7007, 73.0578, 'Centaurus Mall',
    '2026-08-31 18:00:00+05', 4, 3, 'completed'
  )
on conflict (id) do update set status = excluded.status;

insert into public.ride_bookings (
  id, ride_id, passenger_id,
  pickup_lat, pickup_lng, pickup_label,
  dropoff_lat, dropoff_lng, dropoff_label,
  seats_requested, max_co_passengers, status
) values
  (
    '31000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    33.6880, 73.0250, 'G-9 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    1, 3, 'completed'
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    33.6844, 73.0479, 'F-10 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    1, 3, 'completed'
  ),
  (
    '31000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    33.6844, 73.0479, 'F-10 Markaz',
    33.7007, 73.0578, 'Centaurus Mall',
    1, 3, 'completed'
  )
on conflict (id) do update set status = excluded.status;

-- ─── Ratings (Feature 4) ────────────────────────────────────
-- Averages after this seed: user 0001 -> 4.5 (2), 0002 -> 4.5 (2),
-- 0003 -> 4.0 (1), 0005 -> 5.0 (1). Users 0004/0006 stay unrated so
-- the "No ratings yet" state is also demonstrable.
insert into public.ratings (ride_id, rater_id, rated_user_id, stars, comment) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', 5, 'On time, smooth driving.'),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 4, null),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', 5, 'Great co-rider, easy pickup.'),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000003', 4, null),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000005',
   '10000000-0000-4000-8000-000000000002', 4, null),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000005', 5, 'Very polite.')
on conflict (ride_id, rater_id, rated_user_id) do update set stars = excluded.stars;

-- ─── One emergency contact for the demo user (Feature 2) ────
insert into public.emergency_contacts (id, user_id, contact_name, contact_phone)
values (
  '32000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Ammi',
  '+923001234567'
)
on conflict (id) do update set contact_name = excluded.contact_name;
