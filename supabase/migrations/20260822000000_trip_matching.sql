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
  where route.route_overlap_pct >= 75
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