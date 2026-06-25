-- LifeWorld tags model — STEP 1: schema. Run once in the Supabase SQL editor.
-- Additive and safe: creates a tags table + a tasks.tag_ids column WITHOUT
-- touching the existing tasks.tags strings (kept as a backup until migration is
-- verified). The live app keeps working until the new code is deployed.

-- Named tags with explicit parent/child links and manual ordering.
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  name       text not null,
  parent_id  uuid references public.tags(id) on delete set null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists tags_user_id_idx   on public.tags(user_id);
create index if not exists tags_parent_id_idx  on public.tags(parent_id);

-- Owner-only access (the anon key is public; RLS is the guard).
alter table public.tags enable row level security;
drop policy if exists "tags_owner_select" on public.tags;
drop policy if exists "tags_owner_insert" on public.tags;
drop policy if exists "tags_owner_update" on public.tags;
drop policy if exists "tags_owner_delete" on public.tags;
create policy "tags_owner_select" on public.tags for select using (auth.uid() = user_id);
create policy "tags_owner_insert" on public.tags for insert with check (auth.uid() = user_id);
create policy "tags_owner_update" on public.tags for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tags_owner_delete" on public.tags for delete using (auth.uid() = user_id);

-- Tasks reference tags by id. Additive — the legacy tasks.tags text[] stays put.
alter table public.tasks add column if not exists tag_ids uuid[] not null default '{}';
