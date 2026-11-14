// Fiblia public API, v1. One function; vercel.json rewrites /api/v1/<path> here.
//
// Auth:  Authorization: Bearer fib_...   (personal API key, created in Settings)
//        Key management (/keys) uses the signed-in user's Supabase session instead.
// Docs:  /developers.html
//
// Required env vars (Vercel, server-only): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// Optional: API_DAILY_LIMIT (requests per key per day, default 5000)
// One-time DB setup: scripts/api-keys.sql (and scripts/ai-quota.sql for the rate limit).

import { createHash, randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://baswgycuhblyppvvdpay.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DAILY_LIMIT = parseInt(process.env.API_DAILY_LIMIT || '5000', 10);
const MAX_KEYS = 10;
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'once'];
const STATUSES = ['in progress', 'planned', 'completed', 'cancelled'];
const FINISHED = ['completed', 'cancelled', 'failed'];
const isActive = s => !FINISHED.includes(s || 'in progress');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ApiError extends Error {
	constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (message, extra) => new ApiError(400, 'invalid_request', message, extra);

// ---- Supabase (service role: every query below filters by the key owner's user_id) ----
function sb(path, opts = {}) {
	return fetch(`${SUPABASE_URL}${path}`, {
		...opts,
		headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
	});
}
async function sbJson(path, opts) {
	const r = await sb(path, opts);
	const text = await r.text();
	let body = null;
	try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
	if (!r.ok) {
		console.error('supabase error', r.status, path.split('?')[0], text.slice(0, 300));
		throw new ApiError(502, 'storage_error', 'The data store did not accept the request.');
	}
	return body;
}
const enc = encodeURIComponent;
const sha256 = s => createHash('sha256').update(s).digest('hex');
const derivedUuid = seed => { const h = sha256(seed); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ---- Auth ----
async function userFromSession(token) {
	if (!token || !ANON_KEY) return null;
	try {
		const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY } });
		return r.ok ? await r.json() : null;
	} catch { return null; }
}
async function keyFromToken(token) {
	if (!token || !token.startsWith('fib_') || token.length < 20) return null;
	const rows = await sbJson(`/rest/v1/api_keys?key_hash=eq.${sha256(token)}&revoked_at=is.null&select=id,user_id,name,scopes,last_used_at`);
	const key = rows && rows[0];
	if (!key) return null;
	if (!key.last_used_at || Date.now() - Date.parse(key.last_used_at) > 10 * 60 * 1000) {
		await sb(`/rest/v1/api_keys?id=eq.${key.id}`, { method: 'PATCH', body: JSON.stringify({ last_used_at: new Date().toISOString() }) }).catch(() => {});
	}
	return key;
}
async function rateLimit(keyId) {
	try {
		const r = await sb('/rest/v1/rpc/consume_ai_quota', { method: 'POST', body: JSON.stringify({ p_user_id: derivedUuid('api:' + keyId), p_limit: DAILY_LIMIT }) });
		if (!r.ok) return; // limiter unavailable: fail open rather than block integrations
		const rows = await r.json();
		const q = Array.isArray(rows) ? rows[0] : rows;
		if (q && q.allowed === false) throw new ApiError(429, 'rate_limited', `Daily limit of ${DAILY_LIMIT} requests reached for this key.`);
	} catch (e) { if (e instanceof ApiError) throw e; }
}

// ---- Dates & schedules ----
function todayIn(tz) {
	try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
	catch { throw bad('Unknown time zone: ' + tz); }
}
const logDay = l => l.log_date || (l.created_at ? String(l.created_at).slice(0, 10) : '');
function isDueOn(task, day) {
	const mode = task.frequency_mode || 'daily';
	const [y, m, d] = day.split('-').map(Number);
	if (mode === 'daily') return true;
	if (mode === 'once') return task.end_date === day;
	if (mode === 'weekly') return (task.task_frequency_days || []).some(f => f.day_of_week === new Date(Date.UTC(y, m - 1, d)).getUTCDay()) && isRepeatWeek(task, day);
	if (mode === 'monthly') {
		const dom = parseInt(task.day_of_month, 10) >= 1 ? parseInt(task.day_of_month, 10) : (task.created_at ? new Date(task.created_at).getUTCDate() : 1);
		return Math.min(dom, new Date(Date.UTC(y, m, 0)).getUTCDate()) === d;
	}
	return false;
}

