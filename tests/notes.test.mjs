// Runs wireTileNotes with a fake DOM and Supabase client.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r/g, '');
const i = src.indexOf('function wireTileNotes'), code = src.slice(i, src.indexOf('// Persist a tile\'s reminder', i));
assert(src.includes("${'notes' in raw ?"), 'field must be gated on the column');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function setup(raw, fail = false) {
  const handlers = {}, classes = new Set(['hidden']);
  const input = { value: 'unset', addEventListener: (e, f) => handlers[e] = f };
  const errorEl = { classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c) } };
  const updates = [];
  const supa = { from: () => ({ update: patch => ({ eq: async (k, id) => { updates.push({ patch, k, id }); return { error: fail ? { message: 'x' } : null }; } }) }) };
  const document = { getElementById: id => id === 'tileNotesInput' ? input : id === 'tileNotesError' ? errorEl : null };
  new Function('document', 'supa', code + ';return wireTileNotes')(document, supa)(raw, 't1');
  return { input, handlers, updates, classes };
}
let raw = { notes: 'old <b>' }, t = setup(raw);
assert.strictEqual(t.input.value, 'old <b>'); console.log('ok existing notes loaded as plain text');
await t.handlers.blur(); assert.strictEqual(t.updates.length, 0); console.log('ok no save when unchanged');
t.input.value = 'a'; t.handlers.input(); t.input.value = 'ab'; t.handlers.input(); await sleep(800);
assert.strictEqual(t.updates.length, 1); assert.deepStrictEqual(t.updates[0], { patch: { notes: 'ab' }, k: 'id', id: 't1' }); assert.strictEqual(raw.notes, 'ab'); console.log('ok typing debounced into one save');
t.input.value = 'abc'; t.handlers.input(); await t.handlers.blur(); await sleep(800);
assert.strictEqual(t.updates.length, 2); console.log('ok blur saves now and cancels the pending save');
t.input.value = ''; await t.handlers.blur(); assert.strictEqual(raw.notes, null); assert.strictEqual(t.updates[2].patch.notes, null); console.log('ok cleared notes store null');
raw = { notes: null }; t = setup(raw); assert.strictEqual(t.input.value, ''); console.log('ok null shows empty');
raw = { notes: 'keep' }; t = setup(raw, true); t.input.value = 'new'; await t.handlers.blur();
assert.strictEqual(raw.notes, 'keep'); assert(!t.classes.has('hidden')); await t.handlers.blur(); assert.strictEqual(t.updates.length, 2); console.log('ok failed save shows error and retries');
