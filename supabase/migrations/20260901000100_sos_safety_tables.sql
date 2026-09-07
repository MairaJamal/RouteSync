-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 2: SOS button + live trip share.
--
-- Two tables, both strictly owner-scoped:
--   emergency_contacts — up to 3 trusted contacts per user, E.164 phones.
--   sos_events         — the user's own audit trail of SOS triggers.
--
-- Deliberately zero-cost: no SMS gateway, no third-party tracking. The
-- SOS flow itself runs client-side (browser Geolocation API + wa.me deep
-- links); these tables only persist the contact list and the audit log.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  contact_name text not null check (length(trim(contact_name)) between 1 and 80),
  -- E.164: leading +, 8-15 digits (ITU-T E.164), e.g. +923001234567
  contact_phone text not null check (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, contact_phone)
);

create index if not exists emergency_contacts_user_idx
  on public.emergency_contacts (user_id);

-- DB-side cap of 3 contacts per user, matching the API-side check, so a
-- direct client insert can't exceed it either.
create or replace function public.enforce_emergency_contact_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.emergency_contacts
    where user_id = new.user_id
  ) >= 3 then
    raise exception using
      errcode = 'check_violation',
      message = 'EMERGENCY_CONTACT_LIMIT_REACHED',
      detail = 'Each rider may keep at most 3 emergency contacts.';
  end if;
  return new;
end;
$$;

drop trigger if exists emergency_contacts_enforce_limit on public.emergency_contacts;
create trigger emergency_contacts_enforce_limit
before insert on public.emergency_contacts
for each row execute function public.enforce_emergency_contact_limit();

create table if not exists public.sos_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  trip_request_id uuid references public.trip_requests(id) on delete set null,
  ride_id uuid,
  lat numeric(9, 6) not null check (lat between -90 and 90),
  lng numeric(9, 6) not null check (lng between -180 and 180),
  triggered_at timestamptz not null default timezone('utc', now())
);

create index if not exists sos_events_user_idx
  on public.sos_events (user_id, triggered_at);

-- ─── RLS ────────────────────────────────────────────────────
-- Same auth_user_id -> users.id mapping as 20260822000002_rls_policies.sql.
-- A user can only ever read/write their own rows — a safety table that
-- leaked other riders' emergency contacts would be worse than none.

alter table public.emergency_contacts enable row level security;
alter table public.sos_events enable row level security;

drop policy if exists emergency_contacts_select_own on public.emergency_contacts;
create policy emergency_contacts_select_own
on public.emergency_contacts
for select
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists emergency_contacts_insert_own on public.emergency_contacts;
create policy emergency_contacts_insert_own
on public.emergency_contacts
for insert
to authenticated
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists emergency_contacts_update_own on public.emergency_contacts;
create policy emergency_contacts_update_own
on public.emergency_contacts
for update
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
)
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists emergency_contacts_delete_own on public.emergency_contacts;
create policy emergency_contacts_delete_own
on public.emergency_contacts
for delete
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

-- sos_events is an audit trail: the triggering user inserts and reads
-- their own events only. No UPDATE/DELETE policies at all — an audit
-- row must not be silently rewritable by the client.

drop policy if exists sos_events_select_own on public.sos_events;
create policy sos_events_select_own
on public.sos_events
for select
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists sos_events_insert_own on public.sos_events;
create policy sos_events_insert_own
on public.sos_events
for insert
to authenticated
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

revoke all on function public.enforce_emergency_contact_limit() from public;
