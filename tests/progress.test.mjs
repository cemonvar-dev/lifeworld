// Progress numbers must match the logs exactly.
process.env.TZ = 'Europe/Istanbul';
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r/g, '');
const app = read('app.js'), progress = read('progress.js');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
const code = between(app, 'function logDay', '\n}\n') + '\n}\n'
	+ between(app, 'function isTaskScheduledOnDate', 'function isTileScheduledToday')
	+ between(progress, 'const PROGRESS_WEEKS', '// ---- Progress screen ----');
const RealDate = Date;
const NOW = RealDate.parse('2026-11-11T09:00:00Z'); // Wednesday, 12:00 in Istanbul
class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }
const env = { Date: Fixed, monthlyDateFor: (t, y, m) => new RealDate(y, m, t.day_of_month || 1), tilePlant: t => ({ finished: t.status === 'completed' }) };
const compute = new Function(...Object.keys(env), code + '\nreturn computeProgress;')(...Object.values(env));

const ago = n => { const d = new RealDate(NOW); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const OLD = '2026-01-01T09:00:00Z';
const log = (n, status = 'done') => ({ log_date: ago(n), status });
const daily = (logs, extra = {}) => ({ id: 'd' + Math.random(), name: 'Walk', frequency_mode: 'daily', created_at: OLD, task_logs: logs, ...extra });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('this week is compared with the same days of last week', () => {
	// Mon-Wed this week = 2, 1, 0 days ago; the same days last week = 9, 8, 7.
	// 4 days ago is last Saturday; 10 days ago is the week before.
	const p = compute([daily([log(0), log(1), log(4), log(7), log(8), log(9), log(10)])]);
	assert.strictEqual(p.thisWeek, 2);
	assert.strictEqual(p.lastWeekSoFar, 3);
	assert.strictEqual(p.lastWeekTotal, 4);
});

test('routines kept counts only scheduled days so far', () => {
	const p = compute([daily([log(1), log(2)]), daily([log(1)]), daily([], { status: 'completed' })]);
	assert.strictEqual(p.routinesDue, 2);
	assert.strictEqual(p.routinesKept, 1);
});

test('today does not count against a routine until it is over', () => {
	const p = compute([daily([log(1), log(2)])]);
	assert.strictEqual(p.routinesKept, 1);
	assert.strictEqual(p.streaks[0].current, 2);
});

test('streaks: skips do not break, misses do', () => {
	assert.strictEqual(compute([daily([log(0), log(1), log(2, 'skipped'), log(3)])]).streaks[0].current, 3);
	assert.strictEqual(compute([daily([log(0), log(1), log(3)])]).streaks[0].current, 2);
	assert.strictEqual(compute([daily(range(10, 19).map(n => log(n)))]).streaks[0].best, 10);
});

test('weekly streaks count scheduled days only', () => {
	const mondays = [2, 9, 16].map(n => log(n)); // Mondays
	const p = compute([{ id: 'w', name: 'Gym', frequency_mode: 'weekly', created_at: OLD, task_frequency_days: [{ day_of_week: 1 }], task_logs: mondays }]);
	assert.strictEqual(p.streaks[0].current, 3);
});

test('the 12-week trend only rates weeks with routines due', () => {
	const p = compute([daily(range(0, 6).map(n => log(n)), { created_at: ago(9) + 'T09:00:00Z' })]);
	assert.strictEqual(p.weeks.length, 12);
	assert.strictEqual(p.weeks[0].rate, null);
	assert.strictEqual(p.weeks[11].rate, 100);
	assert.strictEqual(p.heatmap.length, 84);
	assert.ok(p.heatmap.slice(-4).every(d => d.future));
	assert.strictEqual(p.heatmap.find(d => d.key === ago(0)).count, 1);
});

test('wins: best week, perfect day, best streak and comeback', () => {
	const types = p => p.wins.map(w => w.type);
	const history = [log(20), log(21), ...range(0, 3).map(n => log(n))];
	assert.deepStrictEqual(types(compute([daily(history)])), ['best_week', 'perfect_day', 'best_streak']);
	assert.ok(types(compute([daily([log(0), log(60)])])).includes('comeback'));
	assert.ok(!types(compute([daily([log(1)])])).includes('perfect_day'), 'today not done yet');
	assert.ok(compute([daily(range(0, 20).map(n => log(n)))]).wins.length <= 3);
});

test('an empty account has nothing to celebrate', () => {
	const p = compute([]);
	assert.deepStrictEqual([p.thisWeek, p.routinesDue, p.streaks.length, p.wins.length], [0, 0, 0, 0]);
});

const week = new Function(...Object.keys(env), code + '\nreturn computeWeekReview;')(...Object.values(env));
test('last 7 days: per day, areas, highlights', () => {
	const area = key => () => ({ key, label: key, color: '#000' });
	const walk = daily([log(0), log(1), log(2), log(3), log(4), log(5), log(6)], { name: 'Walk', tag_ids: ['health'] });
	const pills = daily([log(1), log(3, 'skipped')], { name: 'Pills', tag_ids: ['health'] });
	const guitar = daily([], { name: 'Guitar', tag_ids: ['hobby'] });
	const byTag = t => ({ key: t.tag_ids[0], label: t.tag_ids[0], color: '#000' });
	const w = week([walk, pills, guitar], byTag);
	assert.strictEqual(w.days.length, 7);
	assert.strictEqual(w.days[6].key, ago(0));
	assert.deepStrictEqual(w.totals, { done: 8, skipped: 1, missed: 10 }, 'today is never missed');
	assert.deepStrictEqual(w.areas.map(a => [a.key, a.pct]), [['health', 100]]);
	assert.strictEqual(w.top[0].name, 'Walk');
	assert.deepStrictEqual(w.slipped.map(s => s.name), ['Guitar', 'Pills']);
	assert.deepStrictEqual(w.untouched.map(a => a.key), ['hobby']);
	void area;
});