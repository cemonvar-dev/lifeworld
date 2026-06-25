-- LifeWorld tags model — STEP 2: migrate legacy dotted tags -> tags + tag_ids.
-- Run AFTER tags-schema.sql, in the Supabase SQL editor.
--
-- SAFE: additive only. It populates the new tags table and tasks.tag_ids; it
-- does NOT touch the legacy tasks.tags strings (your backup). The currently
-- deployed app ignores these new columns, so running this won't affect it.
--
-- RE-RUNNABLE: it wipes previously migrated tags + tag assignments first, so you
-- can run it, inspect the result, tweak, and run again. (A re-run resets tag_ids,
-- so do final manual re-assignments only after you're happy with the structure.)

-- Remember each tag's source key so we can map + re-run.
alter table public.tags add column if not exists legacy_key text;

-- Clean slate for re-runs.
update public.tasks set tag_ids = '{}' where tag_ids <> '{}';
delete from public.tags where legacy_key is not null;

-- 1. One tag per distinct legacy string. name = label part (numbers dropped),
--    sort_order = last numeric segment, user_id taken from the tasks' owner.
insert into public.tags (user_id, name, legacy_key, sort_order)
select
  (select user_id from public.tasks where user_id is not null limit 1),
  coalesce(substring(key from '^[0-9.]+-(.*)$'), key),
  key,
  coalesce(nullif(substring(substring(key from '^[0-9.]+') from '[0-9]+$'), '')::int, 0)
from (select distinct unnest(tags) as key from public.tasks where tags is not null) d
where key is not null and key <> '';

-- 2. Link parents by numeric prefix (e.g. 04.01.02 -> parent 04.01). Tags whose
--    parent number has no matching tag (like the missing "14") stay top-level.
update public.tags c
set parent_id = p.id
from public.tags p
where c.legacy_key is not null
  and p.legacy_key is not null
  and p.id <> c.id
  and regexp_replace(substring(c.legacy_key from '^[0-9.]+'), '\.?[0-9]+$', '') <> ''
  and substring(p.legacy_key from '^[0-9.]+')
      = regexp_replace(substring(c.legacy_key from '^[0-9.]+'), '\.?[0-9]+$', '');

-- 3. Strip the parent's name prefix from children (defne-hobby -> hobby).
update public.tags c
set name = substring(c.name from char_length(p.name) + 2)
from public.tags p
where c.parent_id = p.id
  and c.name like p.name || '-%';

-- 4. Point each task at its new tag ids (matched via legacy_key).
update public.tasks t
set tag_ids = coalesce((
  select array_agg(tg.id)
  from public.tags tg
  where tg.legacy_key = any(t.tags)
), '{}');

-- ---- Verify (optional): inspect the resulting tree ----
-- select coalesce(p.name,'(root)') as parent, c.name, c.sort_order, c.legacy_key
-- from public.tags c left join public.tags p on p.id = c.parent_id
-- order by p.name nulls first, c.sort_order;
