-- Fiblia public API keys — run once in the Supabase SQL editor.
-- Backs /api/v1 (api/v1.js). Only a SHA-256 hash of each key is stored; the
-- plaintext key is shown to the user once, at creation.

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null default 'API key',
  prefix       text not null,                 -- first characters, for display ("fib_ab12…")
  key_hash     text not null unique,          -- sha256(key), hex
  scopes       text[] not null default array['read','write'],
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists api_keys_user_idx on public.api_keys(user_id);

-- Locked down: only the service role (server) reads or writes keys.
-- The app manages keys through /api/v1/keys with the user's session.
alter table public.api_keys enable row level security;
-- (No policies = no access for anon/authenticated roles.)
