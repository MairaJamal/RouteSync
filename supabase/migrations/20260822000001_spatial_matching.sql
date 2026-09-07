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