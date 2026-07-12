# LifeWorld — Roadmap

A living plan. Organized as **Now / Next / Later** by impact-vs-effort, plus
cross-cutting tech health. Reorder freely — this reflects a proposed priority,
not a commitment.

## ✅ Shipped (baseline)
- Tile-based tracker with health/plant system (⭐→⚡) and 🏁 completed / 🚫 / 🏴 flags
- Frequencies: daily, weekly, monthly (day-of-month), once
- Quick Done/Skip with automatic daily reset (date-based) + day-rollover refresh
- Calendar: planned tasks by month, complete/reschedule, **AI Auto-Reschedule**
  (overdue-first, selective)
- Filters: status, hierarchical tags, frequency, lifecycle (🔥 Active default), mood;
  Today filter; combined Today summary
- **AI assistant** with long-term memory + per-user daily quota (premium bypass);
  can create/update/delete tasks on request
- **Attachments (Premium)** — photos/screenshots/files per tile; private Supabase
  Storage, RLS-gated on premium, client-side image compression + 10 MB cap
- **Voice input** for tile titles (native + web) with language setting
- **Time-of-day per tile** (Morning/Afternoon/Evening/Night) — drives the Planned
  Tasks grouping and the summary reminders
- Native Android **time-of-day summary reminders** (🌅 06:00 / ☀️ 11:30 / 🌇 16:30 /
  🌙 20:00) listing each bucket's due tasks; undone items **roll forward** into later
  summaries (night = everything left today). Any-time tasks get no reminder.
  **Per-tile one-shot reminders** kept (Reminder dropdown + web 🔔 bell)
- **Planned Tasks** modal — routine + one-time tiles, All/One-time/Routine filter,
  live "contains" search, grouped **month → date → time-of-day** with per-occurrence
  status; mobile-friendly (title-led, weekday under the date, no tag column)
- Unified **chip bar** surfacing the active default filters (Active / Today / No Action);
  one-time tiles default to today's date; date inputs display as **dd/MM/yyyy**
- Auth (Supabase + Google OAuth), Vercel web + CI-built Android APK, Lemon Squeezy premium

## 🧭 Direction: Items + Planning (capture now, plan later)
The biggest architectural shift — split the app into two layers:

- **Items (a catalog / library):** real-world things you want to experience,
  stored independently of any plan. Add one in **seconds, hands-busy** (e.g. voice
  "add restaurant Ziya Kebap" while driving) with zero planning. Types:
  - **Venues** — restaurants, cafés, pubs, bars, night clubs, or any category you define
  - **Places to visit** — historical sites, beaches, aurora spots, foreign destinations
  - **Cuisine** — dishes / food styles to try or cook
  - **Art** — exhibitions, galleries, films, concerts, books
  - **Sports** — activities/events to do or attend
  - …extensible; the item type is user-definable.
- **Planning (tiles/tasks):** when you have time, review captured items and create
  plans from them — a task/tile **linked to an item**, with date (or range),
  frequency, budget, reminders. One item can spawn many plans over time.

**Flow:** capture-now → review-later → plan. Items are the backlog; tiles are the
commitments.

**AI enrichment (web-augmented):** the assistant researches an item online and fills
in useful context — typical **pricing**, hours, popularity — and **estimates a
budget** (e.g. "dinner for 2 at this restaurant ≈ X"). Feeds the budget add-on and
auto-reschedule. Needs a web-search/browse capability in the AI backend.

> This is a "let's talk about it later" theme — captured here so it isn't lost.
> It touches the data model (new `items` table + item↔task link), capture UX, and
> AI web access, so it's a multi-step effort worth scoping on its own.

## 🔜 Now (polish, low-effort / high-value)
- **Tile due date shows the year** — the card footer's next-due label omits the year
  (e.g. "4 Tem" with no '26/'27); include it so far-off dates aren't ambiguous.
- **Notification settings UI** — let users pick the summary times (currently fixed at
  06:00 / 11:30 / 16:30 / 20:00) and set quiet hours; per-tile enable/disable.
- **AI memory transparency** — view / edit / reset the long-term memory from Settings.
- **Timezone fix in `calculateHealth()`** — it still iterates days in UTC, so health
  can be off-by-one at the day boundary (the rest of the app is already local).
- **Onboarding** — a short first-run guide (create first tile, explain health/flags).
- **Settings sync** — persist preferences (voice language, etc.) to the account, not
  just localStorage, so they follow the user across devices.
- **Selectable date format** — 🟡 *partial*: inputs are pinned to `dd/MM/yyyy` (via
  `lang="en-GB"`); still to do — let users choose the format (dd/MM/yyyy, MM/dd/yyyy,
  yyyy-MM-dd) from Settings and apply it app-wide (inputs + display strings).

## 🌓 Next (meaningful features)
- **Date ranges for tiles** — let a tile span a start–end date (e.g. 10–14 Jul)
  instead of a single date. Flows into the calendar, "next due", and reminders.
- **Items layer — first slice** — see the "Items + Planning" direction above.
  Ship an `items` catalog with **quick capture** (voice/one-tap) for venues, places,
  cuisine, art, and sports, plus a link from **item → tile** so plans reference items.
- **AI web pricing / budget estimate** — AI researches an item online and suggests a
  budget (e.g. dinner for 2); pairs with the budget add-on.
- **iOS app** — Capacitor iOS build → TestFlight → App Store (needs Apple Developer
  account, Sign in with Apple, APNs). Big lift; see earlier discussion.
- **Insights / analytics** — streaks, trends, per-tag rollups, a weekly review screen.
- **Proactive AI** — weekly summary + pattern-based nudges (e.g. "you skip X on Mondays").
- **Per-tile reminders** — the Time-of-day selector now exists and routes a tile into a
  bucket summary; next step is per-tile reminder **times/toggle** (still global today).
- **Data export / backup** — CSV/JSON export of tasks + logs.
- **Web push notifications** — reminders for the PWA to complement native Android.

## 🌒 Later (strategic)
- **Budget add-on (paid extension)** — an installable, separately-purchased add-on
  (pay to unlock) that lets you attach a planned budget to long-term calendar items
  (dinners, trips, venue visits…) and track planned vs actual spend. First step
  toward a modular add-on model on top of the premium tier.
- **Home-screen widget (Android)** — quick Done/Skip without opening the app.
- **Gamification** — streak milestones, achievements, richer plant-growth visuals.
- **Accountability / social** — share progress, optional buddy/partner view.
- **Integrations** — Google Calendar sync, health/fitness data.
- **Premium tier expansion** — unlimited AI, advanced insights, themes.
- **UI internationalization (i18n)** — the app is used in Turkish; full multi-language UI.

## 🔧 Cross-cutting / tech health
- **Offline launch via bundled assets + live updates** — today the Android app is a
  WebView that loads `server.url` (lifeworld.vercel.app) at runtime, so it can't start
  without a network and is exposed to remote-load flakiness (a likely factor in the
  post-login auto-close). Bundle the web assets into the APK (drop `server.url`) so it
  launches offline, and add a live-update layer (Capgo / Capacitor Live Updates) to keep
  today's instant OTA deploys. Also improves iOS App Store review odds (Apple dislikes
  remote-loaded code).
- Error monitoring + basic analytics (know when the app or API fails)
- A lightweight test pass on core logic (health, scheduling, filters)
- Accessibility review (focus states, ARIA, contrast)
- Revisit the `worlds`→`tasks` legacy references and dead files
