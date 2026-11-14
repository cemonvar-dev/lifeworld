-- Weekly tiles that repeat every N weeks (e.g. a barber every 2 weeks).
-- repeat_every: 1 = every week (default); repeat_anchor: Monday of the week the cycle starts.
-- Run once in the Supabase SQL editor. Without it every weekly tile stays every week.
alter table public.tasks add column if not exists repeat_every smallint not null default 1;
alter table public.tasks add column if not exists repeat_anchor date;
alter table public.tasks drop constraint if exists tasks_repeat_every_range;
alter table public.tasks add constraint tasks_repeat_every_range check (repeat_every between 1 and 12);
