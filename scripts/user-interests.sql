-- Fiblia: interests + weekly picks — run once in the Supabase SQL editor.
-- interests: [{ label, detail }]   what the user enjoys (picked in the app or learned by the coach)
-- dislikes:  [text]                picks they marked "Not for me", so the search avoids similar ones
-- picks:     { items: [{ id, interest, title, detail, when, date, url, task, status }], at, seen }
-- Until this table exists, the interests picker and picks stay hidden.

create table if not exists public.user_interests (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  interests  jsonb not null default '[]'::jsonb,
  dislikes   jsonb not null default '[]'::jsonb,
  picks      jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_interests enable row level security;

drop policy if exists "user_interests owner select" on public.user_interests;
drop policy if exists "user_interests owner insert" on public.user_interests;
drop policy if exists "user_interests owner update" on public.user_interests;
drop policy if exists "user_interests owner delete" on public.user_interests;

create policy "user_interests owner select" on public.user_interests
  for select using (auth.uid() = user_id);
create policy "user_interests owner insert" on public.user_interests
  for insert with check (auth.uid() = user_id);
create policy "user_interests owner update" on public.user_interests
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_interests owner delete" on public.user_interests
  for delete using (auth.uid() = user_id);
