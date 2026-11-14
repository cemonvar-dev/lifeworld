process.env.TZ = 'Europe/Istanbul';
// Weekly tiles that repeat every N weeks (e.g. barber every 2 weeks).
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import test from 'node:test';
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const between = (a, b) => { const i = src.indexOf(a); assert(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
const code = between('function isTaskScheduledOnDate', 'function isTileScheduledToday');
const api = new Function('monthlyDateFor', code + '\nreturn { isTaskScheduledOnDate, isRepeatWeek, repeatEvery };')(() => new Date(0));
const day = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const barber = { frequency_mode: 'weekly', task_frequency_days: [{ day_of_week: 6 }], repeat_every: 2, repeat_anchor: '2026-11-09' };

test('every 2 weeks: due on Saturdays of alternating weeks from the anchor week', () => {
	assert.strictEqual(api.isTaskScheduledOnDate(barber, day('2026-11-14')), true);   // anchor week
	assert.strictEqual(api.isTaskScheduledOnDate(barber, day('2026-11-21')), false);  // off week
	assert.strictEqual(api.isTaskScheduledOnDate(barber, day('2026-11-28')), true);
	assert.strictEqual(api.isTaskScheduledOnDate(barber, day('2026-11-07')), false);  // week before the anchor
	assert.strictEqual(api.isTaskScheduledOnDate(barber, day('2026-10-31')), true);
	assert.strictEqual(api.isTaskScheduledOnDate(barber, day('2026-11-13')), false);  // not a Saturday
});
test('every week by default; bad values fall back to 1; anchor defaults to creation', () => {
	const weekly = { frequency_mode: 'weekly', task_frequency_days: [{ day_of_week: 6 }] };
	assert.strictEqual(api.isTaskScheduledOnDate(weekly, day('2026-11-21')), true);
	assert.strictEqual(api.repeatEvery({ repeat_every: 0 }), 1);
	assert.strictEqual(api.repeatEvery({ repeat_every: '3' }), 3);
	const created = { ...barber, repeat_anchor: null, created_at: '2026-11-17T08:00:00Z' };
	assert.strictEqual(api.isRepeatWeek(created, day('2026-11-21')), true);
	assert.strictEqual(api.isRepeatWeek(created, day('2026-11-28')), false);
});
