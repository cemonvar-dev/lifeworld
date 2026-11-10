-- Fiblia quick list notes — run once in the Supabase SQL editor.
-- Lets a list (tag) hold free-form meeting notes. The notes area stays hidden
-- until this column exists.

alter table public.tags
  add column if not exists notes text;

-- No RLS change needed: the existing owner policy on public.tags already covers
-- this column.
