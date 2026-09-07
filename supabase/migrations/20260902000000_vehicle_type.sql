-- ─────────────────────────────────────────────────────────────
-- Day 8 — Owner/passenger matching: does this rider bring a car or bike?
--
-- Adds trip_requests.vehicle_type ('none' | 'car' | 'bike'). Default
-- 'none' keeps every existing row and matching code path byte-for-byte
-- identical — the matching pipeline only takes the owner/passenger fare
-- path (calculateOwnerPassengerFare in fareSplit.ts) when exactly one
-- side of a match has a non-'none' vehicle_type. Two riders who both
-- have a vehicle, or neither does, still fall back to the original
-- peer-share economics.
--
-- Bike capacity note: a bike carries exactly one passenger. This isn't
-- enforced by a CHECK constraint here — it's structural, not row-level:
-- the matching pipeline (matchPipeline.ts) only ever evaluates 1:1
-- pairings, and a trip_request's status flips away from 'pending' once
-- matched, so it stops surfacing as a match candidate at all. A bike
-- owner therefore can't be matched to a second passenger through this
-- flow while their first match is still active.
--
-- RLS note: same rationale as 20260901000000_driver_gender_match.sql —
-- this is a plain column addition to an already-RLS-gated table, so it
-- inherits the existing row-level policies automatically. No new policy
-- is required or possible for column-level parity.
-- ─────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'vehicle_type') then
    create type public.vehicle_type as enum ('none', 'car', 'bike');
  end if;
end $$;

alter table public.trip_requests
  add column if not exists vehicle_type public.vehicle_type not null default 'none';

comment on column public.trip_requests.vehicle_type is
  'Does this rider bring their own car/bike? "none" is the classic peer-to-peer flow. When exactly one side of a match has a vehicle, that side becomes the ride owner and pays nothing; the other pays the full per-km fare as a passenger. See matchPipeline.ts resolveVehicleRoles().';
