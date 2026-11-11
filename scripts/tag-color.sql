-- Optional per-tag color (hex like '#3b82f6'), chosen in the Tags panel.
-- Run once in the Supabase SQL editor. The app works without it (no colors).
alter table public.tags add column if not exists color text;
