-- LifeWorld — simplify task status to a binary model. Run once in the Supabase
-- SQL editor. A tile is now either 'completed' or 'in progress' (not completed).
-- The old 'active' / 'planned' / 'failed' / 'cancelled' values all collapse to
-- 'in progress'. 'completed' is preserved.

update public.tasks
set status = 'in progress'
where status is distinct from 'completed';
