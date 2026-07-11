# LifeWorld — Visual Habit & Growth Tracker

LifeWorld is a lightweight, visual, tile-based personal growth tracker. Each
habit or task is a **tile** whose health "grows" or "wilts" based on how
consistently you act on it — a gentle, identity-based motivation system.

Built with vanilla **HTML / CSS (Tailwind) / JavaScript**, **Supabase** for auth
and data, **OpenAI** (via a Vercel serverless function) for the AI assistant, and
**Capacitor 7** for the native Android app. Runs as a web app / PWA and as an
installable Android APK from the same codebase.

- **Web:** https://lifeworld.vercel.app
- **Android:** APK built in CI (GitHub Actions, Capacitor 7, JDK 21)

## Features

### Tiles & health
- Dynamic, tag-grouped tiles — no fixed grid. Add a tile with the **+** button
  (type or **dictate** the title with the 🎤 mic).
- Each tile shows a **health emoji** based on recent adherence: ⭐ Thriving →
  ☀️ Healthy → ⛅ Growing → 🌧️ Wilting → ⚡ Dying.
- **Lifecycle states** get a status flag instead of a health emoji:
  🏁 Completed · 🚫 Cancelled · 🏴 Failed.
- Quick **✅ Done / ⏭️ Skip** per day, straight from the card. Flags are
  date-based, so they reset automatically each morning (history is preserved).

### Frequencies
- **Daily**, **Weekly** (specific weekdays), **Monthly** (a chosen day of the
  month, clamped for short months), and **Once** (a specific date).
- Frequency drives the next-due label, health calculation, and reminders.

### Calendar
- **Long-term plan:** all planned (once) tasks, grouped by month, with
  complete / reschedule actions and row checkboxes.
- **🤖 Auto Reschedule:** sends the planned tasks to the AI, which spreads
  same-category events out over time (and pulls overdue items forward), then
  previews the changes before applying.
- **Today's items** and a combined **Today's summary** (remaining + done/skip).

### Filters & search
- Search by tile name or tag.
- Filter by **Status**, **Tags** (selecting a parent tag includes all child
  tags), **Frequency**, **Lifecycle** (defaults to 🔥 Active), and **Mood**
  (health state).

### AI assistant
- Chat coach grounded in your task data (OpenAI, `gpt-4o-mini` by default).
- Per-user **daily message quota** (default 25) enforced server-side; premium
  accounts bypass it.
- Can **create, update, and delete tasks** on request.

### Attachments (Premium)
- Attach **photos, screenshots, and files** to any tile — thumbnails for
  images, a file chip for other types; open in a new tab or delete.
- Stored in a **private** Supabase Storage bucket (per-user RLS, short-lived
  signed URLs). Images are compressed client-side; **10 MB** per-file cap.
- **Premium-gated in RLS** (uploads require `app_metadata.premium`), not just
  in the UI. See `scripts/attachments.sql`.

### Reminders
- **Native Android:** local notifications every **4 hours** during waking
  hours for every active task, with **Done / Skip** action buttons that log
  straight to Supabase.
- **Per-tile reminder:** set a one-shot reminder (preset or custom date/time)
  from a tile's detail; fires a native notification, and surfaces on the web
  in the **🔔 bell** (with an optional browser notification).

### Settings
- Voice-recognition **language** (English, German, Italian, Spanish, Turkish),
  used for mic dictation.

## Architecture
- **Frontend:** `lifeworld.html` + `lifeworld.js` (Tailwind via CDN, Choices.js,
  flatpickr). Served statically from Vercel; the Android shell loads the same URL.
- **Backend:** Vercel serverless functions in `api/` (dependency-free, e.g.
  `api/ai.js`). Secrets live in Vercel env vars.
- **Data:** Supabase — `tasks`, `task_logs`, `task_frequency_days`, `tags`,
  `ai_usage`, `ai_memory`, `task_attachments` (+ an `attachments` Storage
  bucket). Row-Level Security scopes every row to its owner.
- **Auth:** Supabase with Google OAuth (native PKCE + deep link on Android).
- **Mobile:** Capacitor 7; the native Android project is generated and signed in
  GitHub Actions. Plugins: local notifications, speech recognition, social login.
- **One-time SQL migrations** live in `scripts/*.sql` (run in the Supabase SQL
  editor).

## Development
This is a static site — open `lifeworld.html` (or serve the folder) and it talks
to the live Supabase project. The Android APK is produced by the
`Build Android APK` GitHub Actions workflow; no local Android toolchain required.
