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
