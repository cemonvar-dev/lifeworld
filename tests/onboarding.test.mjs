// Who sees the first-run guide.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../onboarding.js', import.meta.url), 'utf8').replace(/\r/g, '');
const start = source.indexOf('function shouldShowOnboarding');
const shouldShow = new Function(source.slice(start, source.indexOf('(function () {', start)) + 'return shouldShowOnboarding;')();

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
