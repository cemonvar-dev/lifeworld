// Every language must have the same strings, placeholders and code references.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const languages = readdirSync(new URL('i18n/', root)).map(f => f.replace('.js', ''));
const load = lang => {
	const window = { I18N_MESSAGES: {} };
	new Function('window', readFileSync(new URL(`i18n/${lang}.js`, root), 'utf8'))(window);
	return window.I18N_MESSAGES[lang];
};
const placeholders = text => [...new Set(text.match(/\{\w+\}/g) || [])].sort().join();
const reference = load('de');

for (const lang of languages) {
	test(`${lang} matches the reference strings and placeholders`, () => {
		const messages = load(lang);
		assert.deepStrictEqual(Object.keys(messages).sort(), Object.keys(reference).sort());
		for (const [key, value] of Object.entries(messages)) {
			assert.ok(value.trim(), `empty translation: ${key}`);
			assert.strictEqual(placeholders(value), placeholders(key), `placeholders differ: ${key}`);
		}
	});
}

test('every literal _t() key in app.js has a translation', () => {
	const source = readFileSync(new URL('app.js', root), 'utf8');
	const keys = [...source.matchAll(/_t\((?:[^'"()]*\? )?(['"])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n'));
	assert.ok(keys.length > 40, 'expected to find the _t() calls');
	const missing = [...new Set(keys)].filter(key => !(key in reference));
	assert.deepStrictEqual(missing, []);
});
