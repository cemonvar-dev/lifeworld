// Account deletion — verifies the caller's session, cancels any Lemon Squeezy
// subscription, deletes all of the user's data + storage, then removes the auth
// user. Destructive and irreversible.
//
// Required env vars (Vercel, server-only):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//   LEMONSQUEEZY_API_KEY - needed only to auto-cancel a premium user's subscription
//
// Called by the client with the user's access token:
//   POST /api/delete-account   Authorization: Bearer <supabase access_token>

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const LEMONSQUEEZY_API_KEY = process.env.LEMONSQUEEZY_API_KEY;

const LS_API = 'https://api.lemonsqueezy.com/v1';
const LS_ACTIVE = new Set(['active', 'on_trial', 'past_due']); // still-billable → cancel

// Resolve the caller from their access token (RLS-independent identity check).
async function getUserFromToken(token) {
	if (!token || !SUPABASE_ANON_KEY) return null;
	try {
		const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
			headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
		});
		if (!resp.ok) return null;
		return await resp.json();
	} catch { return null; }
}

// Service-role REST helper (bypasses RLS — only ever used server-side).
function sb(path, opts = {}) {
	return fetch(`${SUPABASE_URL}${path}`, {
		...opts,
		headers: {
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json',
			...(opts.headers || {})
		}
	});
}

// Cancel every still-billable Lemon Squeezy subscription for this user.
// Returns { ok, skipped } — ok=false means we must NOT proceed with deletion.
async function cancelSubscriptions(userId) {
	// Find the LS customer id we recorded at checkout.
	const cRes = await sb(`/rest/v1/billing_customers?user_id=eq.${userId}&select=customer_id`);
	const rows = cRes.ok ? await cRes.json() : [];
	const customerId = rows?.[0]?.customer_id;
	if (!customerId) return { ok: true, skipped: 'no-subscription' }; // nothing billable on record

	if (!LEMONSQUEEZY_API_KEY) return { ok: false, reason: 'billing-not-configured' };

	const lsHeaders = {
		Accept: 'application/vnd.api+json',
		'Content-Type': 'application/vnd.api+json',
		Authorization: `Bearer ${LEMONSQUEEZY_API_KEY}`
	};
	const listRes = await fetch(`${LS_API}/subscriptions?filter[customer_id]=${encodeURIComponent(customerId)}`, { headers: lsHeaders });
	if (!listRes.ok) return { ok: false, reason: 'lemon-list-failed' };
	const list = await listRes.json();
	const subs = (list.data || []).filter(s => LS_ACTIVE.has(s.attributes?.status));

	for (const s of subs) {
		// DELETE cancels the subscription (access continues until period end).
		const del = await fetch(`${LS_API}/subscriptions/${s.id}`, { method: 'DELETE', headers: lsHeaders });
		if (!del.ok) return { ok: false, reason: 'lemon-cancel-failed' };
	}
	return { ok: true, cancelled: subs.length };
}

async function deleteUserData(userId) {
	// Remove attachment files from storage using the recorded paths.
	const aRes = await sb(`/rest/v1/task_attachments?user_id=eq.${userId}&select=path`);
	const atts = aRes.ok ? await aRes.json() : [];
	const paths = atts.map(a => a.path).filter(Boolean);
	if (paths.length) {
		await sb(`/storage/v1/object/attachments`, {
			method: 'DELETE',
			body: JSON.stringify({ prefixes: paths })
		});
	}

	// Child tables keyed by task (task_logs / task_frequency_days have no user_id).
	const tRes = await sb(`/rest/v1/tasks?user_id=eq.${userId}&select=id`);
	const taskIds = (tRes.ok ? await tRes.json() : []).map(t => t.id);
	if (taskIds.length) {
		const inList = `(${taskIds.join(',')})`;
		await sb(`/rest/v1/task_logs?task_id=in.${inList}`, { method: 'DELETE' });
		await sb(`/rest/v1/task_frequency_days?task_id=in.${inList}`, { method: 'DELETE' });
	}

	// Tables keyed by user_id. Best-effort: a missing table just no-ops.
	for (const table of ['task_attachments', 'tasks', 'tags', 'ai_memory', 'ai_usage', 'billing_customers', 'stripe_customers']) {
		await sb(`/rest/v1/${table}?user_id=eq.${userId}`, { method: 'DELETE' });
	}
}

export default async function handler(req, res) {
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
	if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
		return res.status(500).json({ error: 'Server not configured' });
	}

	const auth = req.headers.authorization || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	const user = await getUserFromToken(token);
	if (!user || !user.id) return res.status(401).json({ error: 'Not authenticated' });

	const userId = user.id;
	const isPremium = !!(user.app_metadata?.premium || user.user_metadata?.premium);

	try {
		// 1) Cancel billing first — never delete the account while a paid sub lives on.
		const cancel = await cancelSubscriptions(userId);
		if (!cancel.ok) {
			return res.status(409).json({
				error: 'subscription_cancel_failed',
				message: 'We could not cancel your active subscription automatically. Please cancel it first, then try again, or contact info@fiblia.com.'
			});
		}

		// 2) Delete all user data + storage.
		await deleteUserData(userId);

		// 3) Delete the auth user (removes login + any cascade-linked rows).
		const del = await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
		if (!del.ok) {
			const body = await del.text();
			console.error('auth user delete failed:', del.status, body);
			return res.status(500).json({ error: 'auth_delete_failed' });
		}

		return res.status(200).json({ ok: true, subscription: cancel.cancelled || 0, premium: isPremium });
	} catch (err) {
		console.error('delete-account error:', err);
		return res.status(500).json({ error: 'delete_failed' });
	}
}
