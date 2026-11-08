// Analytics must stay limited to named events without user content.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r/g, '');

test('automatic click capture stays off', () => {
	assert.match(read('posthog-init.js'), /autocapture:\s*false/);
});

test('session recording stays off', () => {
	assert.match(read('posthog-init.js'), /disable_session_recording:\s*true/);
});

test('tracked events never include tile names, notes or messages', () => {
	const calls = [...read('app.js').matchAll(/window\.track\??\.?\(([^\n]*)\)/g), ...read('onboarding.js').matchAll(/window\.track\??\.?\(([^\n]*)\)/g)].map(m => m[1]);
	assert.ok(calls.length >= 12, 'expected to find the tracking calls');
	for (const call of calls) assert.doesNotMatch(call, /\b(name|note|notes|text|message|msg|content|email|title)\b\s*[:,}]|\.name\b|\.note\b/i, call);
});
