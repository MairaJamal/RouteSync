-- Day 4 assertions. Run supabase/seed.sql, supabase/seed_day4.sql, then this
-- file, after applying 20260824000000_day4_fixes.sql.

do $$
declare
  v_overload_count integer;
  v_v4_match_count integer;
  v_v4_overlap numeric;
begin
  -- BUG 1 regression check: exactly one find_matching_trip_requests overload.
  select count(*)::integer
  into v_overload_count
  from pg_proc
  where proname = 'find_matching_trip_requests';

  if v_overload_count <> 1 then
    raise exception
      'DAY4_RPC_OVERLOAD failed: expected exactly 1 find_matching_trip_requests overload, found %',
      v_overload_count;
  end if;

  -- V4_MALE_ONLY: symmetric male_only <-> any should match on overlap,
  -- same corridor as V1 (F-10 + G-9 -> NUST).
  select max(result.route_overlap_pct), count(*)::integer
  into v_v4_overlap, v_v4_match_count
  from public.find_matching_trip_requests(
    p_trip_request_id => '20000000-0000-4000-8000-000000000007',
    p_limit => 50
  ) as result
  where result.candidate_request_id = '20000000-0000-4000-8000-000000000008';

  if v_v4_match_count <> 1 or coalesce(v_v4_overlap, 0) < 75 then
    raise exception 'V4_MALE_ONLY failed: expected a match at >= 75%%, got count=%, overlap=%',
      v_v4_match_count, v_v4_overlap;
  end if;

  raise notice 'Day 4 checks passed: single RPC overload, male_only matching works.';
end;
$$;
