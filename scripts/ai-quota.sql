-- LifeWorld AI quota — run once in the Supabase SQL editor.
-- Backs the per-user daily rate limit enforced by api/ai.js.

-- 1. Usage table: one row per user per day.
create table if not exists public.ai_usage (
  user_id    uuid not null,
  usage_date date not null default current_date,
  count      int  not null default 0,
  primary key (user_id, usage_date)
);

-- Lock the table down. Only the service role (used by api/ai.js) touches it;
-- clients have no business reading or writing it directly.
alter table public.ai_usage enable row level security;
-- (No policies = no access for anon/authenticated roles. Service role bypasses RLS.)

-- 2. Atomic "consume one unit if under the limit" function.
--    Returns allowed=false without incrementing once the daily limit is hit,
--    so a blocked request never costs the user a unit.
create or replace function public.consume_ai_quota(p_user_id uuid, p_limit int)
returns table(allowed boolean, used int, day_limit int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.ai_usage (user_id, usage_date, count)
  values (p_user_id, current_date, 0)
  on conflict (user_id, usage_date) do nothing;

  select count into v_count
    from public.ai_usage
   where user_id = p_user_id and usage_date = current_date
   for update;

  if v_count >= p_limit then
    return query select false, v_count, p_limit;
  else
    update public.ai_usage
       set count = count + 1
     where user_id = p_user_id and usage_date = current_date
     returning count into v_count;
    return query select true, v_count, p_limit;
  end if;
end;
$$;

-- Only the service role should call this RPC.
revoke all on function public.consume_ai_quota(uuid, int) from public, anon, authenticated;

-- Optional housekeeping: purge rows older than 30 days (run manually or via a cron job).
-- delete from public.ai_usage where usage_date < current_date - 30;
