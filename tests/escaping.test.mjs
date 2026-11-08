// Guards against user text reaching the page as HTML.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const start = source.indexOf('function escapeHtml');
const escapeHtml = new Function(source.slice(start, source.indexOf('\n}\n', start) + 3) + 'return escapeHtml;')();

test('escapeHtml is defined exactly once', () => {
	assert.strictEqual(source.match(/function escapeHtml\(/g).length, 1);
});

test('escapeHtml covers text and attribute contexts', () => {
	assert.strictEqual(escapeHtml(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
	assert.strictEqual(escapeHtml(null), '');
});

test('user fields are never interpolated into markup unescaped', () => {
	const unsafe = /\$\{(tile\.name|t\.name|log\.note|tagObj\.label|o\.label|term|i\.name)\}/g;
	const found = source.split('\n').filter(line => /<[a-z]|innerHTML/.test(line) && unsafe.test(line));
	assert.deepStrictEqual(found.map(line => line.trim().slice(0, 100)), []);
});