// Weekly tasks may repeat every N weeks, counted in Monday-start weeks from repeat_anchor (or creation).
const everyWeeks = t => { const n = parseInt(t.repeat_every, 10); return n >= 1 && n <= 12 ? n : 1; };
function isRepeatWeek(task, day) {
	const n = everyWeeks(task);
	if (n === 1) return true;
	const a = String(task.repeat_anchor || task.created_at || '').slice(0, 10);
	if (!DATE_RE.test(a)) return true;
	const monday = k => { const [y, m, d] = k.split('-').map(Number); const t = Date.UTC(y, m - 1, d); return t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000; };
	const weeks = Math.round((monday(day) - monday(a)) / (7 * 86400000));
	return ((weeks % n) + n) % n === 0;
}

// ---- Tags ----
async function loadTags(userId) {
	let rows;
	try { rows = await sbJson(`/rest/v1/tags?user_id=eq.${userId}&select=id,name,parent_id,sort_order,color`); }
	catch { rows = await sbJson(`/rest/v1/tags?user_id=eq.${userId}&select=id,name,parent_id,sort_order`); }
	const byId = {};
	(rows || []).forEach(t => { byId[t.id] = t; });
	const path = id => { const parts = []; let cur = byId[id], g = 0; while (cur && g++ < 30) { parts.unshift(cur.name); cur = cur.parent_id ? byId[cur.parent_id] : null; } return parts.join(' › '); };
	return { rows: rows || [], byId, path };
}
const normPath = s => String(s).split(/\s*(?:›|>|\/)\s*/).map(p => p.trim().toLocaleLowerCase()).filter(Boolean).join(' › ');

// Accepts tag ids, full paths ("family › defne") or unique names. Optionally creates missing ones.
async function resolveTags(userId, tags, input, createMissing) {
	if (input == null) return null;
	if (!Array.isArray(input) || input.some(t => typeof t !== 'string' || !t.trim() || t.length > 200)) throw bad('tags must be an array of tag ids, names or paths.');
	const ids = [], unknown = [];
	for (const raw of input.slice(0, 20)) {
		if (tags.byId[raw]) { ids.push(raw); continue; }
		const want = normPath(raw);
		const byPath = tags.rows.filter(t => normPath(tags.path(t.id)) === want);
		const byName = want.includes(' › ') ? [] : tags.rows.filter(t => t.name.toLocaleLowerCase() === want);
		const hit = byPath.length === 1 ? byPath[0] : byName.length === 1 ? byName[0] : null;
		if (hit) { ids.push(hit.id); continue; }
		if (byName.length > 1) throw bad(`Tag name "${raw}" is ambiguous; use its full path or id.`, { matches: byName.map(t => tags.path(t.id)) });
		if (!createMissing) { unknown.push(raw); continue; }
		ids.push(await createTagPath(userId, tags, raw));
	}
	if (unknown.length) throw new ApiError(400, 'unknown_tags', 'Some tags do not exist. Pass create_tags: true to create them.', { unknown });
	return [...new Set(ids)];
}
async function createTagPath(userId, tags, raw) {
	const parts = String(raw).split(/\s*(?:›|>|\/)\s*/).map(p => p.trim()).filter(Boolean).slice(0, 6);
	let parent = null;
	for (const name of parts) {
		const existing = tags.rows.find(t => (t.parent_id || null) === parent && t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
		if (existing) { parent = existing.id; continue; }
		const sibs = tags.rows.filter(t => (t.parent_id || null) === parent);
		const [row] = await sbJson('/rest/v1/tags', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: userId, name: name.slice(0, 60), parent_id: parent, sort_order: sibs.length }) });
		tags.rows.push(row); tags.byId[row.id] = row;
		parent = row.id;
	}
	return parent;
}

