-- Fiblia — RLS / access-isolation audit
-- Run in Supabase → SQL Editor. Read-only; makes no changes.
-- Goal (readiness checklist S-01): prove that no user can read/modify another
-- user's data via the anon/authenticated keys. The dashboard itself uses the
-- service role and bypasses RLS — that's expected and not what this audits.
--
-- What "good" looks like:
--   • Every user-data table in section 1 shows rls_enabled = true.
--   • Section 2 (tables without RLS) returns ZERO rows.
--   • Section 3 (RLS on but no policies) returns ZERO rows for tables the app reads.
--   • Section 5 (permissive policies, qual/with_check = true) returns ZERO rows,
--     or only rows you can explain.
--   • Section 4 policies are keyed to the user, e.g. (auth.uid() = user_id).
--   • Section 8 storage buckets: user-content buckets are public = false.
--   • Section 9 storage policies restrict objects to their owner.

-- 1) RLS status for every table in public --------------------------------------
select c.relname            as table_name,
       c.relrowsecurity     as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity asc, c.relname;   -- rls_enabled = false floats to top

-- 2) RED FLAG: public tables with RLS DISABLED ---------------------------------
select c.relname as table_without_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
order by c.relname;

-- 3) RLS enabled but NO policies (nothing is allowed for anon/auth — usually a mistake)
select c.relname as table_rls_on_but_no_policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = true
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  )
order by c.relname;

-- 4) All policies, with their USING (qual) and WITH CHECK expressions ----------
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- 5) RED FLAG: overly permissive policies (allow everyone/everything) ----------
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and (qual = 'true' or with_check = 'true'
       or roles @> array['anon']::name[])   -- anon granted access — review each
order by tablename, cmd;

-- 6) Views (RLS does NOT apply to a view unless it has security_invoker = on) --
select c.relname as view_name, c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
order by c.relname;

-- 7) SECURITY DEFINER functions in public (run with owner privileges — review) -
select p.proname as function_name, pg_get_userbyid(p.proowner) as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef = true
order by p.proname;

-- 8) Storage buckets — user-content buckets should be public = false ----------
select id, name, public, created_at
from storage.buckets
order by name;

-- 9) Storage object policies (should restrict to the owner / their folder) -----
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by cmd, policyname;
