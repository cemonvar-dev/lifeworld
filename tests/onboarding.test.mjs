// Who sees the first-run guide.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../onboarding.js', import.meta.url), 'utf8').replace(/\r/g, '');
const start = source.indexOf('function shouldShowOnboarding');
const [shouldShow, shouldShowChecklist, progress] = new Function(source.slice(start, source.indexOf('(function () {', start)) + 'return [shouldShowOnboarding, shouldShowChecklist, gettingStartedProgress];')();

test('new account with no tiles sees the guide', () => {
	assert.strictEqual(shouldShow({ user_metadata: {} }, 0, null), true);
});
test('accounts with tiles never see it', () => {
	assert.strictEqual(shouldShow({ user_metadata: {} }, 1, null), false);
});
test('finishing on this device hides it', () => {
	assert.strictEqual(shouldShow({ user_metadata: {} }, 0, '1'), false);
});
test('finishing on another device hides it', () => {
	assert.strictEqual(shouldShow({ user_metadata: { onboarded: true } }, 0, null), false);
});

test('the checklist is only for people who went through the guide', () => {
	assert.strictEqual(shouldShowChecklist({ user_metadata: {} }, null, null), false);
	assert.strictEqual(shouldShowChecklist({ user_metadata: { onboarded: true } }, null, null), true);
	assert.strictEqual(shouldShowChecklist({ user_metadata: {} }, '1', null), true);
});
test('a finished checklist stays closed on every device', () => {
	assert.strictEqual(shouldShowChecklist({ user_metadata: { onboarded: true, checklist_done: true } }, null, null), false);
	assert.strictEqual(shouldShowChecklist({ user_metadata: { onboarded: true } }, null, '1'), false);
});
test('progress reads from real activity', () => {
	assert.deepStrictEqual(progress([], null), { create: false, done: false, reminder: false, ai: false });
	assert.deepStrictEqual(progress([{ task_logs: [{ status: 'skipped' }], time_of_day: [] }], null), { create: true, done: false, reminder: false, ai: false });
	assert.deepStrictEqual(progress([{ task_logs: [{ status: 'done' }], time_of_day: ['evening'] }], '1'), { create: true, done: true, reminder: true, ai: true });
	assert.strictEqual(progress([{ reminder_at: '2026-11-09T09:00:00Z' }], null).reminder, true);
});
