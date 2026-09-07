-- Pooling RLS assertions. Run after 20260825000000_pooling_capacity.sql
-- and 20260826000000_pooling_rls.sql.
--
-- This doesn't try to simulate two authenticated sessions (that needs
-- `set role` + JWT claims, which is easiest to test with the Supabase
-- CLI's local stack); it just guards against the specific regression
-- that motivated this migration: rides/ride_bookings existing with
-- RLS silently OFF.

do $$
declare
  v_rides_rls boolean;
  v_bookings_rls boolean;
  v_policy_count integer;
begin
  select relrowsecurity into v_rides_rls
  from pg_class
  where relname = 'rides' and relnamespace = 'public'::regnamespace;

  select relrowsecurity into v_bookings_rls
  from pg_class
  where relname = 'ride_bookings' and relnamespace = 'public'::regnamespace;

  if not coalesce(v_rides_rls, false) then
    raise exception 'POOLING_RLS failed: row level security is not enabled on public.rides';
  end if;

  if not coalesce(v_bookings_rls, false) then
    raise exception 'POOLING_RLS failed: row level security is not enabled on public.ride_bookings';
  end if;

  select count(*)::integer into v_policy_count
  from pg_policies
  where schemaname = 'public' and tablename in ('rides', 'ride_bookings');

  if v_policy_count < 8 then
    raise exception
      'POOLING_RLS failed: expected at least 8 policies across rides/ride_bookings (4 verbs x 2 tables), found %',
      v_policy_count;
  end if;

  raise notice 'Pooling RLS checks passed: RLS enabled on rides + ride_bookings, % policies present.', v_policy_count;
end;
$$;
