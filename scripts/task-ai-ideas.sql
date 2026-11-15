-- Fiblia: web-researched ideas for new tasks — run once in the Supabase SQL editor.
-- When the user adds a task that benefits from a web search (book a pitch, find a
-- course, plan a trip...), /api/ai (mode 'ideas') returns a few options and the app
-- saves them here: { ideas: [{title, detail, url}], tip, at, dismissed? }.
-- Until this column exists, tileideas.js keeps ideas in the browser only.

alter table public.tasks
  add column if not exists ai_ideas jsonb;

-- No RLS change needed: the existing owner policy on public.tasks covers this column.