// ---- Tasks ----
const TASK_SELECT = 'select=*,task_logs(id,status,log_date,created_at,note),task_frequency_days(day_of_week)';
async function getTask(userId, id) {
	if (!isUuid(id)) throw new ApiError(404, 'not_found', 'Task not found.');
	const rows = await sbJson(`/rest/v1/tasks?id=eq.${id}&user_id=eq.${userId}&${TASK_SELECT}`);
	if (!rows || !rows[0]) throw new ApiError(404, 'not_found', 'Task not found.');
	return rows[0];
}
function dayStatus(task, day) {
	const hits = (task.task_logs || []).filter(l => logDay(l) === day && ['done', 'completed', 'skipped'].includes(l.status))
		.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
	return hits[0] ? (hits[0].status === 'skipped' ? 'skipped' : 'done') : null;
}
function toApiTask(t, tags, today) {
	const done = (t.task_logs || []).filter(l => l.status === 'done' || l.status === 'completed').map(logDay).filter(Boolean).sort();
	const status = t.status || 'in progress';
	return {
		id: t.id,
		name: t.name,
		frequency: t.frequency_mode || 'daily',
		weekdays: (t.task_frequency_days || []).map(f => f.day_of_week).sort((a, b) => a - b),
		every_weeks: everyWeeks(t),
		day_of_month: t.day_of_month ?? null,
		date: t.end_date || null,
		status,
		pinned: !!t.pinned,
		notes: t.notes ?? null,
		tags: (t.tag_ids || []).filter(id => tags.byId[id]).map(id => ({ id, name: tags.byId[id].name, path: tags.path(id) })),
		due_today: isActive(status) && isDueOn(t, today),
		today: dayStatus(t, today),
		last_done: done[done.length - 1] || null,
		created_at: t.created_at || null
	};
}

