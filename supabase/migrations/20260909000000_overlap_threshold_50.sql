-- Lower the coarse matching floor from 75% to 50% so partially-overlapping
-- routes (same corridor, different endpoints) still reach the OSRM pipeline.
-- The Node pipeline (matchPipeline.ts MIN_OVERLAP_PCT) uses the same 50% floor.

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
