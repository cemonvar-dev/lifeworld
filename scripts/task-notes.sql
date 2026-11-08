-- Fiblia tile notes — run once in the Supabase SQL editor.
-- Adds free-text notes to a task. The notes field in the tile popup stays hidden
-- until this column exists. NULL = no notes.

alter table public.tasks
  add column if not exists notes text;

-- No RLS change needed: the existing owner policy on public.tasks already covers
-- this column (users read/update their own rows).
