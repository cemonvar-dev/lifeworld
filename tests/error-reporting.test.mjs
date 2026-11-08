// Runs the error-reporting block from posthog-init.js against a fake window.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../posthog-init.js', import.meta.url), 'utf8').replace(/\r/g, '');
const start = source.indexOf('// Report uncaught browser errors');
const block = source.slice(start, source.indexOf('// Identify the signed-in Supabase user'));

function setup() {
	const captured = [], listeners = {};
	const window = { posthog: { capture: (name, props) => captured.push({ name, props }) }, addEventListener: (type, fn) => { listeners[type] = fn; } };
	window.i18n = { lang: 'tr' };
	new Function('window', block)(window);
	return { window, captured, listeners };
}
const errorEvent = (window, message, extra = {}) => ({ target: window, message, filename: 'https://fiblia.com/app.js?v=1', lineno: 12, colno: 3, error: { stack: 'at f (app.js:12:3)' }, ...extra });

test('reports an uncaught error without the query string', () => {
	const { window, captured, listeners } = setup();
	listeners.error(errorEvent(window, 'boom'));
	assert.strictEqual(captured[0].name, 'client_error');
	assert.strictEqual(captured[0].props.error_message, 'boom');
	assert.strictEqual(captured[0].props.error_source, 'https://fiblia.com/app.js');
	assert.strictEqual(captured[0].props.app_language, 'tr');
});

test('removes tokens and email addresses', () => {
	const { window, captured, listeners } = setup();
	listeners.error(errorEvent(window, 'failed for a.b+c@example.com access_token=abc123 eyJhbGci.eyJzdWI.c2ln', { error: { stack: 'x refresh_token=zzz person@example.org' } }));
	const text = JSON.stringify(captured[0].props);
	for (const secret of ['a.b+c@example.com', 'abc123', 'eyJhbGci', 'zzz', 'person@example.org']) assert.ok(!text.includes(secret), secret);
});

test('reports unhandled promise rejections', () => {
	const { captured, listeners } = setup();
	listeners.unhandledrejection({ reason: new Error('rejected') });
	listeners.unhandledrejection({ reason: 'plain text' });
	assert.deepStrictEqual(captured.map(c => c.props.error_message), ['rejected', 'plain text']);
});

test('ignores noise, duplicates and failed resource loads', () => {
	const { window, captured, listeners } = setup();
	listeners.error(errorEvent(window, 'Script error.'));
	listeners.error(errorEvent(window, 'ResizeObserver loop completed with undelivered notifications.'));
	listeners.error(errorEvent(window, 'same'));
	listeners.error(errorEvent(window, 'same'));
	listeners.error({ target: {}, message: 'image failed' });
	assert.strictEqual(captured.length, 1);
});

test('stops after ten reports on a page', () => {
	const { window, captured, listeners } = setup();
	for (let i = 0; i < 25; i++) listeners.error(errorEvent(window, `error ${i}`));
	assert.strictEqual(captured.length, 10);
});
