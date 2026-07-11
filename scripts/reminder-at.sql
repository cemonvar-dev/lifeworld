-- LifeWorld per-tile reminder — run once in the Supabase SQL editor.
-- Adds an optional one-shot reminder timestamp to a task. When set, the native
-- app schedules a single local notification at that moment (see scheduleReminders
-- in lifeworld.js). NULL = no reminder. This is independent of the recurring
-- frequency-based reminders.

alter table public.tasks
  add column if not exists reminder_at timestamptz;

-- No RLS change needed: the existing owner policy on public.tasks already covers
-- this column (users read/update their own rows).
