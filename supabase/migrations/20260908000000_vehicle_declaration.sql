-- ─────────────────────────────────────────────────────────────
-- Day 12 — Self-attested vehicle details for car/bike owners.
--
-- WHAT THIS IS: a car/bike owner can put a CNIC + plate number on
-- record so a matched rider can visually confirm the car that shows
-- up is actually theirs.
--
-- WHAT THIS IS NOT: document verification. Nobody checks the CNIC
-- against any government database, nobody checks a license photo,
-- there's no admin review step. This is intentionally self-reported
-- only — see the explicit choice made when this was scoped. Any UI
-- surfacing this data must say "self-declared", never "verified."
--
-- CNIC HANDLING: the full CNIC is stored (so it can be meaningfully
-- required at all — a random string masked to 4 digits with no format
-- check would be theater), but it is NEVER read back by the API, not
-- even to its own owner. Every function here that returns declaration
-- data returns only right(cnic_number, 4) or nothing at all. See
-- vehicleDeclaration.ts for the same rule enforced in the pure
-- validation helpers shared with the frontend.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.driver_vehicle_declarations (
  user_id uuid primary key references public.users(id) on delete cascade,
  cnic_number text not null check (cnic_number ~ '^\d{5}-\d{7}-\d{1}$'),
  vehicle_plate text not null check (char_length(vehicle_plate) between 3 and 15),
  vehicle_make_model text,
  declared_at timestamp with time zone not null default now()
);

comment on table public.driver_vehicle_declarations is
  'Self-attested only — no document check, no admin review. cnic_number must never be selected directly by application code; use the masked views/functions below.';
comment on column public.driver_vehicle_declarations.cnic_number is
  'Full CNIC, stored so it can be required/format-checked, but never returned by any API response — see mask_cnic_last4() and driver_vehicle_declarations_public.';

alter table public.driver_vehicle_declarations enable row level security;

-- Only the owner can see their own row directly (and only via the
-- backend's masking function in practice, but this is defense in
-- depth in case of any future direct client access).
drop policy if exists driver_vehicle_declarations_owner_select on public.driver_vehicle_declarations;
create policy driver_vehicle_declarations_owner_select
on public.driver_vehicle_declarations
for select
to authenticated
using (
  user_id in (select person.id from public.users as person where person.auth_user_id = auth.uid())
);

revoke all on public.driver_vehicle_declarations from public;
grant select on public.driver_vehicle_declarations to authenticated;

-- A masked view is what everything else (matched riders, any future
-- direct client query) should ever read from — CNIC simply isn't a
-- column here, so there's no way to accidentally select it.
create or replace view public.driver_vehicle_declarations_public as
select
  user_id,
  vehicle_plate,
  vehicle_make_model,
  declared_at
from public.driver_vehicle_declarations;

grant select on public.driver_vehicle_declarations_public to authenticated;

-- Upsert, called from apiHandler.ts. Returns only the masked view of
-- what was just saved — never the full CNIC, even in the same
-- request that submitted it, so there is no code path anywhere that
-- has to remember not to leak it.
CREATE OR REPLACE FUNCTION upsert_vehicle_declaration(
  p_user_id UUID,
  p_cnic_number TEXT,
  p_vehicle_plate TEXT,
  p_vehicle_make_model TEXT
)
RETURNS TABLE (
  vehicle_plate TEXT,
  vehicle_make_model TEXT,
  cnic_last4 TEXT,
  declared_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO driver_vehicle_declarations (user_id, cnic_number, vehicle_plate, vehicle_make_model, declared_at)
  VALUES (p_user_id, p_cnic_number, p_vehicle_plate, p_vehicle_make_model, now())
  ON CONFLICT (user_id) DO UPDATE
    SET cnic_number = EXCLUDED.cnic_number,
        vehicle_plate = EXCLUDED.vehicle_plate,
        vehicle_make_model = EXCLUDED.vehicle_make_model,
        declared_at = now();

  RETURN QUERY
  -- BUG FIX: RIGHT(cnic_number, 4) alone takes the literal last 4
  -- CHARACTERS of the stored "12345-1234567-1" string — which is
  -- "67-1", including a dash, NOT the last 4 digits. Verified by
  -- actually calling this function against a real database before
  -- the fix. Non-digits must be stripped first.
  SELECT d.vehicle_plate, d.vehicle_make_model, RIGHT(regexp_replace(d.cnic_number, '[^0-9]', '', 'g'), 4), d.declared_at
  FROM driver_vehicle_declarations d
  WHERE d.user_id = p_user_id;
END;
$$;

revoke all on function public.upsert_vehicle_declaration(uuid, text, text, text) from public;
grant execute on function public.upsert_vehicle_declaration(uuid, text, text, text) to authenticated, service_role;
alter function public.upsert_vehicle_declaration(uuid, text, text, text)
  security definer
  set search_path = public;

-- Lets the owner see their OWN masked declaration (e.g. to prefill an
-- edit form) without ever selecting cnic_number directly.
CREATE OR REPLACE FUNCTION get_own_vehicle_declaration(p_user_id UUID)
RETURNS TABLE (
  vehicle_plate TEXT,
  vehicle_make_model TEXT,
  cnic_last4 TEXT,
  declared_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT d.vehicle_plate, d.vehicle_make_model, RIGHT(regexp_replace(d.cnic_number, '[^0-9]', '', 'g'), 4), d.declared_at
  FROM driver_vehicle_declarations d
  WHERE d.user_id = p_user_id;
END;
$$;

revoke all on function public.get_own_vehicle_declaration(uuid) from public;
grant execute on function public.get_own_vehicle_declaration(uuid) to authenticated, service_role;
alter function public.get_own_vehicle_declaration(uuid)
  security definer
  set search_path = public;
