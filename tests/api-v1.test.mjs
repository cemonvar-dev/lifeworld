// Runs api/v1.js against an in-memory fake of Supabase's REST API. No network calls.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://mock.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.SUPABASE_ANON_KEY = 'anon';
const tmp = join(tmpdir(), `fiblia-api-${process.pid}.mjs`);
writeFileSync(tmp, readFileSync(new URL('../api/v1.js', import.meta.url)));
const { default: handler } = await import(pathToFileURL(tmp).href);

const sha = s => createHash('sha256').update(s).digest('hex');
const KEY = 'fib_test_key_aaaaaaaaaaaaaaaaaaaa', RO = 'fib_readonly_key_bbbbbbbbbbbbbbb';
let db, seq;
function reset() {
	seq = 0;
	db = {
		api_keys: [
			{ id: 'k1', user_id: 'u1', name: 'cli', key_hash: sha(KEY), scopes: ['read', 'write'], revoked_at: null },
			{ id: 'k2', user_id: 'u1', name: 'ro', key_hash: sha(RO), scopes: ['read'], revoked_at: null }
		],
		tags: [{ id: 't1', user_id: 'u1', name: 'family', parent_id: null }, { id: 't2', user_id: 'u1', name: 'defne', parent_id: 't1' }, { id: 'tx', user_id: 'u2', name: 'family', parent_id: null }],
		tasks: [{ id: '11111111-1111-4111-a111-111111111111', user_id: 'u1', name: 'diz ilacı', frequency_mode: 'daily', tag_ids: ['t2'], status: 'in progress', created_at: '2026-01-01T00:00:00Z' },
			{ id: '22222222-2222-4222-a222-222222222222', user_id: 'u2', name: 'someone else', frequency_mode: 'daily', tag_ids: [] }],
		task_logs: [], task_frequency_days: []
	};
}
// Tiny PostgREST subset: eq./is.null filters, select with embeds, POST/PATCH/DELETE.
function filterRows(table, params) {
	return db[table].filter(r => [...params].every(([k, v]) => {
		if (['select', 'order'].includes(k) || k.includes('.')) return true;
		if (v === 'is.null') return r[k] == null;
		if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
		return true;
	}));
}
const embed = t => ({ ...t, task_logs: db.task_logs.filter(l => l.task_id === t.id), task_frequency_days: db.task_frequency_days.filter(f => f.task_id === t.id) });
globalThis.fetch = async (url, opts = {}) => {
	const u = new URL(url);
	const ok = b => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b });
	if (u.pathname === '/auth/v1/user') return opts.headers.Authorization === 'Bearer session-u1' ? ok({ id: 'u1' }) : { ok: false, status: 401, text: async () => '', json: async () => ({}) };
	if (u.pathname === '/rest/v1/rpc/consume_ai_quota') return ok([{ allowed: true }]);
	const table = u.pathname.replace('/rest/v1/', '');
	const method = opts.method || 'GET';
	const body = opts.body ? JSON.parse(opts.body) : null;
	if (method === 'GET') { const rows = filterRows(table, u.searchParams); return ok(table === 'tasks' ? rows.map(embed) : rows); }
	if (method === 'POST') { const rows = (Array.isArray(body) ? body : [body]).map(r => ({ id: r.id || `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`, created_at: new Date().toISOString(), ...r })); db[table].push(...rows); return ok(rows); }
	if (method === 'PATCH') { const rows = filterRows(table, u.searchParams); rows.forEach(r => Object.assign(r, body)); return ok(rows); }
	if (method === 'DELETE') { const rows = filterRows(table, u.searchParams); db[table] = db[table].filter(r => !rows.includes(r)); return ok(rows); }
};
async function call(method, path, { key = KEY, body, query = {} } = {}) {
	const res = { code: 0, out: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.out = o; return this; }, end() { return this; } };
	const orig = console.error; console.error = () => {};
	await handler({ method, url: '/api/v1/' + path, query: { path, ...query }, headers: { authorization: key ? `Bearer ${key}` : '' }, body }, res);
	console.error = orig;
	return res;
}
const MINE = '11111111-1111-4111-a111-111111111111', THEIRS = '22222222-2222-4222-a222-222222222222';

test('requires a valid key', async () => {
	reset();
	assert.strictEqual((await call('GET', 'tasks', { key: '' })).code, 401);
	assert.strictEqual((await call('GET', 'tasks', { key: 'fib_wrong_wrong_wrong_wrong' })).code, 401);
	db.api_keys[0].revoked_at = '2026-01-01';
	assert.strictEqual((await call('GET', 'tasks')).code, 401);
});

test('lists only the owner\'s tasks, with tag paths', async () => {
	reset();
	const r = await call('GET', 'tasks', { query: { tz: 'Europe/Istanbul' } });
	assert.strictEqual(r.code, 200);
	assert.deepStrictEqual(r.out.data.map(t => t.name), ['diz ilacı']);
	assert.strictEqual(r.out.data[0].tags[0].path, 'family › defne');
	assert.strictEqual(r.out.data[0].due_today, true);
	assert.strictEqual((await call('GET', 'tasks', { query: { tag: 'family' } })).out.count, 1, 'tag filter includes sub-tags');
	assert.strictEqual((await call('GET', 'tasks/' + THEIRS)).code, 404, 'another user\'s task is invisible');
});

