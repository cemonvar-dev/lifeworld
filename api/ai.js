// Fiblia AI endpoint — auth-gated + per-user daily quota.
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

// Request limits: keep one call's OpenAI cost bounded.
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;
const MAX_JSON_PROMPT_CHARS = 40000; // auto-reschedule embeds the event list
const MAX_TASK_CONTEXT_CHARS = 30000;
const LANGUAGE_NAMES = { en: 'English', de: 'German', fr: 'French', nl: 'Dutch', es: 'Spanish', it: 'Italian', tr: 'Turkish' };

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'once'];
const TASK_STATUSES = ['in progress', 'completed', 'cancelled'];
const MAX_ACTIONS = 20;

const TASK_CHANGES_TOOL = {
	type: 'function',
	function: {
		name: 'propose_task_changes',
		description: 'Propose creating, updating or deleting tasks. The user reviews the proposal before it is applied.',
		parameters: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'One short, friendly line introducing the proposed changes.' },
				actions: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							type: { type: 'string', enum: ['create', 'update', 'delete'] },
							id: { type: 'string', description: 'Existing task id. Required for update and delete.' },
							name: { type: 'string', description: 'Task title. Required for create.' },
							frequency: { type: 'string', enum: FREQUENCIES },
							weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Only for weekly tasks.' },
							day_of_month: { type: 'integer', minimum: 1, maximum: 31, description: 'Only for monthly tasks.' },
							end_date: { type: 'string', description: 'YYYY-MM-DD. Only for one-time tasks.' },
							status: { type: 'string', enum: TASK_STATUSES },
							tags: { type: 'array', items: { type: 'string' }, description: 'Names of existing tags.' }
						},
						required: ['type']
					}
				}
			},
			required: ['message', 'actions']
		}
	}
};

// Keep only well-formed proposals, whatever the model returned.
function sanitizeActions(actions) {
	if (!Array.isArray(actions)) return [];
	const clean = [];
	for (const raw of actions.slice(0, MAX_ACTIONS)) {
		if (!raw || !['create', 'update', 'delete'].includes(raw.type)) continue;
		const action = { type: raw.type };
		if (typeof raw.id === 'string' && raw.id) action.id = raw.id.slice(0, 64);
		if (raw.type !== 'delete') {
			if (typeof raw.name === 'string' && raw.name.trim()) action.name = raw.name.trim().slice(0, 200);
			if (FREQUENCIES.includes(raw.frequency)) action.frequency = raw.frequency;
			if (TASK_STATUSES.includes(raw.status)) action.status = raw.status;
			if (Array.isArray(raw.weekdays)) action.weekdays = [...new Set(raw.weekdays.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
			if (Number.isInteger(raw.day_of_month) && raw.day_of_month >= 1 && raw.day_of_month <= 31) action.day_of_month = raw.day_of_month;
			if (typeof raw.end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.end_date)) action.end_date = raw.end_date;
			if (Array.isArray(raw.tags)) action.tags = raw.tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)).slice(0, 20);
		}
		if (raw.type === 'create' && !action.name) continue;
		if (raw.type !== 'create' && !action.id) continue;
		clean.push(action);
	}
	return clean;
}

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

	// --- Validate the body before spending quota. Only user/assistant turns are
	// forwarded, so a caller can't supply its own system prompt. ---
	const body = req.body || {};
	const { responseFormat } = body;
	if (!Array.isArray(body.messages)) return res.status(400).json({ error: 'messages required' });
	const jsonMode = responseFormat?.type === 'json_object';
	const turns = body.messages
		.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
		.slice(-MAX_HISTORY_MESSAGES);
	if (!turns.length) return res.status(400).json({ error: 'messages required' });
	if (jsonMode && turns.some(m => m.content.length > MAX_JSON_PROMPT_CHARS)) {
		return res.status(400).json({ error: 'That request is too large. Please select fewer items and try again.', code: 'too_large' });
	}
	// Chat turns are trimmed rather than rejected: history is resent every time,
	// so rejecting one long message would fail every later message too.
	const messages = turns.map(m => ({ role: m.role, content: jsonMode ? m.content : m.content.slice(0, MAX_MESSAGE_CHARS) }));
	const taskContext = typeof body.taskContext === 'string' ? body.taskContext.slice(0, MAX_TASK_CONTEXT_CHARS) : '';

	// --- Quota gate: premium bypasses, everyone else gets a daily limit ---
	// Only app_metadata counts: users can edit their own user_metadata.
	const isPremium = !!user.app_metadata?.premium;
	if (!isPremium) {
		const quota = await consumeQuota(user.id, AI_DAILY_LIMIT);
		if (!quota) {
			return res.status(500).json({ error: 'Could not verify your usage quota. Please try again.' });
		}
		if (!quota.allowed) {
			res.setHeader('X-AI-Quota-Limit', String(quota.day_limit));
			res.setHeader('X-AI-Quota-Used', String(quota.used));
			return res.status(429).json({
				error: `You've reached your free limit of ${quota.day_limit} AI messages today. Upgrade to Fiblia Premium for unlimited coaching.`,
				code: 'quota_exceeded',
				limit: quota.day_limit,
				used: quota.used
			});
		}
	}

	// Long-term memory only applies to normal chat (not the reschedule JSON call).
	const isChat = !(responseFormat && responseFormat.type === 'json_object');
	const memory = isChat ? await getMemory(user.id) : '';

	const systemPrompt = `You are Fiblia AI — a personal life coach and productivity assistant. You have access to the user's task/habit tracking data below. Use it to give specific, actionable advice.

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
or remove task(s), call the propose_task_changes tool. The user reviews your proposal
before anything is applied, so never say a change has already been made.
Use task ids EXACTLY as shown in the data below. Never guess an id: if you can't find
the task the user means, ask them instead. Only reference tags that already exist.
Weekdays are 0=Sunday..6=Saturday. For anything that is NOT an explicit task change,
reply normally as a coach in plain text.

LANGUAGE
The app is set to ${LANGUAGE_NAMES[body.language] || 'English'}. Always write all user-facing text in that language, including "message" and "reason" values, even when the user writes or speaks in another language. Only use a different language if the user explicitly asks you to. Keep JSON keys and enum values in English.

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
				// Auto-reschedule uses strict JSON; chat can propose task changes.
				...(jsonMode
					? { response_format: { type: 'json_object' } }
					: { tools: [TASK_CHANGES_TOOL], tool_choice: 'auto' })
			})
		});

		if (!response.ok) {
			const errData = await response.json().catch(() => ({}));
			console.error('OpenAI error:', response.status, errData);
			// Never forward OpenAI's status: its 429 would look like the user's own quota.
			return res.status(502).json({ error: 'The AI assistant is temporarily unavailable. Please try again shortly.', code: 'ai_unavailable' });
		}

		const data = await response.json();
		const toolCall = data.choices?.[0]?.message?.tool_calls?.find(call => call.function?.name === 'propose_task_changes');
		if (toolCall) {
			let args = {};
			try { args = JSON.parse(toolCall.function.arguments); } catch { /* treated as no valid actions */ }
			return res.status(200).json({
				reply: typeof args.message === 'string' ? args.message.slice(0, 500) : '',
				actions: sanitizeActions(args.actions)
			});
		}
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
