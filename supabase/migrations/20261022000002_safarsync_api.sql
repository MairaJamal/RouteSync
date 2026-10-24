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
