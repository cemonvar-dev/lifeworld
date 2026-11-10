// Which tiles count as done, skipped or missed on a given day.
process.env.TZ = 'Europe/Istanbul';
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const between = (a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
const code = between('function logDay', '\n}\n') + '\n}\n'
	+ between('function todayLocal', '// ---- Data Fetching')
	+ between('function isTaskScheduledOnDate', '// Reflect the current timeline filter')
	+ between('// Done, skipped and still-open tiles for a day', 'function refreshTodaySummaryCounts');
const RealDate = Date;
const NOW = RealDate.parse('2026-11-11T09:00:00Z'); // Wednesday in Istanbul
class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }

function summary(taskList, day) {
	const rawTiles = Object.fromEntries(taskList.map(t => [t.id, t]));
	const tiles = taskList.map(t => ({ id: t.id, name: t.id, taskStatus: t.status || 'in progress' }));
	const fn = new Function('Date', 'tiles', 'rawTiles', 'monthlyDateFor', code + '\nreturn getTodaySummary;')(Fixed, tiles, rawTiles, (t, y, m) => new RealDate(y, m, 1));
	const result = fn(day);
	return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.map(t => t.id)]));
}
const task = (id, extra = {}) => ({ id, frequency_mode: 'daily', created_at: '2026-01-01T09:00:00Z', task_logs: [], ...extra });

test('yesterday: done, skipped and missed', () => {
	const r = summary([
		task('walk', { task_logs: [{ log_date: '2026-11-10', status: 'done' }] }),
		task('read', { task_logs: [{ log_date: '2026-11-10', status: 'skipped' }] }),
		task('water')
	], '2026-11-10');
	assert.deepStrictEqual(r, { done: ['walk'], skipped: ['read'], remaining: ['water'] });
});

test('only tiles scheduled that day count as missed', () => {
	const gym = task('gym', { frequency_mode: 'weekly', task_frequency_days: [{ day_of_week: 1 }] }); // Mondays
	assert.deepStrictEqual(summary([gym], '2026-11-10').remaining, []); // Tuesday
	assert.deepStrictEqual(summary([gym], '2026-11-09').remaining, ['gym']); // Monday
});

test('tiles created after that day are not missed', () => {
	assert.deepStrictEqual(summary([task('new', { created_at: '2026-11-11T06:00:00Z' })], '2026-11-10').remaining, []);
});

test('finished tiles are not missed', () => {
	assert.deepStrictEqual(summary([task('closed', { status: 'completed' })], '2026-11-10').remaining, []);
});

test('one-time tasks are missed only on their date', () => {
	const once = task('call', { frequency_mode: 'once', end_date: '2026-11-09' });
	assert.deepStrictEqual(summary([once], '2026-11-09').remaining, ['call']);
	assert.deepStrictEqual(summary([once], '2026-11-10').remaining, []);
});
