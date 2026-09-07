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
