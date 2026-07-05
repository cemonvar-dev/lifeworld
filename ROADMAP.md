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
- **AI assistant** with long-term memory + per-user daily quota (premium bypass)
- **Voice input** for tile titles (native + web) with language setting
- Native Android reminders every 4h with Done/Skip actions
- Auth (Supabase + Google OAuth), Vercel web + CI-built Android APK, Lemon Squeezy premium

## 🔜 Now (polish, low-effort / high-value)
- **Tile due date shows the year** — the card footer's next-due label omits the year
  (e.g. "4 Tem" with no '26/'27); include it so far-off dates aren't ambiguous.
- **Mobile-friendly long-term calendar** — show the weekday under the date, hide the
  tag/category column, and lead with the task title (much better on phones).
- **Notification settings UI** — let users pick reminder times/frequency and set
  quiet hours, instead of the hardcoded 8/12/16/20. Per-tile enable/disable.
- **AI memory transparency** — view / edit / reset the long-term memory from Settings.
- **Timezone fix in `calculateHealth()`** — it still iterates days in UTC, so health
  can be off-by-one at the day boundary (the rest of the app is already local).
- **Onboarding** — a short first-run guide (create first tile, explain health/flags).
- **Settings sync** — persist preferences (voice language, etc.) to the account, not
  just localStorage, so they follow the user across devices.

## 🌓 Next (meaningful features)
- **Date ranges for tiles** — let a tile span a start–end date (e.g. 10–14 Jul)
  instead of a single date. Flows into the calendar, "next due", and reminders.
- **Venues** — a user-defined *venue* type (restaurants, cafés, pubs, bars, night
  clubs, or any category you create) for spots you want to go to; track planned vs
  visited. Extends LifeWorld beyond habits into places-to-experience.
- **Places to visit** — a bucket-list type for destinations (historical sites,
  beaches, aurora spots, foreign trips…), with plan/visited status.
- **iOS app** — Capacitor iOS build → TestFlight → App Store (needs Apple Developer
  account, Sign in with Apple, APNs). Big lift; see earlier discussion.
- **Insights / analytics** — streaks, trends, per-tag rollups, a weekly review screen.
- **Proactive AI** — weekly summary + pattern-based nudges (e.g. "you skip X on Mondays").
- **Per-tile reminders** — re-connect the Time-of-Day selector so reminders can be
  tailored per tile (currently global).
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
- Error monitoring + basic analytics (know when the app or API fails)
- A lightweight test pass on core logic (health, scheduling, filters)
- Accessibility review (focus states, ARIA, contrast)
- Revisit the `worlds`→`tasks` legacy references and dead files
