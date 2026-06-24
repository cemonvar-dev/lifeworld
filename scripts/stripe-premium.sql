-- LifeWorld Stripe premium mapping — run once in the Supabase SQL editor.
-- Lets api/stripe-webhook.js resolve a Stripe customer back to a Supabase user
-- for subscription.updated / subscription.deleted events.

create table if not exists public.stripe_customers (
  user_id     uuid not null,
  customer_id text not null,
  updated_at  timestamptz not null default now(),
  primary key (customer_id)
);

create index if not exists stripe_customers_user_id_idx
  on public.stripe_customers (user_id);

-- Service-role only; clients never read or write this mapping.
alter table public.stripe_customers enable row level security;
-- (No policies = no anon/authenticated access. Service role bypasses RLS.)