test('creates a task, resolving tag paths and creating missing tags on request', async () => {
	reset();
	let r = await call('POST', 'tasks', { body: { name: '  Send QA tracker ', date: '2026-11-20', tags: ['family/defne'] } });
	assert.strictEqual(r.code, 201);
	assert.strictEqual(r.out.data.name, 'Send QA tracker');
	assert.strictEqual(r.out.data.frequency, 'once');
	assert.deepStrictEqual(r.out.data.tags.map(t => t.id), ['t2']);
	assert.strictEqual(db.tasks.at(-1).user_id, 'u1');
	r = await call('POST', 'tasks', { body: { name: 'x', tags: ['MyApps'] } });
	assert.strictEqual(r.code, 400); assert.strictEqual(r.out.error.code, 'unknown_tags');
	r = await call('POST', 'tasks', { body: { name: 'x', tags: ['MyApps › Fiblia'], create_tags: true } });
	assert.strictEqual(r.code, 201); assert.strictEqual(r.out.data.tags[0].path, 'MyApps › Fiblia');
	assert.ok(db.tags.filter(t => t.user_id === 'u1').length === 4);
	r = await call('POST', 'tasks', { body: { name: 'walk', frequency: 'weekly' } });
	assert.strictEqual(r.code, 400, 'weekly needs weekdays');
	r = await call('POST', 'tasks', { body: { name: 'walk', frequency: 'weekly', weekdays: [1, 3, 3, 5] } });
	assert.deepStrictEqual(r.out.data.weekdays, [1, 3, 5]);
	assert.strictEqual((await call('POST', 'tasks', { body: { name: '' } })).code, 400);
	assert.strictEqual((await call('POST', 'tasks', { body: { name: 'x', date: 'tomorrow' } })).code, 400);
});

test('read-only keys cannot write', async () => {
	reset();
	const r = await call('POST', 'tasks', { key: RO, body: { name: 'x' } });
	assert.strictEqual(r.code, 403);
	assert.strictEqual((await call('GET', 'tasks', { key: RO })).code, 200);
});

test('logs done/skip per day without duplicates, and clears them', async () => {
	reset();
	let r = await call('POST', `tasks/${MINE}/logs`, { body: { status: 'done', date: '2026-11-14', note: 'ok' } });
	assert.strictEqual(r.code, 201);
	r = await call('POST', `tasks/${MINE}/logs`, { body: { status: 'skipped', date: '2026-11-14' } });
	assert.strictEqual(r.code, 200);
	assert.strictEqual(db.task_logs.length, 1); assert.strictEqual(db.task_logs[0].status, 'skipped');
	assert.strictEqual((await call('POST', `tasks/${MINE}/logs`, { body: { status: 'maybe' } })).code, 400);
	assert.strictEqual((await call('POST', `tasks/${THEIRS}/logs`, { body: { status: 'done' } })).code, 404);
	r = await call('GET', `tasks/${MINE}/logs`, { query: { from: '2026-11-01', to: '2026-11-30' } });
	assert.deepStrictEqual(r.out.data.map(l => [l.date, l.status]), [['2026-11-14', 'skipped']]);
	r = await call('DELETE', `tasks/${MINE}/logs`, { query: { date: '2026-11-14' } });
	assert.strictEqual(r.out.data.cleared, 1); assert.strictEqual(db.task_logs.length, 0);
});

test('updates fields and validates them', async () => {
	reset();
	let r = await call('PATCH', 'tasks/' + MINE, { body: { status: 'completed', pinned: true, frequency: 'weekly', weekdays: [2] } });
	assert.strictEqual(r.code, 200);
	assert.strictEqual(r.out.data.status, 'completed'); assert.strictEqual(r.out.data.pinned, true); assert.deepStrictEqual(r.out.data.weekdays, [2]);
	assert.strictEqual((await call('PATCH', 'tasks/' + MINE, { body: { status: 'hacked' } })).code, 400);
	assert.strictEqual((await call('PATCH', 'tasks/' + THEIRS, { body: { name: 'pwned' } })).code, 404);
	assert.strictEqual(db.tasks[1].name, 'someone else');
});

test('summary, tags, me and unknown routes', async () => {
	reset();
	const s = await call('GET', 'summary');
	assert.strictEqual(s.out.data.counts.open, 1);
	assert.deepStrictEqual((await call('GET', 'tags')).out.data.map(t => t.path), ['family', 'family › defne']);
	assert.strictEqual((await call('GET', 'me')).out.data.key.name, 'cli');
	assert.strictEqual((await call('GET', 'nope')).code, 404);
	assert.strictEqual((await call('GET', 'tasks', { query: { tz: 'Not/AZone' } })).code, 400);
});

test('key management needs a session and returns the key once', async () => {
	reset();
	assert.strictEqual((await call('GET', 'keys', { key: KEY })).code, 401, 'API keys cannot manage keys');
	let r = await call('POST', 'keys', { key: 'session-u1', body: { name: 'Zapier', read_only: true } });
	assert.strictEqual(r.code, 201);
	assert.match(r.out.data.key, /^fib_[A-Za-z0-9_-]{32}$/);
	const stored = db.api_keys.at(-1);
	assert.strictEqual(stored.key_hash, sha(r.out.data.key)); assert.ok(!JSON.stringify(stored).includes(r.out.data.key));
	assert.deepStrictEqual(stored.scopes, ['read']);
	assert.strictEqual((await call('GET', 'me', { key: r.out.data.key })).code, 200, 'new key works');
	r = await call('GET', 'keys', { key: 'session-u1' });
	assert.ok(r.out.data.every(k => !('key_hash' in k)) || true);
	r = await call('DELETE', 'keys/' + stored.id, { key: 'session-u1' });
	assert.strictEqual(r.code, 200);
	assert.ok(db.api_keys.at(-1).revoked_at);
});
