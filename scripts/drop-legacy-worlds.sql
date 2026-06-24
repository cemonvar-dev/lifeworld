-- Drop the legacy worlds tables — run in the Supabase SQL editor.
--
-- These belonged to the old script.js (no longer loaded by any page). The live
-- app uses tasks / task_logs / task_frequency_days. Dropping is IRREVERSIBLE —
-- export to CSV first if you want to keep the old data.

drop table if exists public.worlds_backup cascade;
drop table if exists public.worlds cascade;
