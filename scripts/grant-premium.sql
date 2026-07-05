-- LifeWorld — manually grant/revoke premium for a user.
-- Run in the Supabase SQL editor. Premium is the app_metadata.premium flag that
-- api/ai.js checks (and the Lemon Squeezy webhook flips); there is no separate
-- "premium list" table. Merges the flag in without touching login/provider data.
--
-- Replace the UUID below with the target user's id (auth.users.id).
-- UPDATE 1 = applied; UPDATE 0 = no user with that id.

-- Grant premium:
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"premium": true}'::jsonb
where id = '00000000-0000-0000-0000-000000000000';

-- Revoke premium (run instead of the above):
-- update auth.users
-- set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"premium": false}'::jsonb
-- where id = '00000000-0000-0000-0000-000000000000';

-- Check current premium users:
-- select id, email, raw_app_meta_data->>'premium' as premium
-- from auth.users
-- where raw_app_meta_data->>'premium' = 'true';

-- Note: if the user has a Lemon Squeezy subscription, a later non-active
-- subscription event will flip premium back off via the webhook. This manual
-- grant is intended for comped users without an LS subscription.
