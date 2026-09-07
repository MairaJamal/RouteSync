-- Day 4: Deep System Debugging fixes.
-- Run after 20260822000002_rls_policies.sql.

-- ─────────────────────────────────────────────────────────────
-- BUG 1: Duplicate find_matching_trip_requests() RPC.
--
-- 20260822000000 defines find_matching_trip_requests(p_trip_request_id uuid,
-- p_limit integer) with real route-overlap scoring (>=75% threshold).
-- 20260822000001 defines a DIFFERENT overload,
-- find_matching_trip_requests(target_request_id uuid) — bounding-box +
-- gender only, no overlap scoring at all. Postgres allows both to coexist
-- as overloads. Any caller that invokes the RPC positionally with a single
-- argument (e.g. supabase.rpc('find_matching_trip_requests', { p: id }) with
-- the wrong param name, or a raw `select * from find_matching_trip_requests(id)`)
-- silently gets the weaker version with no overlap threshold at all, i.e.
-- users would see "matches" with 0% actual route overlap.
--
-- Fix: drop the single-argument overload. The full version stays as the
-- one and only find_matching_trip_requests RPC.
-- ─────────────────────────────────────────────────────────────

drop function if exists public.find_matching_trip_requests(uuid);

-- ─────────────────────────────────────────────────────────────
-- BUG 2: trip_requests_mutual_gender_select RLS policy drops 'male_only'.
--
-- The USING clause only branches on preference = 'any' or 'female_only'.
-- A request with preference = 'male_only' matches neither branch, so it
-- becomes invisible to every authenticated user — including its own owner,
-- since the policy this replaced (trip_requests_select_own, an
-- owner-always-sees-their-own-rows policy) was dropped and never restored.
--
-- Fix: add the missing male_only branch, AND restore owner visibility as an
-- explicit OR clause so a user can always see their own trip requests
-- regardless of gender-compatibility math.
-- ─────────────────────────────────────────────────────────────

drop policy if exists trip_requests_mutual_gender_select on public.trip_requests;
create policy trip_requests_mutual_gender_select
on public.trip_requests
for select
to authenticated
using (
  -- Owners can always see their own requests.
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.users as owner_profile
    join public.users as viewer_profile
      on viewer_profile.auth_user_id = auth.uid()
    where owner_profile.id = trip_requests.user_id
      and (
        trip_requests.preference = 'any'
        or (
          trip_requests.preference = 'female_only'
          and viewer_profile.gender = 'female'::public.gender
          and owner_profile.gender = 'female'::public.gender
        )
        or (
          trip_requests.preference = 'male_only'
          and viewer_profile.gender = 'male'::public.gender
          and owner_profile.gender = 'male'::public.gender
        )
      )
  )
);

-- ─────────────────────────────────────────────────────────────
-- BUG 3 (performance): is_within_bounding_box() filters on origin_lat/
-- origin_lng/destination_lat/destination_lng directly, but only
-- (status, expires_at), (requested_departure_at), and (user_id) are
-- indexed. On the seed data this is invisible; at pool scale the coarse
-- prefilter in find_matching_trip_requests would sequential-scan active
-- trip_requests instead of using an index, missing the <200ms target.
-- ─────────────────────────────────────────────────────────────

create index if not exists trip_requests_origin_coords_idx
  on public.trip_requests (origin_lat, origin_lng)
  where status = 'active';

create index if not exists trip_requests_destination_coords_idx
  on public.trip_requests (destination_lat, destination_lng)
  where status = 'active';

-- ─────────────────────────────────────────────────────────────
-- Verification queries (run manually, not part of the migration):
--
-- 1. Confirm only one overload remains:
--   select proname, pg_get_function_arguments(oid)
--   from pg_proc where proname = 'find_matching_trip_requests';
--   -- should return exactly 1 row
--
-- 2. Confirm a male_only owner can see their own request (run as that
--    user via a Supabase client using their JWT, not the service role key).
--
-- 3. EXPLAIN ANALYZE the coarse candidate CTE in find_matching_trip_requests
--    against the seeded 6 rows plus a synthetic larger batch to confirm
--    the new partial indexes are picked up (Bitmap Index Scan, not Seq Scan).
-- ─────────────────────────────────────────────────────────────
