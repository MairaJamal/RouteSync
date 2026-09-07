-- ─────────────────────────────────────────────────────────────
-- Day 11 — Shared ride-hailing (Yango/inDrive/Careem) fare splitting.
--
-- PROBLEM: vehicle_type only distinguished "none" (classic peer-to-peer)
-- from "car"/"bike" (one side owns a vehicle, rides free, the other pays
-- a computed per-km fare). Neither models a group who books ONE
-- Yango/inDrive/Careem together and splits its already-fixed fare —
-- there, nobody in the app owns or drives anything (the driver is
-- outside the app entirely), so the owner/passenger free-ride economics
-- don't apply, and the fare isn't something OSRM distance can derive —
-- it's whatever the ride-hailing app already quoted.
--
-- FIX: 'ride_hailing' joins the vehicle_type vocabulary, and
-- ride_hailing_fare_pkr carries whichever side's quote gets split. See
-- resolveVehicleRoles()/calculateSharedHailingFareSplit() in
-- matchPipeline.ts / fareSplit.ts for how the split itself works.
--
-- SETTLEMENT NOTE: this only computes and displays the per-person
-- share — actually paying each other happens outside the app (cash or
-- a manual transfer), same as everywhere else fares are shown today.
-- No payment integration is added by this migration.
-- ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'ride_hailing' AND enumtypid = 'public.vehicle_type'::regtype
  ) THEN
    ALTER TYPE public.vehicle_type ADD VALUE 'ride_hailing';
  END IF;
END $$;

alter table public.trip_requests
  add column if not exists ride_hailing_fare_pkr numeric(10, 2);

comment on column public.trip_requests.ride_hailing_fare_pkr is
  'Only meaningful when vehicle_type = ride_hailing. The total fare (PKR) this rider already has a quote for from the ride-hailing app, to be split evenly among everyone in the match/pool. If both sides of a match independently entered a quote, the average is used instead (see matchPipeline.ts).';

-- A ride_hailing request without a fare can never actually be split —
-- enforce it at the data layer too, not just in apiHandler.ts, so a
-- direct insert (or a future code path that forgets the app-level
-- check) can't create an unsplitable request either.
--
-- NOTE: "ride_hailing_fare_pkr > 0" alone is NOT sufficient here — if
-- the column is NULL (never entered), "NULL > 0" evaluates to NULL,
-- and Postgres treats a NULL CHECK result as PASSING, not failing.
-- Verified by actually inserting a ride_hailing row with no fare
-- against a real database: it succeeded silently with the naive
-- version of this constraint. IS NOT NULL must be explicit.
alter table public.trip_requests
  drop constraint if exists trip_requests_ride_hailing_fare_required;
alter table public.trip_requests
  add constraint trip_requests_ride_hailing_fare_required
  check (vehicle_type != 'ride_hailing' OR (ride_hailing_fare_pkr IS NOT NULL AND ride_hailing_fare_pkr > 0));
