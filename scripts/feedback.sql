-- Fiblia in-app feedback — run once in the Supabase SQL editor.
-- The feedback button stays hidden until this table exists. Users can only add
-- their own messages; read them in the Supabase Table Editor (service role).

create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message    text not null check (char_length(message) between 1 and 2000),
  page       text,
  language   text,
  user_agent text,
  status     text not null default 'new',
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own" on public.feedback
  for insert to authenticated
  with check (auth.uid() = user_id);

-- No select, update or delete policies: clients cannot read any feedback.
