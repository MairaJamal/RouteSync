-- ─────────────────────────────────────────────────────────────
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
-- are deliberately NOT here — those are Phase 2. Existing 1:1 / group
-- booking behaviour is left byte-for-byte intact by this file.
-- ─────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────
-- 6. Row Level Security.
--    The API server runs as the service role (bypasses RLS); these
--    policies protect any direct/authenticated access and are what
--    Supabase Realtime evaluates for a subscriber's own connection.
-- ─────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────
-- 7. get_ride_participants(ride_id): the SINGLE authorised way to list a
--    ride's people, with joiner-detail redaction enforced server-side (we
--    never rely on client filtering).
--
--    Visibility of a passenger_joiner's details (name/pickup/dropoff/party
--    size):
--      - car_pool: every member sees everything (they must recognise each
--        other at the roadside).
--      - ride_hail_share: only the driver, primary rider, or booked_by (a
--        "host") — or the joiner themself — see a joiner's details. Other
--        joiners see a masked "Fellow rider".
--    Host identities (driver / primary rider) are never masked.
--
--    ASSUMPTION (spec gap): public.users has no phone column today, so no
--    phone is returned; redaction covers name, pickup, dropoff and party
--    size. If a phone is added later it must flow through this same RPC.
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 8. Supabase Realtime for ride_messages and live_locations.
--    Guarded so it no-ops on any project where the publication is absent
--    or already contains the table, and never fails the migration.
-- ─────────────────────────────────────────────────────────────
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
