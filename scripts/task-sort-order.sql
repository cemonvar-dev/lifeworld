-- LifeWorld — manual tile ordering (drag-and-drop priority). Run once in the
-- Supabase SQL editor. Adds a per-task sort_order used to order tiles within
-- each tag group; lower = higher priority. Safe to re-run.

alter table public.tasks
  add column if not exists sort_order integer;

-- Seed a stable initial order for existing rows (by creation time) so the first
-- drag has something to reorder against. Only touches rows that are still NULL.
with ranked as (
  select id, row_number() over (partition by user_id order by created_at) - 1 as rn
  from public.tasks
  where sort_order is null
)
update public.tasks t
set sort_order = ranked.rn
from ranked
where t.id = ranked.id;
