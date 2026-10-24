-- ─────────────────────────────────────────────────────────────
-- SOS auto-dispatch audit log.
--
-- WHY A SEPARATE TABLE FROM sos_events:
--   sos_events  = "the rider pressed SOS, here's where they were" (one
--                 row per trigger — the existing Day 7 audit trail).
--   sos_alerts  = "for that trigger, here is every recipient we
--                 prepared an alert for, over which channel, and what
--                 the delivery status is" (many rows per event).
--
-- The status column is deliberately honest about what "sent" means on
-- a zero-cost web app. A browser cannot silently send SMS/WhatsApp, so
-- unless a real gateway is wired (see src/sosGateway.ts), a row lands
-- as 'logged' — the platform recorded and prepared the alert, and the
-- rider completes the final on-device tap. 'sent' is reserved for a
-- confirmed hand-off to a configured gateway; 'queued' for a gateway
-- that accepted but hasn't confirmed; 'failed' for a rejected send.
-- This is what lets the UI show a truthful per-recipient status rather
-- than a fake green "Sent to Police".
-- ─────────────────────────────────────────────────────────────

create table if not exists public.sos_alerts (
  id uuid primary key default gen_random_uuid(),
  sos_event_id uuid references public.sos_events(id) on delete set null,
  user_id uuid not null references public.users(id) on delete cascade,

  recipient_name text not null check (length(trim(recipient_name)) between 1 and 120),
  -- Nullable: the national police helpline (15) has no E.164 number,
  -- and an OSM station may be tagged without a phone.
  recipient_phone text,
  recipient_kind text not null check (recipient_kind in ('emergency_contact', 'police')),
  channel text not null check (channel in ('whatsapp', 'sms', 'call', 'log')),
  status text not null default 'logged'
    check (status in ('logged', 'sent', 'queued', 'failed')),

  -- The exact auto-composed message + live location link we shared,
  -- so the rider (and any later review) can see precisely what went out.
  message text not null,
  location_link text,
  lat numeric(9, 6) check (lat between -90 and 90),
  lng numeric(9, 6) check (lng between -180 and 180),

  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists sos_alerts_user_idx
  on public.sos_alerts (user_id, created_at);
create index if not exists sos_alerts_event_idx
  on public.sos_alerts (sos_event_id);

-- ─── RLS ────────────────────────────────────────────────────
-- Same auth_user_id -> users.id mapping as the other safety tables
-- (20260901000100_sos_safety_tables.sql). Owner can read + insert their
-- own alert rows only. No UPDATE/DELETE policies: like sos_events this
-- is an audit trail and must not be silently rewritable by the client.

alter table public.sos_alerts enable row level security;

drop policy if exists sos_alerts_select_own on public.sos_alerts;
create policy sos_alerts_select_own
on public.sos_alerts
for select
to authenticated
using (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);

drop policy if exists sos_alerts_insert_own on public.sos_alerts;
create policy sos_alerts_insert_own
on public.sos_alerts
for insert
to authenticated
with check (
  user_id in (
    select person.id from public.users as person
    where person.auth_user_id = auth.uid()
  )
);
