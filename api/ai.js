// LifeWorld AI endpoint — auth-gated + per-user daily quota.
//
// Required env vars (set in Vercel project settings, NEVER in client code):
//   OPENAI_API_KEY            - OpenAI secret key
//   SUPABASE_URL              - e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY         - public anon key (used to validate the user's JWT)
//   SUPABASE_SERVICE_ROLE_KEY - service role key (server-only; bypasses RLS for quota)
// Optional:
//   AI_DAILY_LIMIT            - free-tier messages per user per day (default 25)
//   ALLOWED_ORIGIN            - exact origin to allow via CORS (default "*")
//
// One-time DB setup: run scripts/ai-quota.sql in the Supabase SQL editor.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://baswgycuhblyppvvdpay.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AI_DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '25', 10);
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

// ---- Long-term memory (ai_memory table; service-role only) ----
// A compact, evolving profile of the user that is injected into the system
// prompt every session, so the assistant "remembers" across chats/devices.

async function getMemory(userId) {
	if (!SUPABASE_SERVICE_ROLE_KEY) return '';
	try {
		const resp = await fetch(`${SUPABASE_URL}/rest/v1/ai_memory?user_id=eq.${userId}&select=notes`, {
			headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
		});
		if (!resp.ok) return '';
		const rows = await resp.json();
		return (Array.isArray(rows) && rows[0] && rows[0].notes) ? rows[0].notes : '';
	} catch { return ''; }
}

async function saveMemory(userId, notes) {
	if (!SUPABASE_SERVICE_ROLE_KEY) return;
	try {
		await fetch(`${SUPABASE_URL}/rest/v1/ai_memory`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				apikey: SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
				Prefer: 'resolution=merge-duplicates' // upsert on the user_id primary key
			},
			body: JSON.stringify({ user_id: userId, notes: notes.slice(0, 4000), updated_at: new Date().toISOString() })
		});
	} catch { /* best-effort */ }
}

// Merge durable facts from the latest exchange into the user's memory.
async function updateMemory(apiKey, userId, prevNotes, userMsg, assistantReply) {
	try {
		const sys = `You maintain a concise long-term memory about a user of a habit-tracking app, based on their coaching chats. Merge any durable facts from the latest exchange (goals, motivations, recurring struggles, preferences, constraints, notable wins) into the existing memory. Keep it under 180 words as short bullet points. Drop anything stale, redundant, or trivial. Do NOT include day-to-day task stats (the app already provides those live). Output ONLY the updated memory text, no preamble.`;
		const user = `EXISTING MEMORY:\n${prevNotes || '(empty)'}\n\nLATEST EXCHANGE:\nUser: ${userMsg}\nAssistant: ${assistantReply}\n\nUpdated memory:`;
		const resp = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
				messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
				max_tokens: 350,
				temperature: 0.2
			})
		});
		if (!resp.ok) return;
		const data = await resp.json();
		const notes = data.choices?.[0]?.message?.content?.trim();
		if (notes) await saveMemory(userId, notes);
	} catch { /* best-effort; never blocks the chat */ }
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

	const { messages, taskContext, responseFormat } = req.body;
	if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });

	// Long-term memory only applies to normal chat (not the reschedule JSON call).
	const isChat = !(responseFormat && responseFormat.type === 'json_object');
	const memory = isChat ? await getMemory(user.id) : '';

	const systemPrompt = `You are LifeWorld AI — a personal life coach and productivity assistant. You have access to the user's task/habit tracking data below. Use it to give specific, actionable advice.

Be encouraging but honest. Use emojis sparingly. Keep responses concise (2-4 paragraphs max unless asked for detail).

You can:
- Analyze health scores and suggest improvements
- Identify patterns (best/worst days, streaks, neglected tasks)
- Recommend schedule changes based on frequency compliance
- Motivate the user with personalized encouragement
- Suggest new habits or modifications to existing ones
- Answer any questions about their data
- CREATE, UPDATE, or DELETE the user's tasks when they clearly ask you to

TASK ACTIONS
When (and only when) the user clearly asks you to add, change, rename, reschedule,
or remove task(s), respond with ONLY a JSON object — no prose, no code fences — in
exactly this shape:
{"actions":[ <action>, ... ], "message":"<one short friendly confirmation line>"}
Each <action> is one of:
- {"type":"create","name":"<title>","frequency":"daily|weekly|monthly|once","weekdays":[0-6],"day_of_month":1-31,"end_date":"YYYY-MM-DD","status":"planned|in progress|completed|failed|cancelled","tags":["<existing tag name>", ...]}
- {"type":"update","id":"<task id from the data below>","name":"...", ...same fields as create...}
- {"type":"delete","id":"<task id from the data below>"}
Rules: only "name" (create) or "id" (update/delete) are required; frequency defaults
to daily. weekdays are 0=Sunday..6=Saturday and only apply to weekly. day_of_month
only applies to monthly. end_date only applies to once. Use task ids EXACTLY as shown
in the data below. Only reference tags that already exist. Never guess an id — if you
can't find the task the user means, ask them instead of emitting an action.
For anything that is NOT an explicit task change, reply normally as a coach (plain
text), never JSON.

USER'S TASK DATA:
${taskContext || 'No task data available.'}${memory ? `\n\nLONG-TERM MEMORY ABOUT THIS USER (learned from past chats — durable context, may be outdated; the task data above is authoritative for current stats):\n${memory}` : ''}`;

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
				messages: [
					{ role: 'system', content: systemPrompt },
					...messages
				],
				max_tokens: 1500,
				temperature: 0.7,
				// Optional strict JSON mode (e.g. auto-reschedule). Only allow the
				// json_object form so callers can't inject arbitrary request fields.
				...(responseFormat && responseFormat.type === 'json_object'
					? { response_format: { type: 'json_object' } }
					: {})
			})
		});

		if (!response.ok) {
			const errData = await response.json().catch(() => ({}));
			console.error('OpenAI error:', errData);
			return res.status(response.status).json({ error: errData.error?.message || 'OpenAI API error' });
		}

		const data = await response.json();
		const reply = data.choices?.[0]?.message?.content || 'No response from AI.';
		// Fold durable facts from this exchange into the user's long-term memory.
		if (isChat) {
			const lastUser = [...messages].reverse().find(m => m.role === 'user');
			await updateMemory(apiKey, user.id, memory, lastUser ? lastUser.content : '', reply);
		}
		return res.status(200).json({ reply });
	} catch (err) {
		console.error('AI handler error:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
}
