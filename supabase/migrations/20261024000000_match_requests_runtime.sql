-- Required for cross-user ride requests on Vercel/serverless deployments.
create table if not exists public.match_requests (
  id text primary key,
  from_user_id uuid not null references public.users(id) on delete cascade,
  from_name text not null default '',
  to_user_id uuid not null references public.users(id) on delete cascade,
  to_name text not null default '',
  from_trip_request_id uuid references public.trip_requests(id) on delete set null,
  to_trip_request_id uuid references public.trip_requests(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','awaiting_requester','confirmed','declined','cancelled','expired')),
  preferences jsonb not null default '{}'::jsonb,
  conditions jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  chat_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  responded_at timestamptz,
  confirmed_at timestamptz,
  expires_at timestamptz not null default (timezone('utc', now()) + interval '24 hours')
);
create index if not exists idx_match_requests_from on public.match_requests(from_user_id, status);
create index if not exists idx_match_requests_to on public.match_requests(to_user_id, status);
alter table public.match_requests enable row level security;
revoke all on public.match_requests from public;
grant select on public.match_requests to authenticated;
