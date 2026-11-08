-- Fiblia tile pinning — run once in the Supabase SQL editor.
-- Pinned tiles appear in a Pinned section at the top of the gallery.

alter table public.tasks
  add column if not exists pinned boolean not null default false;

-- No RLS change needed: the existing owner policy on public.tasks already covers
-- this column (users read/update their own rows).
