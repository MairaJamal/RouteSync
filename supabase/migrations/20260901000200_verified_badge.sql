-- ─────────────────────────────────────────────────────────────
-- Day 7 (Safety & Trust) — Feature 3: Verified profile badge.
--
-- Adds users.is_verified / users.verified_domain. Verification is
-- granted by the app's verify-student flow, which reuses Supabase
-- Auth's existing email confirmation: the linked auth user's email
-- must be confirmed (email_confirmed_at set) AND its domain must be
-- on the university allowlist (maintained in src/verification.ts).
-- No third-party verification service, no extra email sending.
--
-- Existing users policies (20260822000002_rls_policies.sql) already
-- allow any authenticated user to SELECT profiles while restricting
-- UPDATE to the linked auth user — the badge columns inherit exactly
-- those rules, so a rider can never flip someone else's badge.
-- ─────────────────────────────────────────────────────────────

alter table public.users
  add column if not exists is_verified boolean not null default false,
  add column if not exists verified_domain text;

alter table public.users
  drop constraint if exists users_verified_domain_requires_flag;

-- A domain may only be stored when the badge is actually set, so a row
-- can never imply verification without the boolean agreeing.
alter table public.users
  add constraint users_verified_domain_requires_flag
  check (is_verified or verified_domain is null);

create index if not exists users_verified_idx
  on public.users (is_verified) where is_verified;

comment on column public.users.is_verified is
  'True once the verify-student flow confirmed a Supabase Auth email whose domain is on the university allowlist (src/verification.ts).';
