// The facts given to the AI coach must match what the logs actually show.
process.env.TZ = 'Europe/Istanbul';
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const between = (a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)); };
const code = between('function logDay', '// Health icon sets')
	+ between('function todayLocal', '// ---- Data Fetching')
	+ between('function suggestionDayKey', 'function suggestionDayList')
	+ between('// ---- AI coach facts ----', 'function buildTaskContext');
const RealDate = Date;
const NOW = RealDate.parse('2026-11-08T09:00:00Z');
class Fixed extends RealDate { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }
const label = h => h >= 80 ? 'Thriving' : h >= 40 ? 'Growing' : 'Dying';
const env = { Date: Fixed, monthlyDateFor: (t, y, m) => new RealDate(y, m, 1), tilePlant: t => ({ finished: t.status === 'completed' }), healthToPlant: h => ({ label: label(h) }), tagName: id => id };
const { tileCoachFacts: facts, coachSummary: summary, coachUsage: usage, coachHistory: history } = new Function(...Object.keys(env), code + '\n' + between('// Long-term record of one task', '// The plan the user agreed') + '\nreturn { tileCoachFacts, coachSummary, coachUsage, coachHistory };')(...Object.values(env));

const ago = n => { const d = new RealDate(NOW); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const OLD = '2026-01-01T09:00:00Z';
const log = (n, status = 'done') => ({ log_date: ago(n), status });
const daily = (task_logs, extra = {}) => ({ frequency_mode: 'daily', created_at: OLD, task_logs, ...extra });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('an abandoned habit reads as inactive, not skipped', () => {
	const text = facts(daily([log(119)]));
	assert.match(text, /last done .* \(119 days ago\)/);
	assert.match(text, /0 done, 0 skipped, 30 missed/);
	assert.match(text, /trend: inactive/);
});

test('a task never done says so', () => {
	const text = facts(daily([]));
	assert.match(text, /^never done/);
	assert.match(text, /trend: never done/);
});

test('recorded skips are counted', () => {
	assert.match(facts(daily([log(1, 'skipped'), log(2, 'skipped'), log(3)])), /1 done, 2 skipped, 27 missed/);
});

test('trends compare the last two fortnights', () => {
	assert.match(facts(daily(range(1, 5).map(n => log(n)))), /trend: improving/);
	assert.match(facts(daily([log(2), ...range(15, 20).map(n => log(n))])), /trend: declining/);
	assert.match(facts(daily(range(15, 20).map(n => log(n)))), /trend: stopped recently/);
	assert.match(facts(daily([...range(1, 3).map(n => log(n)), ...range(15, 17).map(n => log(n))])), /trend: steady/);
});

test('weekday patterns need enough evidence', () => {
	const mondays = [6, 13, 20].map(n => log(n)); // 2026-11-08 is a Sunday
	assert.match(facts(daily(mondays)), /most often done on Monday/);
	assert.doesNotMatch(facts(daily(mondays.slice(0, 2))), /most often done/);
	assert.match(facts(daily([6, 13, 20].map(n => log(n, 'skipped')))), /most often skipped on Monday/);
});

test('new tiles are marked', () => {
	assert.match(facts(daily([], { created_at: '2026-11-01T09:00:00Z' })), /tracked for under 30 days/);
});

test('one-time tasks only report completion', () => {
	assert.strictEqual(facts({ frequency_mode: 'once', end_date: ago(5), task_logs: [] }), 'never done');
});

test('the summary ranks areas and ignores finished tiles', () => {
	const text = summary([
		daily(range(1, 30).map(n => log(n)), { tag_ids: ['work'] }),
		daily([], { tag_ids: ['health'] }),
		daily([], { tag_ids: ['health'] }),
		daily([], { tag_ids: ['done-area'], status: 'completed' })
	]);
	assert.match(text, /1 Thriving, 2 Dying|2 Dying, 1 Thriving/);
	assert.match(text, /Routine tiles with no Done in 30 days: 2/);
	assert.ok(text.indexOf('"health"') < text.indexOf('"work"'), 'weakest area first');
	assert.ok(!text.includes('done-area'));
});

test('usage notices when the user has been away', () => {
	const text = usage([daily([log(40), log(41)]), daily([log(45, 'skipped')])]);
	assert.match(text, /\(40 days ago\)/);
	assert.match(text, /0 of the last 7, 0 of the last 30, 3 of the last 90/);
	assert.match(text, /away from the app for 40 days/);
	assert.doesNotMatch(usage([daily(range(0, 10).map(n => log(n)))]), /away/);
	assert.match(usage([daily([])]), /Nothing has ever been logged/);
});

test('history gives totals, recent months and the longest streak', () => {
	const text = history(daily([...range(60, 73).map(n => log(n)), log(3), log(5, 'skipped')]));
	assert.match(text, /^15 done since /);
	assert.match(text, /per month: .*\(so far\)/);
	assert.match(text, /longest streak 14 days in a row/);
	assert.strictEqual(history(daily([log(2, 'skipped')])), '');
});
