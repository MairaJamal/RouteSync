-- ========================================================
-- ROUTEMATE COMPLETE SUPABASE DATABASE SETUP
-- Paste and run this entire file in Supabase SQL Editor
-- ========================================================


-- ========================================================
-- Migration: 20260822000000_trip_matching.sql
-- ========================================================

-- Trip matching schema for Supabase.
-- Coordinates are deliberately stored and passed as named scalar values:
-- origin_lat, origin_lng, destination_lat, and destination_lng.

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'gender') then
    create type public.gender as enum ('male', 'female', 'non_binary');
  end if;

  if not exists (select 1 from pg_type where typname = 'match_status') then
    create type public.match_status as enum (
      'pending',
      'accepted',
      'rejected',
      'expired',
      'cancelled'
    );
  end if;
end
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  gender public.gender not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.trip_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  origin_lat numeric(8, 5) not null check (origin_lat between -90 and 90),
  origin_lng numeric(8, 5) not null check (origin_lng between -180 and 180),
  origin_address_label text not null check (length(trim(origin_address_label)) between 1 and 200),
  destination_lat numeric(8, 5) not null check (destination_lat between -90 and 90),
  destination_lng numeric(8, 5) not null check (destination_lng between -180 and 180),
  destination_address_label text not null check (length(trim(destination_address_label)) between 1 and 200),
  requested_departure_at timestamptz not null,
  window_minutes integer not null default 15 check (window_minutes between 0 and 240),
  preference text not null default 'any'
    check (preference in ('any', 'female_only', 'male_only')),
  status text not null default 'active'
    check (status in ('active', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (origin_lat <> destination_lat or origin_lng <> destination_lng)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  trip_request_id uuid not null references public.trip_requests(id) on delete cascade,
  candidate_trip_request_id uuid not null references public.trip_requests(id) on delete cascade,
  status public.match_status not null default 'pending',
  overlap_pct numeric(5, 2) not null check (overlap_pct between 0 and 100),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (trip_request_id <> candidate_trip_request_id),
  unique (trip_request_id, candidate_trip_request_id)
);

create table if not exists public.fare_estimates (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  currency char(3) not null default 'PKR' check (currency ~ '^[A-Z]{3}$'),
  provider text not null default 'internal',
  breakdown jsonb not null default '{}'::jsonb,
  estimated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  unique (match_id)
);

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists trip_requests_set_updated_at on public.trip_requests;
create trigger trip_requests_set_updated_at
before update on public.trip_requests
for each row execute function public.set_updated_at();

drop trigger if exists matches_set_updated_at on public.matches;
create trigger matches_set_updated_at
before update on public.matches
for each row execute function public.set_updated_at();

create index if not exists trip_requests_active_expiry_idx
  on public.trip_requests (status, expires_at)
  where status = 'active';

create index if not exists trip_requests_departure_idx
  on public.trip_requests (requested_departure_at);

create index if not exists trip_requests_user_idx
  on public.trip_requests (user_id);

create index if not exists matches_trip_request_idx
  on public.matches (trip_request_id, status);

create index if not exists matches_candidate_request_idx
  on public.matches (candidate_trip_request_id, status);

-- Fast scalar bounding-box test. The default is the requested +/- 0.02 degree
-- latitude/longitude search window.
create or replace function public.is_within_bounding_box(
  p_lat numeric,
  p_lng numeric,
  p_center_lat numeric,
  p_center_lng numeric,
  p_lat_delta numeric default 0.02,
  p_lng_delta numeric default 0.02
)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    p_lat between p_center_lat - p_lat_delta and p_center_lat + p_lat_delta
    and p_lng between p_center_lng - p_lng_delta and p_center_lng + p_lng_delta;
$$;

-- Named time-window filtering, including each request's flexible departure
-- interval rather than comparing only the nominal departure timestamps.
create or replace function public.time_windows_overlap(
  p_first_departure_at timestamptz,
  p_first_window_minutes integer,
  p_second_departure_at timestamptz,
  p_second_window_minutes integer
)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    p_first_departure_at
      <= p_second_departure_at + make_interval(mins => p_second_window_minutes)
    and p_second_departure_at
      <= p_first_departure_at + make_interval(mins => p_first_window_minutes);
$$;

create or replace function public.gender_preference_allows(
  p_preference text,
  p_candidate_gender public.gender
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case p_preference
    when 'any' then true
    when 'female_only' then p_candidate_gender = 'female'::public.gender
    when 'male_only' then p_candidate_gender = 'male'::public.gender
    else false
  end;
$$;

-- This is deliberately symmetric: both people must accept the other person's
-- gender. Preferences belong to trip requests, so request IDs are used here
-- rather than inferring a preference from an arbitrary active request.
create or replace function public.are_trip_requests_gender_compatible(
  p_first_trip_request_id uuid,
  p_second_trip_request_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select
        public.gender_preference_allows(first_request.preference, second_person.gender)
        and public.gender_preference_allows(second_request.preference, first_person.gender)
      from public.trip_requests as first_request
      join public.trip_requests as second_request
        on second_request.id = p_second_trip_request_id
      join public.users as first_person
        on first_person.id = first_request.user_id
      join public.users as second_person
        on second_person.id = second_request.user_id
      where first_request.id = p_first_trip_request_id
        and first_request.status = 'active'
        and second_request.status = 'active'
    ),
    false
  );
$$;

-- Samples both straight-line routes at equal progress. A route sample is
-- considered overlapping when it is within the same named scalar bounding box.
-- This provides a deterministic, extension-free approximation suitable for
-- matching before a road-routing provider is consulted.
create or replace function public.route_overlap_percentage(
  p_first_origin_lat numeric,
  p_first_origin_lng numeric,
  p_first_destination_lat numeric,
  p_first_destination_lng numeric,
  p_second_origin_lat numeric,
  p_second_origin_lng numeric,
  p_second_destination_lat numeric,
  p_second_destination_lng numeric,
  p_lat_delta numeric default 0.02,
  p_lng_delta numeric default 0.02
)
returns numeric
language sql
immutable
parallel safe
as $$
  with progress as (
    select sample_index, sample_index::numeric / 20 as fraction
    from generate_series(0, 20) as sample(sample_index)
  ),
  first_samples as (
    select
      p_first_origin_lat
        + ((p_first_destination_lat - p_first_origin_lat) * fraction) as lat,
      p_first_origin_lng
        + ((p_first_destination_lng - p_first_origin_lng) * fraction) as lng,
      fraction
    from progress
  ),
  second_samples as (
    select
      p_second_origin_lat
        + ((p_second_destination_lat - p_second_origin_lat) * fraction) as lat,
      p_second_origin_lng
        + ((p_second_destination_lng - p_second_origin_lng) * fraction) as lng,
      fraction
    from progress
  ),
  directed_overlap as (
    select count(*) filter (
      where public.is_within_bounding_box(
        first_sample.lat,
        first_sample.lng,
        second_sample.lat,
        second_sample.lng,
        p_lat_delta,
        p_lng_delta
      )
    ) as first_in_second,
    count(*) filter (
      where public.is_within_bounding_box(
        second_sample.lat,
        second_sample.lng,
        first_sample.lat,
        first_sample.lng,
        p_lat_delta,
        p_lng_delta
      )
    ) as second_in_first
    from first_samples as first_sample
    join second_samples as second_sample
      on first_sample.fraction = second_sample.fraction
  )
  select round(((first_in_second + second_in_first)::numeric / 42) * 100, 2)
  from directed_overlap;
$$;

create or replace function public.is_trip_request_owner(
  p_trip_request_id uuid,
  p_auth_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.trip_requests as request
    join public.users as person on person.id = request.user_id
    where request.id = p_trip_request_id
      and (person.id = p_auth_user_id or person.auth_user_id = p_auth_user_id)
  );
$$;

create or replace function public.is_match_participant(
  p_match_id uuid,
  p_auth_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.matches as match_row
    where match_row.id = p_match_id
      and (
        public.is_trip_request_owner(match_row.trip_request_id, p_auth_user_id)
        or public.is_trip_request_owner(match_row.candidate_trip_request_id, p_auth_user_id)
      )
  );
$$;

-- The main matching RPC. The coarse candidate filter can use the scalar
-- coordinate indexes/columns before the route sampling work is performed.
create or replace function public.find_matching_trip_requests(
  p_trip_request_id uuid,
  p_limit integer default 50
)
returns table (
  candidate_request_id uuid,
  candidate_user_id uuid,
  candidate_display_name text,
  candidate_gender public.gender,
  candidate_preference text,
  candidate_departure_at timestamptz,
  route_overlap_pct numeric,
  origin_lat numeric,
  origin_lng numeric,
  destination_lat numeric,
  destination_lng numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with requester as (
    select
      request.id,
      request.user_id,
      request.origin_lat,
      request.origin_lng,
      request.destination_lat,
      request.destination_lng,
      request.requested_departure_at,
      request.window_minutes,
      request.preference,
      person.gender
    from public.trip_requests as request
    join public.users as person on person.id = request.user_id
    where request.id = p_trip_request_id
      and (
        auth.uid() is null
        or public.is_trip_request_owner(request.id)
      )
      and request.status = 'active'
      and request.expires_at > timezone('utc', now())
  ),
  coarse_candidates as (
    select
      candidate_request.id as candidate_request_id,
      candidate_request.user_id as candidate_user_id,
      candidate_request.origin_lat as candidate_origin_lat,
      candidate_request.origin_lng as candidate_origin_lng,
      candidate_request.destination_lat as candidate_destination_lat,
      candidate_request.destination_lng as candidate_destination_lng,
      candidate_request.requested_departure_at as candidate_departure_at,
      candidate_request.window_minutes as candidate_window_minutes,
      candidate_request.preference as candidate_preference,
      candidate_person.display_name as candidate_display_name,
      candidate_person.gender as candidate_gender,
      requester.origin_lat as requester_origin_lat,
      requester.origin_lng as requester_origin_lng,
      requester.destination_lat as requester_destination_lat,
      requester.destination_lng as requester_destination_lng
    from requester
    join public.trip_requests as candidate_request
      on candidate_request.id <> requester.id
     and candidate_request.status = 'active'
     and candidate_request.expires_at > timezone('utc', now())
     and public.time_windows_overlap(
       requester.requested_departure_at,
       requester.window_minutes,
       candidate_request.requested_departure_at,
       candidate_request.window_minutes
     )
     and (
       public.is_within_bounding_box(
         candidate_request.origin_lat,
         candidate_request.origin_lng,
         requester.origin_lat,
         requester.origin_lng
       )
       or public.is_within_bounding_box(
         candidate_request.destination_lat,
         candidate_request.destination_lng,
         requester.destination_lat,
         requester.destination_lng
       )
     )
    join public.users as candidate_person
      on candidate_person.id = candidate_request.user_id
    where public.gender_preference_allows(requester.preference, candidate_person.gender)
      and public.gender_preference_allows(candidate_request.preference, requester.gender)
  )
  select
    coarse_candidates.candidate_request_id,
    coarse_candidates.candidate_user_id,
    coarse_candidates.candidate_display_name,
    coarse_candidates.candidate_gender,
    coarse_candidates.candidate_preference,
    coarse_candidates.candidate_departure_at,
    route.route_overlap_pct,
    coarse_candidates.candidate_origin_lat as origin_lat,
    coarse_candidates.candidate_origin_lng as origin_lng,
    coarse_candidates.candidate_destination_lat as destination_lat,
    coarse_candidates.candidate_destination_lng as destination_lng
  from coarse_candidates
  cross join lateral (
    select public.route_overlap_percentage(
      coarse_candidates.requester_origin_lat,
      coarse_candidates.requester_origin_lng,
      coarse_candidates.requester_destination_lat,
      coarse_candidates.requester_destination_lng,
      coarse_candidates.candidate_origin_lat,
      coarse_candidates.candidate_origin_lng,
      coarse_candidates.candidate_destination_lat,
      coarse_candidates.candidate_destination_lng
    ) as route_overlap_pct
  ) as route
  where route.route_overlap_pct >= 50
  order by route.route_overlap_pct desc, coarse_candidates.candidate_departure_at
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

create or replace function public.enforce_match_gender_compatibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.are_trip_requests_gender_compatible(
    new.trip_request_id,
    new.candidate_trip_request_id
  ) is not true then
    raise exception using
      errcode = 'check_violation',
      message = 'MUTUAL_GENDER_MISMATCH',
      detail = 'Both trip-request preferences must allow the other user gender.';
  end if;
  return new;
end;
$$;

drop trigger if exists matches_enforce_gender_compatibility on public.matches;
create trigger matches_enforce_gender_compatibility
before insert or update of trip_request_id, candidate_trip_request_id
on public.matches
for each row execute function public.enforce_match_gender_compatibility();

alter table public.users enable row level security;
alter table public.trip_requests enable row level security;
alter table public.matches enable row level security;
alter table public.fare_estimates enable row level security;

drop policy if exists users_select_own on public.users;
create policy users_select_own
on public.users for select to authenticated
using (id = auth.uid() or auth_user_id = auth.uid());

drop policy if exists users_insert_own on public.users;
create policy users_insert_own
on public.users for insert to authenticated
with check (id = auth.uid() or auth_user_id = auth.uid());

drop policy if exists users_update_own on public.users;
create policy users_update_own
on public.users for update to authenticated
using (id = auth.uid() or auth_user_id = auth.uid())
with check (id = auth.uid() or auth_user_id = auth.uid());

drop policy if exists trip_requests_select_own on public.trip_requests;
create policy trip_requests_select_own
on public.trip_requests for select to authenticated
using (public.is_trip_request_owner(id));

drop policy if exists trip_requests_insert_own on public.trip_requests;
create policy trip_requests_insert_own
on public.trip_requests for insert to authenticated
with check (
  exists (
    select 1
    from public.users as person
    where person.id = user_id
      and (person.id = auth.uid() or person.auth_user_id = auth.uid())
  )
);

drop policy if exists trip_requests_update_own on public.trip_requests;
create policy trip_requests_update_own
on public.trip_requests for update to authenticated
using (public.is_trip_request_owner(id))
with check (public.is_trip_request_owner(id));

drop policy if exists trip_requests_delete_own on public.trip_requests;
create policy trip_requests_delete_own
on public.trip_requests for delete to authenticated
using (public.is_trip_request_owner(id));

drop policy if exists matches_select_participant on public.matches;
create policy matches_select_participant
on public.matches for select to authenticated
using (public.is_match_participant(id));

drop policy if exists matches_insert_compatible_participant on public.matches;
create policy matches_insert_compatible_participant
on public.matches for insert to authenticated
with check (
  (
    public.is_trip_request_owner(trip_request_id)
    or public.is_trip_request_owner(candidate_trip_request_id)
  )
  and public.are_trip_requests_gender_compatible(
    trip_request_id,
    candidate_trip_request_id
  )
);

drop policy if exists matches_update_compatible_participant on public.matches;
create policy matches_update_compatible_participant
on public.matches for update to authenticated
using (public.is_match_participant(id))
with check (
  public.is_match_participant(id)
  and public.are_trip_requests_gender_compatible(
    trip_request_id,
    candidate_trip_request_id
  )
);

drop policy if exists matches_delete_participant on public.matches;
create policy matches_delete_participant
on public.matches for delete to authenticated
using (public.is_match_participant(id));

drop policy if exists fare_estimates_select_participant on public.fare_estimates;
create policy fare_estimates_select_participant
on public.fare_estimates for select to authenticated
using (public.is_match_participant(match_id));

drop policy if exists fare_estimates_insert_participant on public.fare_estimates;
create policy fare_estimates_insert_participant
on public.fare_estimates for insert to authenticated
with check (public.is_match_participant(match_id));

drop policy if exists fare_estimates_update_participant on public.fare_estimates;
create policy fare_estimates_update_participant
on public.fare_estimates for update to authenticated
using (public.is_match_participant(match_id))
with check (public.is_match_participant(match_id));

grant execute on function public.is_within_bounding_box(
  numeric, numeric, numeric, numeric, numeric, numeric
) to authenticated;
grant execute on function public.time_windows_overlap(
  timestamptz, integer, timestamptz, integer
) to authenticated;
grant execute on function public.find_matching_trip_requests(uuid, integer) to authenticated;

-- Security-definer helpers are implementation details of the authenticated
-- policies/RPC, not anonymous data-discovery endpoints.
revoke all on function public.are_trip_requests_gender_compatible(uuid, uuid) from public;
revoke all on function public.is_trip_request_owner(uuid, uuid) from public;
revoke all on function public.is_match_participant(uuid, uuid) from public;
grant execute on function public.are_trip_requests_gender_compatible(uuid, uuid) to authenticated;
grant execute on function public.is_trip_request_owner(uuid, uuid) to authenticated;
grant execute on function public.is_match_participant(uuid, uuid) to authenticated;

-- ========================================================
-- Migration: 20260822000001_spatial_matching.sql
-- ========================================================

-- Spatial and time-window matching RPC.
-- Coordinate values remain named scalar columns and parameters throughout.

create or replace function public.find_matching_trip_requests(
  target_request_id uuid
)
returns table (
  matched_request_id uuid,
  matched_user_id uuid,
  matched_display_name text,
  matched_gender public.gender,
  matched_preference text,
  origin_lat numeric,
  origin_lng numeric,
  origin_address_label text,
  destination_lat numeric,
  destination_lng numeric,
  destination_address_label text,
  requested_departure_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target_request public.trip_requests%rowtype;
  target_user public.users%rowtype;
begin
  select request.*
  into target_request
  from public.trip_requests as request
  where request.id = target_request_id;

  if not found then
    return;
  end if;

  select person.*
  into target_user
  from public.users as person
  where person.id = target_request.user_id;

  if not found then
    return;
  end if;

  -- Authenticated callers may only search from their own request. A NULL
  -- auth.uid() is reserved for trusted service-role/SQL-editor execution.
  if auth.uid() is not null and target_user.auth_user_id is distinct from auth.uid() then
    return;
  end if;

  return query
  select
    candidate_request.id as matched_request_id,
    candidate_request.user_id as matched_user_id,
    candidate_user.display_name as matched_display_name,
    candidate_user.gender as matched_gender,
    candidate_request.preference as matched_preference,
    candidate_request.origin_lat,
    candidate_request.origin_lng,
    candidate_request.origin_address_label,
    candidate_request.destination_lat,
    candidate_request.destination_lng,
    candidate_request.destination_address_label,
    candidate_request.requested_departure_at
  from public.trip_requests as candidate_request
  join public.users as candidate_user
    on candidate_user.id = candidate_request.user_id
  where candidate_request.id <> target_request.id
    and candidate_request.status = 'active'
    and candidate_request.expires_at > timezone('utc', now())
    and candidate_request.requested_departure_at between
      target_request.requested_departure_at
        - make_interval(mins => target_request.window_minutes)
      and target_request.requested_departure_at
        + make_interval(mins => target_request.window_minutes)
    and public.is_within_bounding_box(
      candidate_request.origin_lat,
      candidate_request.origin_lng,
      target_request.origin_lat,
      target_request.origin_lng,
      0.02,
      0.02
    )
    and public.is_within_bounding_box(
      candidate_request.destination_lat,
      candidate_request.destination_lng,
      target_request.destination_lat,
      target_request.destination_lng,
      0.02,
      0.02
    )
    and (
      (
        target_request.preference = 'any'
        and candidate_request.preference = 'any'
      )
      or (
        target_request.preference = 'female_only'
        and target_user.gender = 'female'::public.gender
        and candidate_user.gender = 'female'::public.gender
      )
      or (
        candidate_request.preference = 'female_only'
        and target_user.gender = 'female'::public.gender
        and candidate_user.gender = 'female'::public.gender
      )
    )
  order by candidate_request.requested_departure_at, candidate_request.id;
end;
$$;

revoke all on function public.find_matching_trip_requests(uuid) from public;
grant execute on function public.find_matching_trip_requests(uuid) to authenticated;

-- ========================================================
-- Migration: 20260822000002_rls_policies.sql
-- ========================================================

-- Requested RLS policies for profile visibility, trip-request ownership,
-- and database-level mutual gender compatibility.

alter table public.users enable row level security;
alter table public.trip_requests enable row level security;
alter table public.matches enable row level security;
alter table public.fare_estimates enable row level security;

-- Replace the earlier own-profile-only policy: authenticated users may view
-- profiles, while only the linked auth user may update a profile.
drop policy if exists users_select_own on public.users;
drop policy if exists users_authenticated_select on public.users;
create policy users_authenticated_select
on public.users
for select
to authenticated
using (true);

drop policy if exists users_update_own on public.users;
drop policy if exists users_update_by_auth_user on public.users;
create policy users_update_by_auth_user
on public.users
for update
to authenticated
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

-- The SELECT policy performs the gender compatibility check against the
-- viewer's profile and the request owner's profile inside the database.
drop policy if exists trip_requests_select_own on public.trip_requests;
drop policy if exists trip_requests_mutual_gender_select on public.trip_requests;
create policy trip_requests_mutual_gender_select
on public.trip_requests
for select
to authenticated
using (
  exists (
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
      )
  )
);

drop policy if exists trip_requests_insert_own on public.trip_requests;
drop policy if exists trip_requests_insert_by_auth_user on public.trip_requests;
create policy trip_requests_insert_by_auth_user
on public.trip_requests
for insert
to authenticated
with check (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists trip_requests_update_own on public.trip_requests;
drop policy if exists trip_requests_update_by_auth_user on public.trip_requests;
create policy trip_requests_update_by_auth_user
on public.trip_requests
for update
to authenticated
using (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists trip_requests_delete_by_auth_user on public.trip_requests;
create policy trip_requests_delete_by_auth_user
on public.trip_requests
for delete
to authenticated
using (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- ========================================================
-- Migration: 20260824000000_day4_fixes.sql
-- ========================================================

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


-- ========================================================
-- Migration: 20260825000000_pooling_capacity.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Migration: Flexible Ride-Pooling Capacity Preferences & Concurrency
-- Adds driver_max_co_passengers, RideBooking max_co_passengers,
-- default_max_co_passengers on users, and atomic row-locking RPC.
-- ─────────────────────────────────────────────────────────────

-- 1. Add default_max_co_passengers to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS default_max_co_passengers INT DEFAULT 3;

-- 2. Create rides table if not existing (or alter)
CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID REFERENCES users(id) ON DELETE CASCADE,
  origin_lat NUMERIC(9,6) NOT NULL,
  origin_lng NUMERIC(9,6) NOT NULL,
  origin_label TEXT,
  destination_lat NUMERIC(9,6) NOT NULL,
  destination_lng NUMERIC(9,6) NOT NULL,
  destination_label TEXT,
  departure_time TIMESTAMP WITH TIME ZONE NOT NULL,
  total_seats INT NOT NULL DEFAULT 4,
  available_seats INT NOT NULL DEFAULT 4,
  driver_max_co_passengers INT NOT NULL DEFAULT 3, -- Driver's cap on co-passengers
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create ride_bookings table
CREATE TABLE IF NOT EXISTS ride_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID REFERENCES rides(id) ON DELETE CASCADE,
  passenger_id UUID REFERENCES users(id) ON DELETE CASCADE,
  pickup_lat NUMERIC(9,6) NOT NULL,
  pickup_lng NUMERIC(9,6) NOT NULL,
  pickup_label TEXT,
  dropoff_lat NUMERIC(9,6) NOT NULL,
  dropoff_lng NUMERIC(9,6) NOT NULL,
  dropoff_label TEXT,
  seats_requested INT NOT NULL DEFAULT 1,
  max_co_passengers INT DEFAULT 3, -- 0 = solo/private, 1 = up to 1 other, N = up to N, -1 = no limit
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookup of bookings per ride
CREATE INDEX IF NOT EXISTS idx_ride_bookings_ride_status ON ride_bookings(ride_id, status);

-- 4. Atomic Row-Locking Stored Procedure: book_pooled_ride
-- Uses SELECT ... FOR UPDATE to lock the Ride row, avoiding concurrent race conditions.
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
BEGIN
  -- Row-level lock on the targeted Ride record to block concurrent booking updates
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

  -- Calculate proposed co-passenger count after adding p_passenger
  SELECT COUNT(*) INTO v_proposed_count
  FROM ride_bookings
  WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending');

  v_proposed_count := v_proposed_count + 1;

  -- 1. Check Driver Cap
  IF v_ride.driver_max_co_passengers IS NOT NULL AND v_proposed_count > v_ride.driver_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'DRIVER_CAP_EXCEEDED';
    RETURN;
  END IF;

  -- 2. Check Candidate Passenger Cap
  IF p_max_co_passengers IS NOT NULL AND p_max_co_passengers != -1 AND v_proposed_count > p_max_co_passengers THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'PASSENGER_CAP_EXCEEDED';
    RETURN;
  END IF;

  -- 3. Check Existing Passengers' Caps ("most restrictive passenger wins")
  FOR v_existing_booking IN 
    SELECT max_co_passengers 
    FROM ride_bookings 
    WHERE ride_id = p_ride_id AND status IN ('accepted', 'pending')
  LOOP
    IF v_existing_booking.max_co_passengers IS NOT NULL 
       AND v_existing_booking.max_co_passengers != -1 
       AND v_proposed_count > v_existing_booking.max_co_passengers THEN
      RETURN QUERY SELECT NULL::UUID, FALSE, 'EXISTING_PASSENGER_CAP_VIOLATED';
      RETURN;
    END IF;
  END LOOP;

  -- 4. Check Seat Availability
  IF v_ride.available_seats < p_seats_requested THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'INSUFFICIENT_SEATS';
    RETURN;
  END IF;

  -- Insert Booking and deduct available seats atomically
  INSERT INTO ride_bookings (
    ride_id, passenger_id, pickup_lat, pickup_lng, pickup_label,
    dropoff_lat, dropoff_lng, dropoff_label, seats_requested, max_co_passengers, status
  ) VALUES (
    p_ride_id, p_passenger_id, p_pickup_lat, p_pickup_lng, p_pickup_label,
    p_dropoff_lat, p_dropoff_lng, p_dropoff_label, p_seats_requested, p_max_co_passengers, 'accepted'
  ) RETURNING id INTO booking_id;

  UPDATE rides
  SET available_seats = available_seats - p_seats_requested
  WHERE id = p_ride_id;

  RETURN QUERY SELECT booking_id, TRUE, 'SUCCESS';
END;
$$;


-- ========================================================
-- Migration: 20260826000000_pooling_rls.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Migration: RLS for rides / ride_bookings (Flexible Pooling)
--
-- 20260825000000_pooling_capacity.sql created `rides` and
-- `ride_bookings` but never enabled row level security on them.
-- On Postgres, a bare `create table` leaves RLS OFF by default, so
-- until this migration runs, any authenticated (or, if the anon key
-- is used client-side, anonymous) caller can select/insert/update/
-- delete every ride and every passenger's booking in the system —
-- including pickup/dropoff points for people they were never matched
-- with. This closes that gap, following the same auth_user_id ->
-- users.id pattern as 20260822000002_rls_policies.sql.
-- ─────────────────────────────────────────────────────────────

alter table public.rides enable row level security;
alter table public.ride_bookings enable row level security;

-- ─── rides ──────────────────────────────────────────────────
-- Discovery needs to be broad (riders search for open rides), so any
-- authenticated user may SELECT an active ride. Non-active rides
-- (completed/cancelled) are only visible to the driver or someone who
-- actually booked a seat on them.
drop policy if exists rides_select on public.rides;
create policy rides_select
on public.rides
for select
to authenticated
using (
  status = 'active'
  or driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
  or id in (
    select rb.ride_id from public.ride_bookings as rb
    join public.users as person on person.id = rb.passenger_id
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists rides_insert_own on public.rides;
create policy rides_insert_own
on public.rides
for insert
to authenticated
with check (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- Update is restricted to the driver themselves. Seat count updates
-- from a booking should go through the book_pooled_ride() RPC
-- (security definer) rather than a direct client-side UPDATE.
drop policy if exists rides_update_own on public.rides;
create policy rides_update_own
on public.rides
for update
to authenticated
using (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists rides_delete_own on public.rides;
create policy rides_delete_own
on public.rides
for delete
to authenticated
using (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- ─── ride_bookings ──────────────────────────────────────────
-- Only the passenger who made the booking, or the driver of the ride
-- it belongs to, can see it. Nobody sees another passenger's pickup/
-- dropoff point just because they're pooled on the same ride.
drop policy if exists ride_bookings_select on public.ride_bookings;
create policy ride_bookings_select
on public.ride_bookings
for select
to authenticated
using (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
  or ride_id in (
    select r.id from public.rides as r
    join public.users as person on person.id = r.driver_id
    where person.auth_user_id = auth.uid()
  )
);

-- Direct client-side inserts are still allowed for the passenger's own
-- row (e.g. a 'pending' request before it's atomically accepted), but
-- the capacity-safe path is the book_pooled_ride() RPC, which runs as
-- SECURITY DEFINER and enforces the same check under its own row lock.
drop policy if exists ride_bookings_insert_own on public.ride_bookings;
create policy ride_bookings_insert_own
on public.ride_bookings
for insert
to authenticated
with check (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- A passenger may update/cancel only their own booking; a driver may
-- not edit a passenger's booking on their own ride (only cancel-via-
-- their-own-row semantics belong to the passenger).
drop policy if exists ride_bookings_update_own on public.ride_bookings;
create policy ride_bookings_update_own
on public.ride_bookings
for update
to authenticated
using (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists ride_bookings_delete_own on public.ride_bookings;
create policy ride_bookings_delete_own
on public.ride_bookings
for delete
to authenticated
using (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- book_pooled_ride() bypasses these policies via SECURITY DEFINER, so
-- it must be locked down to authenticated callers only — otherwise
-- RLS on the tables it writes to is moot.
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


-- ========================================================
-- Migration: 20260901000000_driver_gender_match.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 1: Women-only ride mode.
--
-- Adds trip_requests.require_driver_gender_match: an opt-in flag a
-- rider can set together with a gendered preference (female_only /
-- male_only) meaning "the ride owner/driver must also be that gender".
--
-- No parallel preference field is created — the existing `preference`
-- column stays the single source of truth; this boolean only tightens
-- it. Default false keeps every existing row and code path unchanged.
--
-- RLS note: Postgres row-level security is row-level, not column-level.
-- The existing trip_requests policies (see 20260822000002_rls_policies.sql
-- and 20260824000000_day4_fixes.sql) already gate whole-row SELECT /
-- INSERT / UPDATE / DELETE, so this new column automatically inherits the
-- exact same visibility rules as `preference` — a viewer who cannot see
-- the row cannot see this column, and an insert/update policy that
-- admits the row admits it. No new policy is required (or possible) for
-- column-level parity; this comment documents that intentionally.
-- ─────────────────────────────────────────────────────────────

alter table public.trip_requests
  add column if not exists require_driver_gender_match boolean not null default false;

comment on column public.trip_requests.require_driver_gender_match is
  'When true together with a gendered preference, the ride owner/driver gender must satisfy that preference. Enforced by the matching pipeline before any OSRM calls.';


-- ========================================================
-- Migration: 20260901000100_sos_safety_tables.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 2: SOS button + live trip share.
--
-- Two tables, both strictly owner-scoped:
--   emergency_contacts — up to 3 trusted contacts per user, E.164 phones.
--   sos_events         — the user's own audit trail of SOS triggers.
--
-- Deliberately zero-cost: no SMS gateway, no third-party tracking. The
-- SOS flow itself runs client-side (browser Geolocation API + wa.me deep
-- links); these tables only persist the contact list and the audit log.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  contact_name text not null check (length(trim(contact_name)) between 1 and 80),
  -- E.164: leading +, 8-15 digits (ITU-T E.164), e.g. +923001234567
  contact_phone text not null check (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, contact_phone)
);

create index if not exists emergency_contacts_user_idx
  on public.emergency_contacts (user_id);

-- DB-side cap of 3 contacts per user, matching the API-side check, so a
-- direct client insert can't exceed it either.
create or replace function public.enforce_emergency_contact_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.emergency_contacts
    where user_id = new.user_id
  ) >= 3 then
    raise exception using
      errcode = 'check_violation',
      message = 'EMERGENCY_CONTACT_LIMIT_REACHED',
      detail = 'Each rider may keep at most 3 emergency contacts.';
  end if;
  return new;
end;
$$;

drop trigger if exists emergency_contacts_enforce_limit on public.emergency_contacts;
create trigger emergency_contacts_enforce_limit
before insert on public.emergency_contacts
for each row execute function public.enforce_emergency_contact_limit();

create table if not exists public.sos_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  trip_request_id uuid references public.trip_requests(id) on delete set null,
  ride_id uuid,
  lat numeric(9, 6) not null check (lat between -90 and 90),
  lng numeric(9, 6) not null check (lng between -180 and 180),
  triggered_at timestamptz not null default timezone('utc', now())
);

create index if not exists sos_events_user_idx
  on public.sos_events (user_id, triggered_at);

-- ─── RLS ────────────────────────────────────────────────────
-- Same auth_user_id -> users.id mapping as 20260822000002_rls_policies.sql.
-- A user can only ever read/write their own rows — a safety table that
-- leaked other riders' emergency contacts would be worse than none.

alter table public.emergency_contacts enable row level security;
alter table public.sos_events enable row level security;

drop policy if exists emergency_contacts_select_own on public.emergency_contacts;
create policy emergency_contacts_select_own
on public.emergency_contacts
for select
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists emergency_contacts_insert_own on public.emergency_contacts;
create policy emergency_contacts_insert_own
on public.emergency_contacts
for insert
to authenticated
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists emergency_contacts_update_own on public.emergency_contacts;
create policy emergency_contacts_update_own
on public.emergency_contacts
for update
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists emergency_contacts_delete_own on public.emergency_contacts;
create policy emergency_contacts_delete_own
on public.emergency_contacts
for delete
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- sos_events is an audit trail: the triggering user inserts and reads
-- their own events only. No UPDATE/DELETE policies at all — an audit
-- row must not be silently rewritable by the client.

drop policy if exists sos_events_select_own on public.sos_events;
create policy sos_events_select_own
on public.sos_events
for select
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists sos_events_insert_own on public.sos_events;
create policy sos_events_insert_own
on public.sos_events
for insert
to authenticated
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

revoke all on function public.enforce_emergency_contact_limit() from public;


-- ========================================================
-- Migration: 20260901000200_verified_badge.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 3: Verified profile badge.
--
-- Adds users.is_verified / users.verified_domain. Verification is
-- granted by the app's verify-student flow, which reuses Supabase
-- Auth's existing email confirmation: the linked auth user's email
-- must be confirmed (email_confirmed_at set) AND its domain must be
-- on the university allowlist (maintained in src/verification.ts).
-- No third-party verification service, no extra email sending.
--
-- Existing users policies (20260822000002_rls_policies.sql) already
-- allow any authenticated user to SELECT profiles while restricting
-- UPDATE to the linked auth user — the badge columns inherit exactly
-- those rules, so a rider can never flip someone else's badge.
-- ─────────────────────────────────────────────────────────────

alter table public.users
  add column if not exists is_verified boolean not null default false,
  add column if not exists verified_domain text;

alter table public.users
  drop constraint if exists users_verified_domain_requires_flag;

-- A domain may only be stored when the badge is actually set, so a row
-- can never imply verification without the boolean agreeing.
alter table public.users
  add constraint users_verified_domain_requires_flag
  check (is_verified or verified_domain is null);

create index if not exists users_verified_idx
  on public.users (is_verified) where is_verified;

comment on column public.users.is_verified is
  'True once the verify-student flow confirmed a Supabase Auth email whose domain is on the university allowlist (src/verification.ts).';


-- ========================================================
-- Migration: 20260901000300_ratings_reports_blocks.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 4: Post-ride rating + report/block.
--
-- New tables: ratings, user_reports, blocked_users — all owner-scoped
-- via RLS, with one deliberate exception documented below: star
-- AVERAGES are public-by-design (a trust signal is useless if nobody
-- can see it), while individual comments stay private.
--
-- Self-contained on purpose: if the pooling migrations
-- (20260825000000 / 20260826000000) were never applied to a project,
-- this file still creates rides/ride_bookings (same shape) with their
-- RLS policies so ratings.ride_id has something to reference.
-- ─────────────────────────────────────────────────────────────

-- ─── rides / ride_bookings (idempotent mirror of the pooling migration) ──
create extension if not exists "pgcrypto";

create table if not exists public.rides (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid references public.users(id) on delete cascade,
  origin_lat numeric(9, 6) not null,
  origin_lng numeric(9, 6) not null,
  origin_label text,
  destination_lat numeric(9, 6) not null,
  destination_lng numeric(9, 6) not null,
  destination_label text,
  departure_time timestamptz not null,
  total_seats integer not null default 4,
  available_seats integer not null default 4,
  driver_max_co_passengers integer not null default 3,
  status text not null default 'active'
    check (status in ('active', 'full', 'completed', 'cancelled')),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.ride_bookings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid references public.rides(id) on delete cascade,
  passenger_id uuid references public.users(id) on delete cascade,
  pickup_lat numeric(9, 6) not null,
  pickup_lng numeric(9, 6) not null,
  pickup_label text,
  dropoff_lat numeric(9, 6) not null,
  dropoff_lng numeric(9, 6) not null,
  dropoff_label text,
  seats_requested integer not null default 1,
  max_co_passengers integer default 3,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'completed', 'cancelled')),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ride_bookings_ride_status
  on public.ride_bookings (ride_id, status);

-- ─── ratings ────────────────────────────────────────────────
create table if not exists public.ratings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  rater_id uuid not null references public.users(id) on delete cascade,
  rated_user_id uuid not null references public.users(id) on delete cascade,
  stars integer not null check (stars between 1 and 5),
  comment text check (comment is null or length(trim(comment)) <= 500),
  created_at timestamptz not null default timezone('utc', now()),
  -- One rating per rider per ride.
  unique (ride_id, rater_id, rated_user_id),
  check (rater_id <> rated_user_id)
);

create index if not exists ratings_rated_user_idx
  on public.ratings (rated_user_id);

-- ─── user_reports ───────────────────────────────────────────
create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users(id) on delete cascade,
  reported_user_id uuid not null references public.users(id) on delete cascade,
  ride_id uuid references public.rides(id) on delete set null,
  reason text not null
    check (reason in ('unsafe_driving', 'inappropriate_behavior', 'no_show', 'other')),
  details text check (details is null or length(trim(details)) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed')),
  created_at timestamptz not null default timezone('utc', now()),
  check (reporter_id <> reported_user_id)
);

create index if not exists user_reports_reported_idx
  on public.user_reports (reported_user_id, status);

-- ─── blocked_users ──────────────────────────────────────────
create table if not exists public.blocked_users (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists blocked_users_blocked_idx
  on public.blocked_users (blocked_id);

-- ─── public aggregate: star average per user ────────────────
-- RLS below hides raw rating rows from strangers (comments are private),
-- so the average that MatchCard displays is exposed through a SECURITY
-- DEFINER function instead — same lockdown pattern as
-- book_pooled_ride() in 20260826000000_pooling_rls.sql.
create or replace function public.user_rating_summary(p_user_id uuid)
returns table (avg_stars numeric, rating_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(avg(stars), 1), 0), count(*)
  from public.ratings
  where rated_user_id = p_user_id;
$$;

revoke all on function public.user_rating_summary(uuid) from public;
grant execute on function public.user_rating_summary(uuid) to authenticated;

-- ─── RLS ────────────────────────────────────────────────────
alter table public.rides enable row level security;
alter table public.ride_bookings enable row level security;
alter table public.ratings enable row level security;
alter table public.user_reports enable row level security;
alter table public.blocked_users enable row level security;

-- rides / ride_bookings: identical policies to 20260826000000_pooling_rls.sql
-- (same names — re-running either migration converges to the same state).
drop policy if exists rides_select on public.rides;
create policy rides_select
on public.rides
for select
to authenticated
using (
  status = 'active'
  or driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
  or id in (
    select rb.ride_id from public.ride_bookings as rb
    join public.users as person on person.id = rb.passenger_id
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists rides_insert_own on public.rides;
create policy rides_insert_own
on public.rides
for insert
to authenticated
with check (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists rides_update_own on public.rides;
create policy rides_update_own
on public.rides
for update
to authenticated
using (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists rides_delete_own on public.rides;
create policy rides_delete_own
on public.rides
for delete
to authenticated
using (
  driver_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists ride_bookings_select on public.ride_bookings;
create policy ride_bookings_select
on public.ride_bookings
for select
to authenticated
using (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
  or ride_id in (
    select r.id from public.rides as r
    join public.users as person on person.id = r.driver_id
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists ride_bookings_insert_own on public.ride_bookings;
create policy ride_bookings_insert_own
on public.ride_bookings
for insert
to authenticated
with check (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists ride_bookings_update_own on public.ride_bookings;
create policy ride_bookings_update_own
on public.ride_bookings
for update
to authenticated
using (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists ride_bookings_delete_own on public.ride_bookings;
create policy ride_bookings_delete_own
on public.ride_bookings
for delete
to authenticated
using (
  passenger_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- ratings: document the chosen default — comments are visible to the
-- person who WROTE the rating and the person who was RATED (they should
-- get to see feedback about themselves); nobody else ever sees raw
-- rows, only the aggregate via user_rating_summary(). Insert is limited
-- to your own rating rows; ratings are immutable (no update/delete
-- policies), so a ride's score can't be quietly rewritten later.
drop policy if exists ratings_select_participant on public.ratings;
create policy ratings_select_participant
on public.ratings
for select
to authenticated
using (
  rater_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
  or rated_user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists ratings_insert_own on public.ratings;
create policy ratings_insert_own
on public.ratings
for insert
to authenticated
with check (
  rater_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- user_reports: reporter-only visibility. Reports are moderation data —
-- the reported user gets no read access (that would leak who reported
-- them and why). Status flips (open -> reviewed) happen with the
-- service role, which bypasses RLS by design.
drop policy if exists user_reports_select_own on public.user_reports;
create policy user_reports_select_own
on public.user_reports
for select
to authenticated
using (
  reporter_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists user_reports_insert_own on public.user_reports;
create policy user_reports_insert_own
on public.user_reports
for insert
to authenticated
with check (
  reporter_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- blocked_users: a user manages and sees only blocks THEY created.
-- Mutual exclusion in matching is enforced server-side (apiHandler
-- queries both directions with the service role), so neither side
-- needs to read the other's block rows.
drop policy if exists blocked_users_select_own on public.blocked_users;
create policy blocked_users_select_own
on public.blocked_users
for select
to authenticated
using (
  blocker_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists blocked_users_insert_own on public.blocked_users;
create policy blocked_users_insert_own
on public.blocked_users
for insert
to authenticated
with check (
  blocker_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists blocked_users_delete_own on public.blocked_users;
create policy blocked_users_delete_own
on public.blocked_users
for delete
to authenticated
using (
  blocker_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);


-- ========================================================
-- Migration: 20260902000000_vehicle_type.sql
-- ========================================================

-- ─────────────────────────────────────────────────────────────
-- Day 8 — Owner/passenger matching: does this rider bring a car or bike?
--
-- Adds trip_requests.vehicle_type ('none' | 'car' | 'bike'). Default
-- 'none' keeps every existing row and matching code path byte-for-byte
-- identical — the matching pipeline only takes the owner/passenger fare
-- path (calculateOwnerPassengerFare in fareSplit.ts) when exactly one
-- side of a match has a non-'none' vehicle_type. Two riders who both
-- have a vehicle, or neither does, still fall back to the original
-- peer-share economics.
--
-- Bike capacity note: a bike carries exactly one passenger. This isn't
-- enforced by a CHECK constraint here — it's structural, not row-level:
-- the matching pipeline (matchPipeline.ts) only ever evaluates 1:1
-- pairings, and a trip_request's status flips away from 'pending' once
-- matched, so it stops surfacing as a match candidate at all. A bike
-- owner therefore can't be matched to a second passenger through this
-- flow while their first match is still active.
--
-- RLS note: same rationale as 20260901000000_driver_gender_match.sql —
-- this is a plain column addition to an already-RLS-gated table, so it
-- inherits the existing row-level policies automatically. No new policy
-- is required or possible for column-level parity.
-- ─────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'vehicle_type') then
    create type public.vehicle_type as enum ('none', 'car', 'bike');
  end if;
end $$;

alter table public.trip_requests
  add column if not exists vehicle_type public.vehicle_type not null default 'none';

comment on column public.trip_requests.vehicle_type is
  'Does this rider bring their own car/bike? "none" is the classic peer-to-peer flow. When exactly one side of a match has a vehicle, that side becomes the ride owner and pays nothing; the other pays the full per-km fare as a passenger. See matchPipeline.ts resolveVehicleRoles().';


-- ========================================================
-- Seed Data & Demo User
-- ========================================================

INSERT INTO public.users (id, auth_user_id, display_name, gender, is_verified, verified_domain)
VALUES
  ('ebc53584-8f5c-4148-8900-9e8afe056bbe', 'ebc53584-8f5c-4148-8900-9e8afe056bbe', 'Demo Commuter', 'female', true, 'nust.edu.pk'),
  ('10000000-0000-4000-8000-000000000001', null, 'V1 F-10 Rider', 'male', false, null),
  ('10000000-0000-4000-8000-000000000002', null, 'V1 G-9 Rider', 'male', true, 'comsats.edu.pk'),
  ('10000000-0000-4000-8000-000000000003', null, 'V2 F-10 Rider', 'female', true, 'nust.edu.pk'),
  ('10000000-0000-4000-8000-000000000004', null, 'V2 Saddar Rider', 'female', false, null),
  ('10000000-0000-4000-8000-000000000005', null, 'V3 F-10 Rider', 'male', false, null),
  ('10000000-0000-4000-8000-000000000006', null, 'V3 G-9 Female-Only Rider', 'female', true, 'qau.edu.pk')
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  gender = EXCLUDED.gender;

-- Active trip requests for matching
INSERT INTO public.trip_requests (
  id, user_id,
  origin_lat, origin_lng, origin_address_label,
  destination_lat, destination_lng, destination_address_label,
  requested_departure_at, window_minutes, preference, status, expires_at
) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 33.6844, 73.0479, 'F-10 Markaz', 33.6484, 72.9922, 'NUST Gate 1', NOW() + INTERVAL '1 hour', 60, 'any', 'active', NOW() + INTERVAL '10 days'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 33.6880, 73.0250, 'G-9 Markaz', 33.6484, 72.9922, 'NUST Gate 1', NOW() + INTERVAL '1 hour', 60, 'any', 'active', NOW() + INTERVAL '10 days'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 33.6844, 73.0479, 'F-10 Markaz', 33.6484, 72.9922, 'NUST Gate 1', NOW() + INTERVAL '1 hour', 60, 'female_only', 'active', NOW() + INTERVAL '10 days'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006', 33.6880, 73.0250, 'G-9 Markaz', 33.6484, 72.9922, 'NUST Gate 1', NOW() + INTERVAL '1 hour', 60, 'female_only', 'active', NOW() + INTERVAL '10 days')
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  expires_at = EXCLUDED.expires_at;

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



-- =====================================================================
-- NOTE: This aggregate bundles schema through 20260902000000 plus the
-- SafarSync pooling migration below. For a guaranteed end-to-end fresh
-- project (all consent/notifications/realtime migrations in order), run
-- supabase/RUN_ALL_MIGRATIONS.sql instead. The block below only depends
-- on rides / ride_bookings / users / trip_requests, all present above,
-- so appending it here stays valid.
-- =====================================================================

-- =====================================================================
-- FILE: 20261022000000_safarsync_pooling.sql
-- =====================================================================
-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
-- Migration: SafarSync pooled-ride persistence + live sharing (PHASE 1)
-- Idempotent: every statement is safe to re-run (IF NOT EXISTS /
-- CREATE OR REPLACE / drop-then-add constraints).
--
-- Scope of THIS migration is schema only. It:
--   1. Adds participant roles + seat-count range to ride_bookings.
--   2. Adds primary_rider_id / booked_by / ride_mode to rides.
--   3. Creates ride_messages (per-ride group chat channel).
--   4. Creates match_chat_threads / match_chat_messages to replace the
--      .data/match-chats.json persistence in src/chatStore.ts, and
--      match_requests to replace .data/match-requests.json in
--      src/frontend/matchrequeststore.ts. Column shapes mirror the
--      exported TypeScript interfaces so the store rewrites in later
--      phases keep their function signatures.
--   5. Creates live_locations + trip_tracking_state for in-app safety
--      location sharing (replaces the Google-Maps-only TripSharePanel).
--   6. Adds RLS + a redacting get_ride_participants() RPC.
--   7. Enables Supabase Realtime on ride_messages and live_locations.
--
-- The book_pooled_ride()/respond_to_ride_consent() DUAL-CONSENT changes
-- are deliberately NOT here вЂ” those are Phase 2. Existing 1:1 / group
-- booking behaviour is left byte-for-byte intact by this file.
-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

-- 0. Convenience: the public.users.id of the caller behind auth.uid().
--    Mirrors the alias pattern used across the codebase (a person may be
--    matched by users.id OR by their auth uid), so every policy below can
--    call current_user_id() instead of re-deriving it.
create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.users
  where auth_user_id = auth.uid() or id = auth.uid()
  limit 1;
$$;

-- Is p_user_id a legitimate member of this ride? (driver, primary rider,
-- the ride-hail booker, or an ACCEPTED passenger). Used by RLS below and
-- by the API layer. SECURITY DEFINER so it can read rides/ride_bookings
-- regardless of the caller's own row visibility.
create or replace function public.is_ride_participant(
  p_ride_id uuid,
  p_user_id uuid default public.current_user_id()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id is not null and (
    exists (
      select 1 from public.rides r
      where r.id = p_ride_id
        and (
          r.driver_id = p_user_id
          or r.primary_rider_id = p_user_id
          or r.booked_by = p_user_id
        )
    )
    or exists (
      select 1 from public.ride_bookings rb
      where rb.ride_id = p_ride_id
        and rb.passenger_id = p_user_id
        and rb.status = 'accepted'
    )
  );
$$;

-- 1. ride_bookings: participant role + a sane seat-count range.
--    seats_requested already exists (20260825000000_pooling_capacity.sql);
--    here we only pin its allowed range and add role.
alter table public.ride_bookings
  add column if not exists role text not null default 'passenger_joiner';

alter table public.ride_bookings
  drop constraint if exists ride_bookings_role_check;
alter table public.ride_bookings
  add constraint ride_bookings_role_check
  check (role in ('host_driver', 'host_rider', 'passenger_joiner'));

alter table public.ride_bookings
  drop constraint if exists ride_bookings_seats_requested_range;
alter table public.ride_bookings
  add constraint ride_bookings_seats_requested_range
  check (seats_requested between 1 and 4);

comment on column public.ride_bookings.role is
  'host_driver = the driver who owns the ride; host_rider = the primary rider (an approved joiner who created the ride as a rider-share); passenger_joiner = anyone who requested to join. Defaults to passenger_joiner for backwards compatibility with pre-existing bookings.';

-- 2. rides: primary rider, ride-hail booker, and pool mode.
alter table public.rides
  add column if not exists primary_rider_id uuid references public.users(id) on delete set null;
alter table public.rides
  add column if not exists booked_by uuid references public.users(id) on delete set null;
alter table public.rides
  add column if not exists ride_mode text not null default 'car_pool';

alter table public.rides
  drop constraint if exists rides_ride_mode_check;
alter table public.rides
  add constraint rides_ride_mode_check
  check (ride_mode in ('car_pool', 'ride_hail_share'));

comment on column public.rides.primary_rider_id is
  'Second approver for dual consent. In car_pool mode this is the lead passenger; when null, only the driver approves.';
comment on column public.rides.booked_by is
  'In ride_hail_share mode, the user who booked the Uber/Careem/Yango/inDrive cab and therefore sees every joiner''s details. Null for car_pool.';
comment on column public.rides.ride_mode is
  'car_pool = a personal vehicle; ride_hail_share = a booked app cab being split. Drives joiner-detail redaction in get_ride_participants().';

-- 3. ride_messages: the per-ride group chat channel (keyed by ride_id).
create table if not exists public.ride_messages (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ride_messages_ride_created
  on public.ride_messages(ride_id, created_at);

-- 4a. match_chat_threads / match_chat_messages: replacement store for
--     src/chatStore.ts. Field names mirror MatchChatThread /
--     StoredChatMessage. id/pair_key stay TEXT because the store derives
--     a deterministic "chat_<pairkey>" id and a "a::b" sorted pair key,
--     and MatchRequest.chatId references it as a string.
create table if not exists public.match_chat_threads (
  id text primary key,
  pair_key text,
  participant_ids uuid[] not null default '{}'::uuid[],
  participant_names jsonb not null default '{}'::jsonb,
  origin_label text not null default 'Pickup',
  destination_label text not null default 'Drop-off',
  fare_share_pkr numeric not null default 0,
  ride_id uuid references public.rides(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_match_chat_threads_pair
  on public.match_chat_threads(pair_key);

create table if not exists public.match_chat_messages (
  id text primary key,
  thread_id text not null references public.match_chat_threads(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade,
  "text" text not null check (length("text") between 1 and 2000),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_match_chat_messages_thread_created
  on public.match_chat_messages(thread_id, created_at);

-- 4b. match_requests: replacement store for
--     src/frontend/matchrequeststore.ts. preferences/conditions/snapshot
--     are JSONB holding the exact MatchRequestPreferences /
--     MatchRequestConditions / MatchRequestSnapshot object shapes, so the
--     store functions round-trip them without field-by-field mapping.
create table if not exists public.match_requests (
  id text primary key,
  from_user_id uuid not null references public.users(id) on delete cascade,
  from_name text not null default '',
  to_user_id uuid not null references public.users(id) on delete cascade,
  to_name text not null default '',
  from_trip_request_id uuid references public.trip_requests(id) on delete set null,
  to_trip_request_id uuid references public.trip_requests(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','awaiting_requester','confirmed','declined','cancelled','expired')),
  preferences jsonb not null default '{}'::jsonb,
  conditions jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  chat_id text references public.match_chat_threads(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  responded_at timestamptz,
  confirmed_at timestamptz,
  expires_at timestamptz not null default (timezone('utc', now()) + interval '24 hours')
);

create index if not exists idx_match_requests_from on public.match_requests(from_user_id, status);
create index if not exists idx_match_requests_to   on public.match_requests(to_user_id, status);
create index if not exists idx_match_requests_expiry on public.match_requests(expires_at);

-- 5a. live_locations: one current position per (ride, user).
create table if not exists public.live_locations (
  ride_id uuid not null references public.rides(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  lat numeric not null check (lat between -90 and 90),
  lng numeric not null check (lng between -180 and 180),
  accuracy numeric,
  heading numeric,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (ride_id, user_id)
);

create index if not exists idx_live_locations_updated on public.live_locations(updated_at);

-- 5b. trip_tracking_state: the per-(ride,user) on/off switch that drives
--     the "Safety tracking active" UI and auto-stop on ride completion.
create table if not exists public.trip_tracking_state (
  ride_id uuid not null references public.rides(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  sharing boolean not null default false,
  started_at timestamptz,
  stopped_at timestamptz,
  primary key (ride_id, user_id)
);

-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
-- 6. Row Level Security.
--    The API server runs as the service role (bypasses RLS); these
--    policies protect any direct/authenticated access and are what
--    Supabase Realtime evaluates for a subscriber's own connection.
-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

-- ride_messages: only accepted members may read or post.
alter table public.ride_messages enable row level security;

drop policy if exists ride_messages_select on public.ride_messages;
create policy ride_messages_select
on public.ride_messages for select to authenticated
using ( public.is_ride_participant(ride_id) );

drop policy if exists ride_messages_insert on public.ride_messages;
create policy ride_messages_insert
on public.ride_messages for insert to authenticated
with check (
  public.is_ride_participant(ride_id)
  and sender_id = public.current_user_id()
);

revoke all on public.ride_messages from public;
grant select, insert on public.ride_messages to authenticated;

-- live_locations: read = same-ride members; write = own row only.
alter table public.live_locations enable row level security;

drop policy if exists live_locations_select on public.live_locations;
create policy live_locations_select
on public.live_locations for select to authenticated
using ( public.is_ride_participant(ride_id) );

drop policy if exists live_locations_upsert on public.live_locations;
create policy live_locations_upsert
on public.live_locations for insert to authenticated
with check ( user_id = public.current_user_id() and public.is_ride_participant(ride_id) );

drop policy if exists live_locations_update on public.live_locations;
create policy live_locations_update
on public.live_locations for update to authenticated
using ( user_id = public.current_user_id() )
with check ( user_id = public.current_user_id() );

revoke all on public.live_locations from public;
grant select, insert, update on public.live_locations to authenticated;

-- trip_tracking_state: same model as live_locations.
alter table public.trip_tracking_state enable row level security;

drop policy if exists trip_tracking_state_select on public.trip_tracking_state;
create policy trip_tracking_state_select
on public.trip_tracking_state for select to authenticated
using ( public.is_ride_participant(ride_id) );

drop policy if exists trip_tracking_state_upsert on public.trip_tracking_state;
create policy trip_tracking_state_upsert
on public.trip_tracking_state for insert to authenticated
with check ( user_id = public.current_user_id() and public.is_ride_participant(ride_id) );

drop policy if exists trip_tracking_state_update on public.trip_tracking_state;
create policy trip_tracking_state_update
on public.trip_tracking_state for update to authenticated
using ( user_id = public.current_user_id() )
with check ( user_id = public.current_user_id() );

revoke all on public.trip_tracking_state from public;
grant select, insert, update on public.trip_tracking_state to authenticated;

-- Replacement match stores: participant-scoped visibility. The server
-- reads/writes these via the service role, but the policies enforce the
-- same invariant for any authenticated read (you only ever see threads
-- and requests you are a party to).
alter table public.match_chat_threads enable row level security;

drop policy if exists match_chat_threads_participant on public.match_chat_threads;
create policy match_chat_threads_participant
on public.match_chat_threads for select to authenticated
using ( public.current_user_id() = any (participant_ids) );

revoke all on public.match_chat_threads from public;
grant select on public.match_chat_threads to authenticated;

alter table public.match_chat_messages enable row level security;

drop policy if exists match_chat_messages_participant on public.match_chat_messages;
create policy match_chat_messages_participant
on public.match_chat_messages for select to authenticated
using (
  exists (
    select 1 from public.match_chat_threads t
    where t.id = thread_id
      and public.current_user_id() = any (t.participant_ids)
  )
);

revoke all on public.match_chat_messages from public;
grant select on public.match_chat_messages to authenticated;

alter table public.match_requests enable row level security;

drop policy if exists match_requests_party on public.match_requests;
create policy match_requests_party
on public.match_requests for select to authenticated
using (
  from_user_id = public.current_user_id()
  or to_user_id = public.current_user_id()
);

revoke all on public.match_requests from public;
grant select on public.match_requests to authenticated;

-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
-- 7. get_ride_participants(ride_id): the SINGLE authorised way to list a
--    ride's people, with joiner-detail redaction enforced server-side (we
--    never rely on client filtering).
--
--    Visibility of a passenger_joiner's details (name/pickup/dropoff/party
--    size):
--      - car_pool: every member sees everything (they must recognise each
--        other at the roadside).
--      - ride_hail_share: only the driver, primary rider, or booked_by (a
--        "host") вЂ” or the joiner themself вЂ” see a joiner's details. Other
--        joiners see a masked "Fellow rider".
--    Host identities (driver / primary rider) are never masked.
--
--    ASSUMPTION (spec gap): public.users has no phone column today, so no
--    phone is returned; redaction covers name, pickup, dropoff and party
--    size. If a phone is added later it must flow through this same RPC.
-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
create or replace function public.get_ride_participants(
  p_ride_id uuid
)
returns table (
  user_id uuid,
  role text,
  display_name text,
  is_verified boolean,
  seats_requested int,
  pickup_label text,
  dropoff_label text,
  details_visible boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select public.current_user_id() as uid
  ),
  r as (
    select id, driver_id, primary_rider_id, booked_by, ride_mode
    from public.rides
    where id = p_ride_id
  ),
  base as (
    select rr.driver_id as subject_id, 'host_driver'::text as subject_role,
           0 as seats_requested, null::text as pickup_label, null::text as dropoff_label
    from r rr
    union all
    select rb.passenger_id, coalesce(rb.role, 'passenger_joiner'),
           rb.seats_requested, rb.pickup_label, rb.dropoff_label
    from public.ride_bookings rb
    where rb.ride_id = p_ride_id and rb.status = 'accepted'
  )
  select
    b.subject_id,
    b.subject_role,
    case when mask then 'Fellow rider' else u.display_name end,
    coalesce(u.is_verified, false),
    case when mask then null else b.seats_requested end,
    case when mask then null else b.pickup_label end,
    case when mask then null else b.dropoff_label end,
    not mask
  from base b
  cross join caller c
  cross join r
  join public.users u on u.id = b.subject_id
  cross join lateral (
    select (
      r.ride_mode = 'ride_hail_share'
      and b.subject_role = 'passenger_joiner'
      and b.subject_id <> c.uid
      and not (
        c.uid = r.driver_id
        or c.uid = r.primary_rider_id
        or (r.booked_by is not null and c.uid = r.booked_by)
      )
    ) as mask
  ) m
  where public.is_ride_participant(p_ride_id, c.uid);
$$;

revoke all on function public.get_ride_participants(uuid) from public;
grant execute on function public.get_ride_participants(uuid) to authenticated;

-- current_user_id / is_ride_participant are implementation details of the
-- policies + RPC above; keep them callable by authenticated but not by
-- anonymous clients.
revoke all on function public.current_user_id() from public;
grant execute on function public.current_user_id() to authenticated;

revoke all on function public.is_ride_participant(uuid, uuid) from public;
grant execute on function public.is_ride_participant(uuid, uuid) to authenticated;

-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
-- 8. Supabase Realtime for ride_messages and live_locations.
--    Guarded so it no-ops on any project where the publication is absent
--    or already contains the table, and never fails the migration.
-- в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  begin
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ride_messages'
    ) then
      execute 'alter publication supabase_realtime add table public.ride_messages';
    end if;
  exception when others then
    null;
  end;

  begin
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_locations'
    ) then
      execute 'alter publication supabase_realtime add table public.live_locations';
    end if;
  exception when others then
    null;
  end;
end $$;



-- ############################################################
-- Aggregated copy of: migrations/20261022000001_safarsync_dual_consent.sql  (SafarSync Phase 2: DUAL consent)
-- ############################################################
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


-- ############################################################
-- Aggregated copy of: migrations/20261022000002_safarsync_api.sql  (SafarSync Phase 3: API-support)
-- ############################################################
-- ─────────────────────────────────────────────────────────────
-- Migration: SafarSync API-support (PHASE 3). Idempotent.
--
-- Phase 3 wires the Express endpoints for ride group chat, live location
-- sharing, and authorised participant listing. The tables themselves are
-- created by Phase 1 (20261022000000_safarsync_pooling.sql). This file
-- re-asserts them (all IF NOT EXISTS — a no-op when Phase 1 is applied)
-- so the Phase 3 API path can be deployed/applied on its own without a
-- hidden dependency, and adds the ONE genuine change Phase 3 needs:
--
--   * get_ride_participants(ride_id, viewer_id) — an optional second
--     argument. The API server talks to Supabase as the service role, so
--     auth.uid() is NULL in its context and the original single-arg RPC
--     (which derives the viewer from auth.uid()) returns no rows when the
--     server calls it. The overload lets the server pass the acting
--     user's canonical public.users.id explicitly. The 1-arg call keeps
--     working unchanged (defaults to current_user_id()), so any direct
--     client / Realtime usage is byte-for-byte identical to Phase 1.
-- ─────────────────────────────────────────────────────────────

-- 1. ride_messages: the per-ride group chat channel (keyed by ride_id).
create table if not exists public.ride_messages (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists idx_ride_messages_ride_created
  on public.ride_messages(ride_id, created_at);

-- 2. live_locations: one current position per (ride, user).
create table if not exists public.live_locations (
  ride_id uuid not null references public.rides(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  lat numeric not null check (lat between -90 and 90),
  lng numeric not null check (lng between -180 and 180),
  accuracy numeric,
  heading numeric,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (ride_id, user_id)
);
create index if not exists idx_live_locations_updated on public.live_locations(updated_at);

-- 3. trip_tracking_state: the per-(ride,user) on/off switch that drives
--    the "Safety tracking active" UI and auto-stop on ride completion.
create table if not exists public.trip_tracking_state (
  ride_id uuid not null references public.rides(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  sharing boolean not null default false,
  started_at timestamptz,
  stopped_at timestamptz,
  primary key (ride_id, user_id)
);

-- Re-assert RLS + grants (identical to Phase 1; idempotent) so a
-- Phase-3-only apply is still protected. The API server uses the service
-- role and bypasses these; they guard any direct/authenticated access.
alter table public.ride_messages enable row level security;
drop policy if exists ride_messages_select on public.ride_messages;
create policy ride_messages_select
on public.ride_messages for select to authenticated
using ( public.is_ride_participant(ride_id) );
drop policy if exists ride_messages_insert on public.ride_messages;
create policy ride_messages_insert
on public.ride_messages for insert to authenticated
with check ( public.is_ride_participant(ride_id) and sender_id = public.current_user_id() );
revoke all on public.ride_messages from public;
grant select, insert on public.ride_messages to authenticated;

alter table public.live_locations enable row level security;
drop policy if exists live_locations_select on public.live_locations;
create policy live_locations_select
on public.live_locations for select to authenticated
using ( public.is_ride_participant(ride_id) );
drop policy if exists live_locations_upsert on public.live_locations;
create policy live_locations_upsert
on public.live_locations for insert to authenticated
with check ( user_id = public.current_user_id() and public.is_ride_participant(ride_id) );
drop policy if exists live_locations_update on public.live_locations;
create policy live_locations_update
on public.live_locations for update to authenticated
using ( user_id = public.current_user_id() )
with check ( user_id = public.current_user_id() );
revoke all on public.live_locations from public;
grant select, insert, update on public.live_locations to authenticated;

alter table public.trip_tracking_state enable row level security;
drop policy if exists trip_tracking_state_select on public.trip_tracking_state;
create policy trip_tracking_state_select
on public.trip_tracking_state for select to authenticated
using ( public.is_ride_participant(ride_id) );
drop policy if exists trip_tracking_state_upsert on public.trip_tracking_state;
create policy trip_tracking_state_upsert
on public.trip_tracking_state for insert to authenticated
with check ( user_id = public.current_user_id() and public.is_ride_participant(ride_id) );
drop policy if exists trip_tracking_state_update on public.trip_tracking_state;
create policy trip_tracking_state_update
on public.trip_tracking_state for update to authenticated
using ( user_id = public.current_user_id() )
with check ( user_id = public.current_user_id() );
revoke all on public.trip_tracking_state from public;
grant select, insert, update on public.trip_tracking_state to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4. get_ride_participants: add an optional p_viewer_id so the
--    service-role API server can compute masking for a specific user.
--    Same masking rules as Phase 1:
--      - car_pool: every member sees everything.
--      - ride_hail_share: only a host (driver / primary rider / booked_by)
--        or the joiner themself see a passenger_joiner's details; other
--        joiners see a masked "Fellow rider". Host identity is never masked.
-- ─────────────────────────────────────────────────────────────
create or replace function public.get_ride_participants(
  p_ride_id uuid,
  p_viewer_id uuid default public.current_user_id()
)
returns table (
  user_id uuid,
  role text,
  display_name text,
  is_verified boolean,
  seats_requested int,
  pickup_label text,
  dropoff_label text,
  details_visible boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select id, driver_id, primary_rider_id, booked_by, ride_mode
    from public.rides
    where id = p_ride_id
  ),
  base as (
    select rr.driver_id as subject_id, 'host_driver'::text as subject_role,
           0 as seats_requested, null::text as pickup_label, null::text as dropoff_label
    from r rr
    union all
    select rb.passenger_id, coalesce(rb.role, 'passenger_joiner'),
           rb.seats_requested, rb.pickup_label, rb.dropoff_label
    from public.ride_bookings rb
    where rb.ride_id = p_ride_id and rb.status = 'accepted'
  )
  select
    b.subject_id,
    b.subject_role,
    case when mask then 'Fellow rider' else u.display_name end,
    coalesce(u.is_verified, false),
    case when mask then null else b.seats_requested end,
    case when mask then null else b.pickup_label end,
    case when mask then null else b.dropoff_label end,
    not mask
  from base b
  cross join r
  join public.users u on u.id = b.subject_id
  cross join lateral (
    select (
      r.ride_mode = 'ride_hail_share'
      and b.subject_role = 'passenger_joiner'
      and b.subject_id <> p_viewer_id
      and not (
        p_viewer_id = r.driver_id
        or p_viewer_id = r.primary_rider_id
        or (r.booked_by is not null and p_viewer_id = r.booked_by)
      )
    ) as mask
  ) m
  where public.is_ride_participant(p_ride_id, p_viewer_id);
$$;

revoke all on function public.get_ride_participants(uuid, uuid) from public;
grant execute on function public.get_ride_participants(uuid, uuid) to authenticated;

-- ========================================================
-- Migration: 20261023000000_party_size.sql
-- ========================================================
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
