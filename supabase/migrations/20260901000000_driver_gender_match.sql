-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 1: Women-only ride mode.
--
-- Adds trip_requests.require_driver_gender_match: an opt-in flag a
-- rider can set together with a gendered preference (female_only /
-- male_only) meaning "the ride owner/driver must also be that gender".
--
-- No parallel preference field is created — the existing `preference`
-- column stays the single source of truth; this boolean only tightens
-- it. Default false keeps every existing row and code path unchanged.
--
-- RLS note: Postgres row-level security is row-level, not column-level.
-- The existing trip_requests policies (see 20260822000002_rls_policies.sql
-- and 20260824000000_day4_fixes.sql) already gate whole-row SELECT /
-- INSERT / UPDATE / DELETE, so this new column automatically inherits the
-- exact same visibility rules as `preference` — a viewer who cannot see
-- the row cannot see this column, and an insert/update policy that
-- admits the row admits it. No new policy is required (or possible) for
-- column-level parity; this comment documents that intentionally.
-- ─────────────────────────────────────────────────────────────

alter table public.trip_requests
  add column if not exists require_driver_gender_match boolean not null default false;

comment on column public.trip_requests.require_driver_gender_match is
  'When true together with a gendered preference, the ride owner/driver gender must satisfy that preference. Enforced by the matching pipeline before any OSRM calls.';