function readTaskFields(body, { partial }) {
	const out = {};
	if (body.name !== undefined || !partial) {
		if (typeof body.name !== 'string' || !body.name.trim()) throw bad('name is required.');
		out.name = body.name.trim().slice(0, 200);
	}
	if (body.frequency !== undefined || !partial) {
		const f = body.frequency === undefined ? 'once' : body.frequency;
		if (!FREQUENCIES.includes(f)) throw bad(`frequency must be one of ${FREQUENCIES.join(', ')}.`);
		out.frequency_mode = f;
	}
	if (body.date !== undefined) {
		if (body.date !== null && !(typeof body.date === 'string' && DATE_RE.test(body.date))) throw bad('date must be YYYY-MM-DD or null.');
		out.end_date = body.date;
	}
	if (body.every_weeks !== undefined) {
		if (!(Number.isInteger(body.every_weeks) && body.every_weeks >= 1 && body.every_weeks <= 12)) throw bad('every_weeks must be 1-12.');
		out.repeat_every = body.every_weeks;
		out.repeat_anchor = todayIn('UTC');
	}
	if (body.day_of_month !== undefined) {
		if (body.day_of_month !== null && !(Number.isInteger(body.day_of_month) && body.day_of_month >= 1 && body.day_of_month <= 31)) throw bad('day_of_month must be 1-31 or null.');
		out.day_of_month = body.day_of_month;
	}
	if (body.status !== undefined) {
		if (!STATUSES.includes(body.status)) throw bad(`status must be one of ${STATUSES.join(', ')}.`);
		out.status = body.status;
	}
	if (body.pinned !== undefined) {
		if (typeof body.pinned !== 'boolean') throw bad('pinned must be true or false.');
		out.pinned = body.pinned;
	}
	if (body.notes !== undefined) {
		if (body.notes !== null && typeof body.notes !== 'string') throw bad('notes must be a string or null.');
		out.notes = body.notes === null ? null : body.notes.slice(0, 5000);
	}
	let weekdays;
	if (body.weekdays !== undefined) {
		if (!Array.isArray(body.weekdays) || body.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('weekdays must be an array of 0 (Sunday) .. 6 (Saturday).');
		weekdays = [...new Set(body.weekdays)];
	}
	return { fields: out, weekdays };
}
async function setWeekdays(taskId, weekdays) {
	await sbJson(`/rest/v1/task_frequency_days?task_id=eq.${taskId}`, { method: 'DELETE' });
	if (weekdays && weekdays.length) await sbJson('/rest/v1/task_frequency_days', { method: 'POST', body: JSON.stringify(weekdays.map(d => ({ task_id: taskId, day_of_week: d }))) });
}

// ---- Route handlers ----
async function listTasks(ctx) {
	const { userId, query, today } = ctx;
	const tags = await loadTags(userId);
	const rows = await sbJson(`/rest/v1/tasks?user_id=eq.${userId}&${TASK_SELECT}&order=created_at.asc`);
	let list = (rows || []).map(t => toApiTask(t, tags, today));
	const status = query.status || 'active';
	if (status === 'active') list = list.filter(t => isActive(t.status));
	else if (status !== 'all') { if (!STATUSES.includes(status)) throw bad('status must be active, all, in progress, planned, completed or cancelled.'); list = list.filter(t => t.status === status); }
	if (query.tag) {
		const [tagId] = await resolveTags(userId, tags, [String(query.tag)], false);
		const wanted = new Set([tagId]);
		let grew = true;
		while (grew) { grew = false; tags.rows.forEach(t => { if (t.parent_id && wanted.has(t.parent_id) && !wanted.has(t.id)) { wanted.add(t.id); grew = true; } }); }
		list = list.filter(t => t.tags.some(x => wanted.has(x.id)));
	}
	if (query.due === 'today') list = list.filter(t => t.due_today);
	if (query.pinned === 'true') list = list.filter(t => t.pinned);
	if (query.q) { const q = String(query.q).toLocaleLowerCase(); list = list.filter(t => t.name.toLocaleLowerCase().includes(q)); }
	return { status: 200, body: { data: list, count: list.length } };
}

async function createTask(ctx) {
	const { userId, body, today } = ctx;
	const { fields, weekdays } = readTaskFields(body, { partial: false });
	if (fields.frequency_mode === 'weekly' && !(weekdays && weekdays.length)) throw bad('weekly tasks need weekdays, e.g. [1,3,5].');
	if (fields.frequency_mode !== 'once') delete fields.end_date;
	const tags = await loadTags(userId);
	const tagIds = await resolveTags(userId, tags, body.tags, body.create_tags === true);
	const [row] = await sbJson('/rest/v1/tasks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: userId, ...fields, tag_ids: tagIds || [], end_date: fields.end_date ?? null }) });
	if (fields.frequency_mode === 'weekly') await setWeekdays(row.id, weekdays);
	return { status: 201, body: { data: toApiTask(await getTask(userId, row.id), tags, today) } };
}

async function updateTask(ctx, id) {
	const { userId, body, today } = ctx;
	const current = await getTask(userId, id);
	const { fields, weekdays } = readTaskFields(body, { partial: true });
	const tags = await loadTags(userId);
	const tagIds = await resolveTags(userId, tags, body.tags, body.create_tags === true);
	if (tagIds) fields.tag_ids = tagIds;
	const mode = fields.frequency_mode || current.frequency_mode || 'daily';
	if (mode === 'weekly' && weekdays === undefined && !(current.task_frequency_days || []).length && fields.frequency_mode === 'weekly') throw bad('weekly tasks need weekdays, e.g. [1,3,5].');
	if (Object.keys(fields).length) await sbJson(`/rest/v1/tasks?id=eq.${id}&user_id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify(fields) });
	if (weekdays !== undefined) await setWeekdays(id, mode === 'weekly' ? weekdays : []);
	else if (fields.frequency_mode && fields.frequency_mode !== 'weekly') await setWeekdays(id, []);
	return { status: 200, body: { data: toApiTask(await getTask(userId, id), tags, today) } };
}

async function logTask(ctx, id) {
	const { userId, body, today } = ctx;
	const task = await getTask(userId, id);
	const status = body.status;
	if (status !== 'done' && status !== 'skipped') throw bad('status must be "done" or "skipped".');
	const date = body.date === undefined ? today : body.date;
	if (typeof date !== 'string' || !DATE_RE.test(date)) throw bad('date must be YYYY-MM-DD.');
	if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw bad('note must be a string.');
	const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined;
	const existing = (task.task_logs || []).find(l => logDay(l) === date && ['done', 'skipped', 'completed'].includes(l.status));
	if (existing) await sbJson(`/rest/v1/task_logs?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify({ status, ...(note !== undefined ? { note } : {}) }) });
	else await sbJson('/rest/v1/task_logs', { method: 'POST', body: JSON.stringify({ task_id: id, status, log_date: date, ...(note !== undefined ? { note } : {}) }) });
	return { status: existing ? 200 : 201, body: { data: { task_id: id, date, status, note: note ?? existing?.note ?? null } } };
}

async function clearLog(ctx, id) {
	const { userId, query, today } = ctx;
	const task = await getTask(userId, id);
	const date = query.date || today;
	if (!DATE_RE.test(date)) throw bad('date must be YYYY-MM-DD.');
	const hits = (task.task_logs || []).filter(l => logDay(l) === date && ['done', 'skipped', 'completed'].includes(l.status));
	for (const l of hits) await sbJson(`/rest/v1/task_logs?id=eq.${l.id}`, { method: 'DELETE' });
	return { status: 200, body: { data: { task_id: id, date, cleared: hits.length } } };
}

async function listLogs(ctx, id) {
	const { userId, query, today } = ctx;
	const task = await getTask(userId, id);
	const from = query.from || (() => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 29)).toISOString().slice(0, 10); })();
	const to = query.to || today;
	if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw bad('from and to must be YYYY-MM-DD.');
	const logs = (task.task_logs || []).map(l => ({ id: l.id, date: logDay(l), status: l.status === 'completed' ? 'done' : l.status, note: l.note ?? null }))
		.filter(l => l.date >= from && l.date <= to).sort((a, b) => b.date.localeCompare(a.date));
	return { status: 200, body: { data: logs, from, to } };
}

