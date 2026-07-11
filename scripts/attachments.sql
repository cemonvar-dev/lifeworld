-- LifeWorld attachments (photos / screenshots / files) — run once in the
-- Supabase SQL editor. Files live in a PRIVATE storage bucket; the app shows
-- them via short-lived signed URLs. Metadata rows link each file to a task.

-- 1) Private storage bucket.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- 2) Metadata table (one row per uploaded file).
create table if not exists public.task_attachments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null default auth.uid(),
  path       text not null,           -- storage object path: <uid>/<taskId>/<uuid>-<name>
  name       text,                    -- original filename (for display / download)
  mime       text,
  size       bigint,
  created_at timestamptz not null default now()
);
alter table public.task_attachments enable row level security;

-- Premium check: app_metadata.premium is server-set (admin API / LS webhook) and
-- rides in the JWT, so RLS can trust it. Only INSERT (adding files) is gated —
-- SELECT/DELETE stay owner-based so a downgraded user keeps access to existing files.
drop policy if exists "own attachments - select" on public.task_attachments;
drop policy if exists "own attachments - insert" on public.task_attachments;
drop policy if exists "own attachments - delete" on public.task_attachments;
create policy "own attachments - select" on public.task_attachments
  for select using (auth.uid() = user_id);
create policy "own attachments - insert" on public.task_attachments
  for insert with check (
    auth.uid() = user_id
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'premium', 'false') = 'true'
  );
create policy "own attachments - delete" on public.task_attachments
  for delete using (auth.uid() = user_id);

-- 3) Storage RLS: a user can only touch files under their own <uid>/ folder.
drop policy if exists "own files - select" on storage.objects;
drop policy if exists "own files - insert" on storage.objects;
drop policy if exists "own files - delete" on storage.objects;
create policy "own files - select" on storage.objects
  for select using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files - insert" on storage.objects
  for insert with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'premium', 'false') = 'true'
  );
create policy "own files - delete" on storage.objects
  for delete using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
