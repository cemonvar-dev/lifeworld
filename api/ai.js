// LifeWorld AI endpoint — auth-gated + per-user daily quota.
//
// Required env vars (set in Vercel project settings, NEVER in client code):
//   OPENAI_API_KEY            - OpenAI secret key
//   SUPABASE_URL              - e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY         - public anon key (used to validate the user's JWT)
//   SUPABASE_SERVICE_ROLE_KEY - service role key (server-only; bypasses RLS for quota)
// Optional:
//   AI_DAILY_LIMIT            - free-tier messages per user per day (default 5)
//   ALLOWED_ORIGIN            - exact origin to allow via CORS (default "*")
//
// One-time DB setup: run scripts/ai-quota.sql in the Supabase SQL editor.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://baswgycuhblyppvvdpay.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AI_DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '5', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

async function getUserFromToken(token) {
	if (!token || !SUPABASE_ANON_KEY) return null;
	try {
		const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
			headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
		});
		if (!resp.ok) return null;
		return await resp.json();
	} catch {
		return null;
	}
}

// Atomically consume one quota unit. Returns { allowed, used, day_limit } or null on error.
async function consumeQuota(userId, limit) {
	if (!SUPABASE_SERVICE_ROLE_KEY) return null;
	try {
		const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_ai_quota`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				apikey: SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
			},
			body: JSON.stringify({ p_user_id: userId, p_limit: limit })
		});
		if (!resp.ok) return null;
		const rows = await resp.json();
		return Array.isArray(rows) ? rows[0] : rows;
	} catch {
		return null;
	}
}

export default async function handler(req, res) {
	// CORS
	res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
	if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
		return res.status(500).json({ error: 'Supabase server keys not configured' });
	}

	// --- Auth gate: require a valid Supabase session token ---
	const authHeader = req.headers.authorization || '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
	const user = await getUserFromToken(token);
	if (!user || !user.id) {
		return res.status(401).json({ error: 'Please sign in to use the AI assistant.' });
	}

	// --- Quota gate: premium bypasses, everyone else gets a daily limit ---
	const isPremium = !!(user.app_metadata?.premium || user.user_metadata?.premium);
	if (!isPremium) {
		const quota = await consumeQuota(user.id, AI_DAILY_LIMIT);
		if (!quota) {
			return res.status(500).json({ error: 'Could not verify your usage quota. Please try again.' });
		}
		if (!quota.allowed) {
			res.setHeader('X-AI-Quota-Limit', String(quota.day_limit));
			res.setHeader('X-AI-Quota-Used', String(quota.used));
			return res.status(429).json({
				error: `You've reached your free limit of ${quota.day_limit} AI messages today. Upgrade to LifeWorld Premium for unlimited coaching.`,
				code: 'quota_exceeded',
				limit: quota.day_limit,
				used: quota.used
			});
		}
	}

	const { messages, taskContext } = req.body;
	if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });

	const systemPrompt = `You are LifeWorld AI — a personal life coach and productivity assistant. You have access to the user's task/habit tracking data below. Use it to give specific, actionable advice.

Be encouraging but honest. Use emojis sparingly. Keep responses concise (2-4 paragraphs max unless asked for detail).

You can:
- Analyze health scores and suggest improvements
- Identify patterns (best/worst days, streaks, neglected tasks)
- Recommend schedule changes based on frequency compliance
- Motivate the user with personalized encouragement
- Suggest new habits or modifications to existing ones
- Answer any questions about their data

USER'S TASK DATA:
${taskContext || 'No task data available.'}`;

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: 'gpt-4o',
				messages: [
					{ role: 'system', content: systemPrompt },
					...messages
				],
				max_tokens: 1000,
				temperature: 0.7
			})
		});

		if (!response.ok) {
			const errData = await response.json().catch(() => ({}));
			console.error('OpenAI error:', errData);
			return res.status(response.status).json({ error: errData.error?.message || 'OpenAI API error' });
		}

		const data = await response.json();
		const reply = data.choices?.[0]?.message?.content || 'No response from AI.';
		return res.status(200).json({ reply });
	} catch (err) {
		console.error('AI handler error:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
}
