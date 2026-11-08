process.env.TZ = 'Europe/Istanbul';
// One-time task health and due label together, against a frozen clock.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const between = (a, b) => { const i = src.indexOf(a); return src.slice(i, src.indexOf(b, i)); };
const code = between('function logDay', '// Health icon sets') + '\n' + between('function todayLocal', '// ---- Data Fetching') + '\n' + between('function getNextDueLabel', "return '—';\n}") + "return '—';\n}";
const RealDate = Date;
class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super('2026-11-08T09:00:00Z'); } }
const rawTiles = {};
const [health, label] = new Function('Date', 'rawTiles', 'monthlyDateFor', code.replace(/\r/g, '') + '\nreturn [calculateHealth, getNextDueLabel];')(Fixed, rawTiles, () => new RealDate());
const done = log_date => ({ log_date, status: 'done' });
const cases = [
  ['done Jan, rescheduled, date passed', '2026-03-01', [done('2026-01-13')], 0, 'overdue'],
  ['done on the due date', '2026-01-13', [done('2026-01-13')], 100, '—'],
  ['done 3 days early', '2026-11-01', [done('2026-10-29')], 100, '—'],
  ['done exactly 7 days early', '2026-11-01', [done('2026-10-25')], 100, '—'],
  ['done 8 days early', '2026-11-01', [done('2026-10-24')], 0, 'overdue'],
  ['done after the due date', '2026-11-01', [done('2026-11-05')], 100, '—'],
  ['old done, due tomorrow', '2026-11-09', [done('2026-01-13')], 50, 'tomorrow'],
  ['never done, date passed', '2026-11-07', [], 0, 'overdue'],
  ['never done, due today', '2026-11-08', [], 50, 'today'],
  ['skipped only, date passed', '2026-11-07', [{ log_date: '2026-11-07', status: 'skipped' }], 0, 'overdue'],
  ['no date, done', null, [done('2026-01-13')], 100, '—'],
  ['no date, not done', null, [], 50, '—'],
];
let fail = 0;
for (const [name, end_date, task_logs, h, l] of cases) {
  const t = { id: 't', frequency_mode: 'once', end_date, task_logs, created_at: '2026-01-01T09:00:00Z' };
  rawTiles.t = t;
  const gh = health(t), gl = label('t'), ok = gh === h && gl === l; if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'DIFF'} ${name}: health ${gh}, label ${gl}`);
}
console.log(`${cases.length - fail}/${cases.length} as expected`);
process.exit(fail ? 1 : 0);
