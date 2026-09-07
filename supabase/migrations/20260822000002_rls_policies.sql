-- Requested RLS policies for profile visibility, trip-request ownership,
-- and database-level mutual gender compatibility.

alter table public.users enable row level security;
alter table public.trip_requests enable row level security;
alter table public.matches enable row level security;
alter table public.fare_estimates enable row level security;

-- Replace the earlier own-profile-only policy: authenticated users may view
-- profiles, while only the linked auth user may update a profile.
drop policy if exists users_select_own on public.users;
drop policy if exists users_authenticated_select on public.users;
create policy users_authenticated_select
on public.users
for select
to authenticated
using (true);

drop policy if exists users_update_own on public.users;
drop policy if exists users_update_by_auth_user on public.users;
create policy users_update_by_auth_user
on public.users
for update
to authenticated
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

-- The SELECT policy performs the gender compatibility check against the
-- viewer's profile and the request owner's profile inside the database.
drop policy if exists trip_requests_select_own on public.trip_requests;
drop policy if exists trip_requests_mutual_gender_select on public.trip_requests;
create policy trip_requests_mutual_gender_select
on public.trip_requests
for select
to authenticated
using (
  exists (
    select 1
    from public.users as owner_profile
    join public.users as viewer_profile
      on viewer_profile.auth_user_id = auth.uid()
    where owner_profile.id = trip_requests.user_id
      and (
        trip_requests.preference = 'any'
        or (
          trip_requests.preference = 'female_only'
          and viewer_profile.gender = 'female'::public.gender
          and owner_profile.gender = 'female'::public.gender
        )
      )
  )
);

drop policy if exists trip_requests_insert_own on public.trip_requests;
drop policy if exists trip_requests_insert_by_auth_user on public.trip_requests;
create policy trip_requests_insert_by_auth_user
on public.trip_requests
for insert
to authenticated
with check (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists trip_requests_update_own on public.trip_requests;
drop policy if exists trip_requests_update_by_auth_user on public.trip_requests;
create policy trip_requests_update_by_auth_user
on public.trip_requests
for update
to authenticated
using (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists trip_requests_delete_by_auth_user on public.trip_requests;
create policy trip_requests_delete_by_auth_user
on public.trip_requests
for delete
to authenticated
using (
  user_id in (
    select person.id
    from public.users as person
    where person.auth_user_id = auth.uid()
  )
);