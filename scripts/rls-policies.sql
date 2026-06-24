-- LifeWorld Row Level Security fix — RUN THIS IN THE SUPABASE SQL EDITOR ASAP.
--
-- An unauthenticated probe with only the public anon key returned real rows from
-- task_logs, worlds, and worlds_backup — i.e. every user's data was world-readable.
-- This enables RLS and adds owner-only policies so each user can touch only their
-- own rows. Safe to re-run (idempotent). Logged-in users are unaffected (they only
-- ever access their own data); the service role bypasses RLS for server code.

-- ---------- worlds ----------
alter table public.worlds enable row level security;
drop policy if exists "lw_worlds_owner" on public.worlds;
create policy "lw_worlds_owner" on public.worlds
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- worlds_backup ----------
alter table public.worlds_backup enable row level security;
drop policy if exists "lw_worlds_backup_owner" on public.worlds_backup;
create policy "lw_worlds_backup_owner" on public.worlds_backup
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- task_logs (owned via parent tasks.task_id) ----------
alter table public.task_logs enable row level security;
drop policy if exists "lw_task_logs_owner" on public.task_logs;
create policy "lw_task_logs_owner" on public.task_logs
  for all
  using (exists (
    select 1 from public.tasks t
    where t.id = task_logs.task_id and t.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.tasks t
    where t.id = task_logs.task_id and t.user_id = auth.uid()
  ));

-- ---------- task_frequency_days (owned via parent tasks.task_id) ----------
alter table public.task_frequency_days enable row level security;
drop policy if exists "lw_task_frequency_days_owner" on public.task_frequency_days;
create policy "lw_task_frequency_days_owner" on public.task_frequency_days
  for all
  using (exists (
    select 1 from public.tasks t
    where t.id = task_frequency_days.task_id and t.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.tasks t
    where t.id = task_frequency_days.task_id and t.user_id = auth.uid()
  ));

-- ---------- tasks (should already be protected; included for completeness) ----------
-- Uncomment ONLY if the anon probe showed tasks leaking. If tasks already returns
-- [] to an anonymous request, leave this commented to avoid duplicate policies.
-- alter table public.tasks enable row level security;
-- drop policy if exists "lw_tasks_owner" on public.tasks;
-- create policy "lw_tasks_owner" on public.tasks
--   for all
--   using (auth.uid() = user_id)
--   with check (auth.uid() = user_id);

-- ---------- Verify ----------
-- After running, check RLS is enabled everywhere:
--   select relname, relrowsecurity from pg_class
--   where relname in ('tasks','task_logs','task_frequency_days','worlds','worlds_backup');
-- relrowsecurity must be true for every row.
