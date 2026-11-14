process.env.TZ = 'Europe/Istanbul';
// Runs the suggestion rules and actions against a frozen clock and fake Supabase.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const between = (a, b) => { const i = src.indexOf(a); assert(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
const code = between('function logDay', '// Health icon sets') + between('// Weekly tiles can repeat every N weeks', 'function isTileScheduledToday') + between('function todayLocal', '// ---- Data Fetching') + between('// ---- Tile suggestions ----', '// ---- Per-tile reminder helpers ----');
const RealDate = Date, NOW = RealDate.parse('2026-11-08T09:00:00Z');
class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }
const store = {}, localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = v };
const calls = [], rawTiles = {}, tiles = [{ id: 't' }]; let failOn = '';
const table = name => ({
  delete: () => ({ eq: async () => { calls.push(['delete', name]); return { error: failOn === 'delete' ? { message: 'x' } : null }; } }),
  insert: rows => ({ select: async () => { calls.push(['insert', name, rows]); return { data: rows, error: failOn === 'insert' ? { message: 'x' } : null }; } }),
  update: patch => ({ eq: async () => { calls.push(['update', name, patch]); return { error: null }; } }),
});
const _t = (k, v) => v ? k.replace(/\{(\w+)\}/g, (m, n) => n in v ? v[n] : m) : k;
const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const env = { _t, i18n: { lang: 'en', dayName: (d, s) => s === 'short' ? names[d].slice(0, 3) : names[d] }, Date: Fixed, localStorage, rawTiles, tiles, supa: { from: table },
  monthlyDateFor: (t, y, m) => new RealDate(y, m, t.day_of_month || 1),
  tilePlant: t => ({ finished: t.status === 'completed' }), tileTimeOfDay: r => (r.time_of_day || [])[0] || '',
  healthToPlant: () => ({ emoji: '', label: '', color: '' }), openTilePopup: () => calls.push(['popup']), applyFilters: () => {}, scheduleReminders: () => {}, quickLog: async (id, s) => calls.push(['quickLog', id, s]), document: {} };
const api = new Function(...Object.keys(env), code + '\nreturn { tileSuggestion, applySuggestionAction, snoozeSuggestion, calculateHealth };')(...Object.values(env));
const ago = n => { const d = new RealDate(NOW); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const OLD = '2026-01-01T09:00:00Z', done = (n, extra = {}) => ({ log_date: ago(n), status: 'done', ...extra }), skip = n => ({ log_date: ago(n), status: 'skipped' });
const sug = t => api.tileSuggestion({ id: 't', created_at: OLD, frequency_mode: 'daily', ...t });
let s;
s = sug({ task_logs: [{ log_date: '2026-07-21', status: 'done' }] });
assert.strictEqual(s.kind, 'stale'); assert(s.text.includes('No activity since')); assert.deepStrictEqual(s.actions.map(a => a.id), ['restart', 'schedule', 'complete']); console.log('ok daily tile inactive since July is stale:', s.hint);
s = sug({ frequency_mode: 'weekly', task_frequency_days: [{ day_of_week: 1 }], task_logs: [] });
assert.strictEqual(s.kind, 'stale'); assert.deepStrictEqual(s.actions.map(a => a.id), ['restart', 'complete']); console.log('ok non-daily stale has no schedule action');
assert.strictEqual(sug({ frequency_mode: 'monthly', day_of_month: 1, task_logs: [done(45)] })?.kind === 'stale', false); console.log('ok monthly tile not stale after 45 days');
s = sug({ created_at: ago(3) + 'T09:00:00Z', task_logs: [] }); assert.notStrictEqual(s?.kind, 'stale'); console.log('ok new tile is not stale');
s = sug({ task_logs: [done(2), done(9), done(16), done(4), done(11)] });
assert.strictEqual(s.kind, 'schedule'); assert.strictEqual(s.actions[0].days.length, 3); console.log('ok struggling daily tile:', s.actions[0].label, '-', s.text);
const every = (n, f) => Array.from({ length: n }, (_, i) => f(i));
s = sug({ frequency_mode: 'weekly', task_frequency_days: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d })), task_logs: [
  ...every(45, i => i).filter(i => new RealDate(ago(i) + 'T00:00:00').getDay() !== 1).map(i => done(i)),
  ...every(45, i => i).filter(i => new RealDate(ago(i) + 'T00:00:00').getDay() === 1).map(i => skip(i)) ] });
assert.strictEqual(s.kind, 'skip'); assert(s.text.includes('Monday')); assert.deepStrictEqual(s.actions[0].days, [0, 2, 3, 4, 5, 6]); console.log('ok skip pattern:', s.text);
const evening = n => done(n, { created_at: ago(n) + 'T15:30:00Z' });
s = sug({ task_logs: every(20, i => i * 1).map(evening) });
assert.strictEqual(s.kind, 'timing'); assert.strictEqual(s.actions[0].value, 'evening'); console.log('ok timing:', s.text);
s = sug({ time_of_day: ['evening'], task_logs: every(20, i => i).map(evening) });
assert.strictEqual(s.kind, 'milestone'); console.log('ok milestone:', s.text);
s = sug({ time_of_day: ['evening'], task_logs: every(31, i => i).map(evening) }); assert.strictEqual(s, null); console.log('ok thriving tile has no suggestion');
assert.strictEqual(sug({ frequency_mode: 'once', end_date: ago(9), task_logs: [] }), null); assert.strictEqual(sug({ status: 'completed', task_logs: [] }), null); console.log('ok one-time and finished tiles have no suggestion');
const backdated = every(20, i => done(i, { created_at: '2026-11-08T15:30:00Z' }));
assert.notStrictEqual(sug({ task_logs: backdated }).kind, 'timing'); console.log('ok backdated logs do not drive timing');
const stale = { task_logs: [] }; assert.strictEqual(sug(stale).kind, 'stale'); api.snoozeSuggestion('t', 'stale'); assert.notStrictEqual(sug(stale)?.kind, 'stale'); console.log('ok Not now moves on to the next suggestion'); for (const k in store) delete store[k];
rawTiles.t = { id: 't', created_at: OLD, frequency_mode: 'daily', task_logs: [] }; calls.length = 0;
await api.applySuggestionAction('t', { id: 'schedule', days: [1, 3, 5] });
assert.strictEqual(rawTiles.t.frequency_mode, 'weekly'); assert.strictEqual(rawTiles.t.task_frequency_days.length, 3); assert.deepStrictEqual(calls.map(c => c[0]), ['delete', 'insert', 'update', 'popup']); console.log('ok schedule action persists then updates');
rawTiles.t = { id: 't', frequency_mode: 'daily', task_logs: [] }; failOn = 'insert';
await assert.rejects(api.applySuggestionAction('t', { id: 'schedule', days: [1] })); assert.strictEqual(rawTiles.t.frequency_mode, 'daily'); failOn = ''; console.log('ok failed schedule leaves local state unchanged');
rawTiles.t = { id: 't', frequency_mode: 'daily', task_logs: [] }; calls.length = 0;
await api.applySuggestionAction('t', { id: 'restart' }); assert.deepStrictEqual(calls[0], ['quickLog', 't', 'done']); console.log('ok restart logs Done today');
await api.applySuggestionAction('t', { id: 'timing', value: 'night' }); assert.deepStrictEqual(rawTiles.t.time_of_day, ['night']); console.log('ok timing action');
await api.applySuggestionAction('t', { id: 'complete' }); assert.strictEqual(rawTiles.t.status, 'completed'); assert.strictEqual(tiles[0].taskStatus, 'completed'); console.log('ok complete action');
