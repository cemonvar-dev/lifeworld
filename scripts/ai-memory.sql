-- LifeWorld AI long-term memory — run once in the Supabase SQL editor.
-- Stores a compact, evolving profile per user that api/ai.js injects into the
-- system prompt every session (so the assistant "remembers" across chats), and
-- updates after each chat exchange.

create table if not exists public.ai_memory (
  user_id    uuid primary key,
  notes      text not null default '',
  updated_at timestamptz not null default now()
);

-- Service-role only (written/read by api/ai.js). Clients never touch it directly.
alter table public.ai_memory enable row level security;
-- (No policies = no anon/authenticated access. Service role bypasses RLS.)

-- To wipe a user's memory (fresh start):
-- delete from public.ai_memory where user_id = '00000000-0000-0000-0000-000000000000';
