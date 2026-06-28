-- LifeWorld monthly day-of-month — run once in the Supabase SQL editor.
-- Lets a monthly task recur on a chosen day (1–31) instead of its creation day.

-- Nullable so existing rows keep working; the app falls back to the task's
-- creation day when day_of_month is null. Clamped 1–31 (the app handles short
-- months, e.g. 31 → 28/30, at read time).
alter table public.tasks
  add column if not exists day_of_month smallint
  check (day_of_month is null or day_of_month between 1 and 31);
