-- LifeWorld billing → premium mapping — run once in the Supabase SQL editor.
-- Lets api/lemonsqueezy-webhook.js resolve a Lemon Squeezy customer back to a
-- Supabase user for subscription events that lack custom_data.

create table if not exists public.billing_customers (
  user_id     uuid not null,
  customer_id text not null,
  updated_at  timestamptz not null default now(),
  primary key (customer_id)
);

create index if not exists billing_customers_user_id_idx
  on public.billing_customers (user_id);

-- Service-role only; clients never read or write this mapping.
alter table public.billing_customers enable row level security;
-- (No policies = no anon/authenticated access. Service role bypasses RLS.)