async function summary(ctx) {
	const { userId, query, today } = ctx;
	const day = query.date || today;
	if (!DATE_RE.test(day)) throw bad('date must be YYYY-MM-DD.');
	const tags = await loadTags(userId);
	const rows = await sbJson(`/rest/v1/tasks?user_id=eq.${userId}&${TASK_SELECT}`);
	const due = (rows || []).filter(t => isActive(t.status) && isDueOn(t, day))
		.map(t => ({ ...toApiTask(t, tags, today), status_on_date: dayStatus(t, day) }));
	const counts = { done: 0, skipped: 0, open: 0 };
	due.forEach(t => { counts[t.status_on_date || 'open']++; });
	return { status: 200, body: { data: { date: day, counts, tasks: due } } };
}

async function listTagsRoute(ctx) {
	const tags = await loadTags(ctx.userId);
	const data = tags.rows
		.sort((a, b) => tags.path(a.id).localeCompare(tags.path(b.id)))
		.map(t => ({ id: t.id, name: t.name, path: tags.path(t.id), parent_id: t.parent_id || null, color: t.color || null }));
	return { status: 200, body: { data } };
}

// ---- Key management (signed-in user session, from the app) ----
async function keysRoute(req, user, id, body) {
	if (req.method === 'GET' && !id) {
		const rows = await sbJson(`/rest/v1/api_keys?user_id=eq.${user.id}&revoked_at=is.null&select=id,name,prefix,scopes,created_at,last_used_at&order=created_at.desc`);
		return { status: 200, body: { data: rows || [] } };
	}
	if (req.method === 'POST' && !id) {
		const active = await sbJson(`/rest/v1/api_keys?user_id=eq.${user.id}&revoked_at=is.null&select=id`);
		if ((active || []).length >= MAX_KEYS) throw bad(`You can have at most ${MAX_KEYS} active keys. Revoke one first.`);
		const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'API key';
		const scopes = body.read_only === true ? ['read'] : ['read', 'write'];
		const key = 'fib_' + randomBytes(24).toString('base64url');
		const [row] = await sbJson('/rest/v1/api_keys', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: user.id, name, prefix: key.slice(0, 12), key_hash: sha256(key), scopes }) });
		return { status: 201, body: { data: { id: row.id, name, prefix: row.prefix, scopes, created_at: row.created_at, key } } };
	}
	if (req.method === 'DELETE' && id) {
		if (!isUuid(id)) throw new ApiError(404, 'not_found', 'Key not found.');
		const rows = await sbJson(`/rest/v1/api_keys?id=eq.${id}&user_id=eq.${user.id}&revoked_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
		if (!rows || !rows.length) throw new ApiError(404, 'not_found', 'Key not found.');
		return { status: 200, body: { data: { id, revoked: true } } };
	}
	throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
}

function segments(req) {
	let p = req.query && req.query.path;
	if (Array.isArray(p)) p = p.join('/');
	if (!p) p = String(req.url || '').split('?')[0].replace(/^\/api\/v1\/?/, '');
	return String(p || '').split('/').filter(Boolean);
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Timezone');
	res.setHeader('Cache-Control', 'no-store');
	if (req.method === 'OPTIONS') return res.status(204).end();
	try {
		if (!SERVICE_KEY) throw new ApiError(500, 'not_configured', 'Server not configured.');
		const seg = segments(req);
		let body = req.body;
		if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { throw bad('Body must be valid JSON.'); } }
		if (body == null || typeof body !== 'object' || Array.isArray(body)) body = {};
		const auth = req.headers.authorization || '';
		const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

		if (seg[0] === 'keys') {
			const user = await userFromSession(token);
			if (!user || !user.id) throw new ApiError(401, 'unauthorized', 'Sign in to manage API keys.');
			const out = await keysRoute(req, user, seg[1], body);
			return res.status(out.status).json(out.body);
		}

		const key = await keyFromToken(token);
		if (!key) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key. Send Authorization: Bearer fib_...');
		await rateLimit(key.id);
		const write = req.method !== 'GET';
		if (!(key.scopes || []).includes(write ? 'write' : 'read')) throw new ApiError(403, 'forbidden', `This key has no ${write ? 'write' : 'read'} access.`);
		const query = req.query || {};
		const tz = String(query.tz || req.headers['x-timezone'] || 'UTC');
		const ctx = { userId: key.user_id, query, body, today: todayIn(tz) };
		const [a, id, sub] = seg;
		let out;
		const m = req.method;
		if (a === 'me' && !id && m === 'GET') out = { status: 200, body: { data: { user_id: key.user_id, key: { id: key.id, name: key.name, scopes: key.scopes } } } };
		else if (a === 'tags' && !id && m === 'GET') out = await listTagsRoute(ctx);
		else if (a === 'summary' && !id && m === 'GET') out = await summary(ctx);
		else if (a === 'tasks' && !id && m === 'GET') out = await listTasks(ctx);
		else if (a === 'tasks' && !id && m === 'POST') out = await createTask(ctx);
		else if (a === 'tasks' && id && !sub && m === 'GET') out = { status: 200, body: { data: toApiTask(await getTask(key.user_id, id), await loadTags(key.user_id), ctx.today) } };
		else if (a === 'tasks' && id && !sub && m === 'PATCH') out = await updateTask(ctx, id);
		else if (a === 'tasks' && id && sub === 'logs' && m === 'GET') out = await listLogs(ctx, id);
		else if (a === 'tasks' && id && sub === 'logs' && m === 'POST') out = await logTask(ctx, id);
		else if (a === 'tasks' && id && sub === 'logs' && m === 'DELETE') out = await clearLog(ctx, id);
		else throw new ApiError(404, 'not_found', 'Unknown endpoint. See https://fiblia.com/developers.html');
		return res.status(out.status).json(out.body);
	} catch (e) {
		if (e instanceof ApiError) return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.extra || {}) } });
		console.error('api v1 error:', e);
		return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error.' } });
	}
}
