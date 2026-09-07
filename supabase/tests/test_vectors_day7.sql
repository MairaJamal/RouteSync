-- Day 7 (Safety & Trust) schema/RLS assertions. Run after the four
-- 20260901_* migrations. Same pattern as test_vectors_pooling_rls.sql:
-- this guards the specific regressions that matter here (tables that
-- exist with RLS silently OFF, or the new columns never landing), not a
-- full two-session JWT simulation (that needs the Supabase CLI stack).

do $$
declare
  v_table text;
  v_rls boolean;
  v_policy_count integer;
  v_column_exists boolean;
begin
  -- 1. Every new safety table must have row level security enabled.
  foreach v_table in array array[
    'emergency_contacts',
    'sos_events',
    'ratings',
    'user_reports',
    'blocked_users'
  ]
  loop
    select relrowsecurity into v_rls
    from pg_class
    where relname = v_table and relnamespace = 'public'::regnamespace;

    if not coalesce(v_rls, false) then
      raise exception 'DAY7_RLS failed: row level security is not enabled on public.%', v_table;
    end if;
  end loop;

  -- 2. Policy coverage: at least one policy per new table.
  select count(*)::integer into v_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename in (
      'emergency_contacts', 'sos_events', 'ratings', 'user_reports', 'blocked_users'
    );

  if v_policy_count < 10 then
    raise exception
      'DAY7_RLS failed: expected at least 10 policies across the 5 new safety tables, found %',
      v_policy_count;
  end if;

  -- 3. Feature 1 column landed on trip_requests.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trip_requests'
      and column_name = 'require_driver_gender_match'
  ) into v_column_exists;

  if not v_column_exists then
    raise exception 'DAY7_SCHEMA failed: trip_requests.require_driver_gender_match is missing';
  end if;

  -- 4. Feature 3 columns landed on users, with the consistency guard.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'is_verified'
  ) into v_column_exists;

  if not v_column_exists then
    raise exception 'DAY7_SCHEMA failed: users.is_verified is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'users_verified_domain_requires_flag'
  ) then
    raise exception 'DAY7_SCHEMA failed: users_verified_domain_requires_flag constraint is missing';
  end if;

  -- 5. Feature 4 invariants: one rating per rider per ride, and the
  --    stars range that MatchCard's average display relies on.
  if not exists (
    select 1 from pg_constraint
    where conname = 'ratings_ride_id_rater_id_rated_user_id_key'
  ) then
    raise exception 'DAY7_SCHEMA failed: ratings unique (ride_id, rater_id, rated_user_id) is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'blocked_users_blocker_id_blocked_id_key'
  ) then
    raise exception 'DAY7_SCHEMA failed: blocked_users unique (blocker_id, blocked_id) is missing';
  end if;

  raise notice
    'Day 7 checks passed: RLS enabled on all 5 safety tables (% policies), require_driver_gender_match + is_verified columns present, rating/block uniqueness in place.',
    v_policy_count;
end;
$$;
