-- Day 4 addition: a male_only preference pair, since the original 6 seed
-- rows (V1-V3) never exercised 'male_only' — which is exactly the branch
-- the RLS policy bug in 20260822000002 silently dropped.
-- Run after supabase/seed.sql.

INSERT INTO public.users (id, display_name, gender, auth_user_id)
VALUES
  ('10000000-0000-4000-8000-000000000007', 'V4 F-10 Male-Only Rider', 'male', null),
  ('10000000-0000-4000-8000-000000000008', 'V4 G-9 Male Rider', 'male', null)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  gender = EXCLUDED.gender;

INSERT INTO public.trip_requests (
  id, user_id,
  origin_lat, origin_lng, origin_address_label,
  destination_lat, destination_lng, destination_address_label,
  requested_departure_at, window_minutes, preference, status, expires_at
)
VALUES
  (
    '20000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000007',
    33.6844, 73.0479, 'F-10 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    '2026-08-22 08:05:00+05', 15, 'male_only', 'active',
    '2099-12-31 23:59:59+05'
  ),
  (
    '20000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    33.6880, 73.0250, 'G-9 Markaz',
    33.6484, 72.9922, 'NUST Gate 1',
    '2026-08-22 08:05:00+05', 15, 'any', 'active',
    '2099-12-31 23:59:59+05'
  )
ON CONFLICT (id) DO UPDATE SET
  origin_lat = EXCLUDED.origin_lat,
  origin_lng = EXCLUDED.origin_lng,
  status = EXCLUDED.status;
