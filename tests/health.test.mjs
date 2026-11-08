process.env.TZ = 'Europe/Istanbul';
// Runs calculateHealth from an app.js copy against a frozen clock.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const between = (a, b) => { const i = src.indexOf(a); return src.slice(i, src.indexOf(b, i)); };
const code = between('function logDay', '// Health icon sets') + '\n' + between('function todayLocal', '// ---- Data Fetching');
const RealDate = Date;
function build(iso) {
  class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super(iso); } }
  return new Function('Date', 'monthlyDateFor', code + '\nreturn calculateHealth;')(Fixed, (t, y, m) => new RealDate(y, m, t.day_of_month || 1));
}
const noon = '2026-11-08T09:00:00Z', oneAm = '2026-11-07T22:00:00Z'; // 12:00 and 01:00 in Istanbul, 8 Nov
const old = '2026-01-01T09:00:00Z', log = (log_date, status = 'done') => ({ log_date, status });
const last = n => Array.from({ length: n }, (_, i) => new RealDate(RealDate.UTC(2026, 10, 8 - i)).toISOString().slice(0, 10));
const cases = [
  ['once due today, not done', noon, { frequency_mode: 'once', end_date: '2026-11-08', created_at: old }, 50],
  ['once due yesterday, not done', noon, { frequency_mode: 'once', end_date: '2026-11-07', created_at: old }, 0],
  ['once due tomorrow', noon, { frequency_mode: 'once', end_date: '2026-11-09', created_at: old }, 50],
  ['once done', noon, { frequency_mode: 'once', end_date: '2026-11-01', created_at: old, task_logs: [log('2026-11-01')] }, 100],
  ['01:00 local, done today+yesterday', oneAm, { frequency_mode: 'daily', created_at: old, task_logs: last(2).map(d => log(d)) }, Math.round(2 / 31 * 100)],
  ['daily all 31 days done', noon, { frequency_mode: 'daily', created_at: old, task_logs: last(31).map(d => log(d)) }, 100],
  ['5 done, 26 skipped', noon, { frequency_mode: 'daily', created_at: old, task_logs: last(31).map((d, i) => log(d, i < 5 ? 'done' : 'skipped')) }, 100],
  ['every day skipped', noon, { frequency_mode: 'daily', created_at: old, task_logs: last(31).map(d => log(d, 'skipped')) }, 50],
  ['5 done, 5 skipped, 21 missed', noon, { frequency_mode: 'daily', created_at: old, task_logs: last(10).map((d, i) => log(d, i < 5 ? 'done' : 'skipped')) }, Math.round(5 / 26 * 100)],
  ['done and skipped same day', noon, { frequency_mode: 'daily', created_at: '2026-11-08T05:00:00Z', task_logs: [log('2026-11-08'), log('2026-11-08', 'skipped')] }, 100],
  ['weekly Sun, 2 Sundays done', noon, { frequency_mode: 'weekly', created_at: '2026-10-30T09:00:00Z', task_frequency_days: [{ day_of_week: 0 }], task_logs: [log('2026-11-01'), log('2026-11-08')] }, 100],
];
let fail = 0;
for (const [name, now, task, want] of cases) {
  const got = build(now)(task); const ok = got === want; if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'DIFF'} ${name}: got ${got}, want ${want}`);
}
console.log(`${cases.length - fail}/${cases.length} as expected`);
process.exit(fail ? 1 : 0);
