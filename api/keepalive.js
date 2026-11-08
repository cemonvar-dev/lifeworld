// Daily Supabase keep-alive — free-tier projects are paused after a period of
// inactivity. Run by the Vercel cron in vercel.json (production only).
//
// Uses the public anon key, so RLS applies: the query touches the database but
// returns no user rows, and the response only reports whether it succeeded.
//
// Required env vars (Vercel): SUPABASE_URL, SUPABASE_ANON_KEY
// Optional: CRON_SECRET — when set, Vercel sends it and other callers get 401.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
	if (req.method !== 'GET') return res.status(405).json({ ok: false });
	if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
		return res.status(401).json({ ok: false });
	}
	if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
		console.error('keepalive: SUPABASE_URL or SUPABASE_ANON_KEY is not set');
		return res.status(500).json({ ok: false });
	}
	try {
		const resp = await fetch(`${SUPABASE_URL}/rest/v1/tasks?select=id&limit=1`, {
			headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
		});
		if (!resp.ok) {
			console.error('keepalive: Supabase responded', resp.status);
			return res.status(502).json({ ok: false });
		}
		return res.status(200).json({ ok: true });
	} catch (err) {
		console.error('keepalive: request failed', err);
		return res.status(502).json({ ok: false });
	}
}
