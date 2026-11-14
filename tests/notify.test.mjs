process.env.TZ = 'Europe/Istanbul';
// The on-device notification schedule: repeating reminders, summaries,
// "Any time", quiet hours, streaks at risk, weekly review and come-back.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import test from 'node:test';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r/g, '');
const app = read('app.js'), progress = read('progress.js'), notify = read('notify.js');
const between = (src, a, b) => { const i = src.indexOf(a); assert(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
const code = between(app, 'function logDay', '\n}\n') + '\n}\n'
	+ between(app, 'function todayLocal', '// ---- Data Fetching')
	+ between(app, 'function statusOnDate', '// One app_opened')
	+ between(app, 'function isTaskScheduledOnDate', 'function isTileScheduledToday')
	+ between(progress, 'const PROGRESS_WEEKS', '// ---- Progress screen ----')
	+ notify;
const RealDate = Date;
let NOW = RealDate.parse('2026-11-14T04:00:00Z'); // Saturday 07:00 in Istanbul
class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }
const store = {};
const env = {
	Date: Fixed, window: {}, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
	_t: (k, v) => v ? k.replace(/\{(\w+)\}/g, (m, n) => n in v ? v[n] : m) : k,
	monthlyDateFor: (t, y, m) => new RealDate(y, m, t.day_of_month || 1), rawTiles: {}
};
const api = new Function(...Object.keys(env), code + '\nreturn { buildNotifications, notifDefaults, reminderMoment };')(...Object.values(env));
const day = n => { const d = new RealDate(NOW); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const OLD = '2026-09-01T09:00:00Z';
const build = (tasks, prefs = api.notifDefaults()) => api.buildNotifications(tasks, new Fixed(), prefs);
const kind = (list, k) => list.filter(n => n.extra.kind === k);
const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('a repeating card reminds every scheduled day, not just once; done today skips today', () => {
	const pills = { id: 'p', name: 'Pills', created_at: OLD, frequency_mode: 'daily', reminder_at: new RealDate(2026, 10, 10, 9, 0).toISOString(), task_logs: [] };
	const r = kind(build([pills]), 'reminder');
	assert.strictEqual(r.length, 7);
	assert(r.every(n => hm(n.schedule.at) === '09:00'));
	pills.task_logs = [{ log_date: day(0), status: 'done' }];
	assert.strictEqual(kind(build([pills]), 'reminder').length, 6);
	const once = { id: 'o', name: 'Call', created_at: OLD, frequency_mode: 'once', end_date: day(1), reminder_at: new RealDate(2026, 10, 15, 10, 0).toISOString(), task_logs: [] };
	assert.strictEqual(kind(build([once]), 'reminder').length, 1);
});

test('summaries: own timing, Any time on the first one ahead, reminded cards left out, quiet hours', () => {
	const tasks = [
		{ id: 'a', name: 'Run', created_at: OLD, frequency_mode: 'daily', time_of_day: ['morning'], task_logs: [] },
		{ id: 'b', name: 'Read', created_at: OLD, frequency_mode: 'daily', time_of_day: ['night'], task_logs: [] },
		{ id: 'c', name: 'Water', created_at: OLD, frequency_mode: 'daily', time_of_day: [], task_logs: [] },
		{ id: 'd', name: 'Pills', created_at: OLD, frequency_mode: 'daily', time_of_day: ['morning'], reminder_at: new RealDate(2026, 10, 10, 9, 0).toISOString(), task_logs: [] }
	];
	const todays = kind(build(tasks), 'summary').filter(n => n.extra.date === day(0));
	const morning = todays.find(n => n.extra.summary === 'morning');
	assert.strictEqual(hm(morning.schedule.at), '08:00');
	assert(morning.body.includes('Run') && morning.body.includes('Any time: Water') && !morning.body.includes('Pills'), morning.body);
	assert(todays.find(n => n.extra.summary === 'night').body.includes('Still pending: Run'));
	const prefs = api.notifDefaults();
	prefs.quiet = { on: true, from: '20:30', to: '07:30' };
	prefs.buckets.morning.on = false;
	const quiet = kind(build(tasks, prefs), 'summary').filter(n => n.extra.date === day(0));
	assert(!quiet.some(n => n.extra.summary === 'night'), 'night summary is in quiet hours');
	assert(quiet.find(n => n.extra.summary === 'afternoon').body.includes('Any time: Water'));
});

test('streak at risk tonight, weekly review on Sunday, come-back nudges', () => {
	const logs = [1, 2, 3, 4].map(n => ({ log_date: day(-n), status: 'done' }));
	const tasks = [{ id: 's', name: 'Pray', created_at: OLD, frequency_mode: 'daily', task_logs: logs }];
	const all = build(tasks);
	const streak = kind(all, 'streak');
	assert.strictEqual(streak.length, 1);
	assert.strictEqual(streak[0].title, '🔥 Pray: 4 in a row');
	assert.strictEqual(hm(streak[0].schedule.at), '19:30');
	const weekly = kind(all, 'weekly');
	assert.strictEqual(weekly.length, 1);
	assert.strictEqual(weekly[0].schedule.at.getDay(), 0);
	assert.strictEqual(kind(all, 'comeback').length, 2);
	tasks[0].task_logs.push({ log_date: day(0), status: 'done' });
	assert.strictEqual(kind(build(tasks), 'streak').length, 0);
	const off = api.notifDefaults(); off.streak = off.weekly = off.comeback = false;
	assert.strictEqual(build(tasks, off).filter(n => ['streak', 'weekly', 'comeback'].includes(n.extra.kind)).length, 0);
	const ids = all.map(n => n.id);
	assert.strictEqual(new Set(ids).size, ids.length);
});
