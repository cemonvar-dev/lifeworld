// Fiblia AI endpoint — auth-gated + per-user daily quota.
//
// Required env vars (set in Vercel project settings, NEVER in client code):
//   OPENAI_API_KEY            - OpenAI secret key
//   SUPABASE_URL              - e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY         - public anon key (used to validate the user's JWT)
//   SUPABASE_SERVICE_ROLE_KEY - service role key (server-only; bypasses RLS for quota)
// Optional:
//   AI_DAILY_LIMIT            - free-tier messages per user per day (default 25)
//   AI_IDEAS_DAILY_LIMIT      - web-researched ideas for new tasks per user per day (default 10, x4 premium)
//   ALLOWED_ORIGIN            - exact origin to allow via CORS (default "*")
//
// One-time DB setup: run scripts/ai-quota.sql in the Supabase SQL editor.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://baswgycuhblyppvvdpay.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AI_DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '25', 10);
// Opening greetings don't count against the user's message quota, but get their
// own small daily cap (tracked in ai_usage under a derived id) so they can't be abused.
const GREETING_DAILY_LIMIT = 8;
// Coaching (chat + greeting) uses a stronger model; falls back if it's unavailable.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini';
const FALLBACK_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// POST to OpenAI; if the preferred model fails for any reason other than a bad
// API key (not allowed for this project, retired, rate-limited, down), retry once on the fallback.
async function openaiChat(apiKey, payload) {
	const send = model => fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
		body: JSON.stringify({ ...payload, model })
	});
	let response = await send(payload.model);
	if (!response.ok && response.status !== 401 && payload.model !== FALLBACK_MODEL) {
		console.error('Model rejected, falling back:', payload.model, response.status);
		response = await send(FALLBACK_MODEL);
	}
	return response;
}
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

// Saving an agreed plan lets the coach follow up on it in later chats.
const SAVE_PLAN_TOOL = {
	type: 'function',
	function: {
		name: 'save_plan',
		description: 'Save the plan the user just agreed to (or cancel the active one) so you can follow up on it in later chats. Only call this after the user clearly agrees.',
		parameters: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'One short, warm line confirming the plan is saved.' },
				title: { type: 'string', description: 'Short plan name, e.g. "3-month reset".' },
				summary: { type: 'string', description: 'Compact plan: each phase with its dates and its measurable targets on real tasks. Under 1200 characters.' },
				start_date: { type: 'string', description: 'YYYY-MM-DD' },
				end_date: { type: 'string', description: 'YYYY-MM-DD' },
				cancel: { type: 'boolean', description: 'True to cancel the active plan instead of saving one.' }
			},
			required: ['message']
		}
	}
};

function sanitizePlan(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (raw.cancel === true) return { cancel: true };
	const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
	const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
	const plan = { title: str(raw.title, 120), summary: str(raw.summary, 2000), start_date: date(raw.start_date), end_date: date(raw.end_date) };
	return plan.summary ? plan : null;
}

// Plans deserve the strongest model; everything else stays on the chat model.
const PLAN_MODEL = process.env.OPENAI_PLAN_MODEL || 'gpt-4.1';
const isPlanRequest = text => /\b(plan\w*|program\w*|roadmap|schedule me|hedef\w*|goal\w*|yol haritas\w*)\b|\b\d+\s*(-\s*)?(ay|aylık|month|months|hafta|haftalık|week|weeks)\b/i.test(String(text || ''));

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

// A stable, separate ai_usage key for a user's greetings (uuid-shaped hash).
async function greetingQuotaId(userId) {
	const { createHash } = await import('node:crypto');
	const h = createHash('sha256').update('greeting:' + userId).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The coach opens the chat: a short, warm line based on what happened today.
async function handleGreeting(req, res, apiKey, user, body) {
	const taskContext = typeof body.taskContext === 'string' ? body.taskContext.slice(0, MAX_TASK_CONTEXT_CHARS) : '';
	const localTime = typeof body.localTime === 'string' && /^\d{1,2}:\d{2}$/.test(body.localTime) ? body.localTime : '';
	const quota = await consumeQuota(await greetingQuotaId(user.id), GREETING_DAILY_LIMIT);
	if (!quota) return res.status(500).json({ error: 'Could not verify your usage quota. Please try again.' });
	if (!quota.allowed) return res.status(429).json({ error: 'Greeting limit reached', code: 'greeting_limit' });
	const memory = await getMemory(user.id);
	const firstName = String(user.user_metadata?.full_name || user.user_metadata?.name || '').trim().split(/\s+/)[0].slice(0, 30);
	const system = `You are Fiblia, the user's personal coach. They just opened the chat with you. Write the first message, as if you were texting someone you coach and genuinely care about.

WHAT TO SAY
- First check USAGE. If they have been away for days, that comes first: welcome them back warmly and honestly, without guilt ("It's been a few weeks..."), and suggest one gentle way back in. Skip the rest below in that case.
- Otherwise, look at TODAY in the data: what is already done or skipped today, and which tasks are still open for today. Consider the local time${localTime ? ` (${localTime})` : ''}.
- If they already did something today: notice it, naming one real task, and let it land warmly and simply. Then ask, gently, what they'd like to do next.
- If nothing is done yet: be inviting, never guilt. Suggest starting with one specific, easy task that is open today, and ask how they feel about it.
- If everything for today is done: be calmly proud of them, and invite them to rest, reflect, or think about tomorrow.
- Late evening: be softer; it's fine to suggest one tiny thing or simply winding down.
- If the data has an ACTIVE PLAN, weave in a short check-in on it: which week of the plan they are in and how one of its targets is going.
- Encourage only with real facts from their history (a strong month, a past streak), never empty praise.

HOW TO SOUND
- 2 or 3 short sentences, under 45 words in total. Natural, intimate and warm, like a real coach who knows them. Plain, everyday words.
- End with one soft, open question.
- Never mention health scores, percentages, labels like "dying" or "thriving", or "the data". No lists, no headings, no generic motivation or clichés, no exclamation-mark overload. At most one emoji, only if it feels natural.
- Do not introduce yourself.${firstName ? ` You may use their first name, "${firstName}", once at most, and only if it feels natural.` : ''}

LANGUAGE
The app is set to ${LANGUAGE_NAMES[body.language] || 'English'}. Write only in that language, in a natural, native tone (informal "you" where that language has one).

USER'S TASK DATA:
${taskContext || 'No task data available.'}${memory ? `\n\nWHAT YOU REMEMBER ABOUT THEM (may be outdated):\n${memory}` : ''}`;
	try {
		const response = await openaiChat(apiKey, {
			model: CHAT_MODEL,
			messages: [{ role: 'system', content: system }, { role: 'user', content: '(The user opened the coach chat.)' }],
			max_tokens: 160,
			temperature: 0.85
		});
		if (!response.ok) {
			console.error('Greeting OpenAI error:', response.status, await response.text().catch(() => ''));
			return res.status(502).json({ error: 'The AI assistant is temporarily unavailable. Please try again shortly.', code: 'ai_unavailable', upstream: response.status });
		}
		const data = await response.json();
		const reply = String(data.choices?.[0]?.message?.content || '').trim().slice(0, 600);
		if (!reply) return res.status(502).json({ error: 'No response', code: 'ai_unavailable' });
		return res.status(200).json({ reply });
	} catch (err) {
		console.error('Greeting error:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
}

// ---- Ideas for a new task (mode: 'ideas') ----
// When the user adds a task, a cheap model first decides whether outside research
// would help (booking a venue, finding a course, planning a trip...). Only then
// does a web-search model look things up and return a few concrete options.
// Habits like "drink water" or "call mom" get nothing and cost no quota.
const IDEAS_DAILY_LIMIT = parseInt(process.env.AI_IDEAS_DAILY_LIMIT || '10', 10);
const IDEAS_MODEL = process.env.OPENAI_IDEAS_MODEL || 'gpt-4.1-mini';

// A stable, separate ai_usage key per feature (uuid-shaped hash), so each has its own daily cap.
async function featureQuotaId(feature, userId) {
	const { createHash } = await import('node:crypto');
	const h = createHash('sha256').update(feature + ':' + userId).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const ideasQuotaId = userId => featureQuotaId('ideas', userId);

// Where the user is, for local results: memory may know the city; otherwise the
// timezone's city is a fair guess (Europe/Istanbul -> Istanbul).
function userPlace(memory, timezone) {
	const memCity = (String(memory || '').match(/\b(?:[Ll]ives in|[Bb]ased in|[Cc]ity:?)\s+([A-ZÇĞİÖŞÜ][\p{L}', -]{1,50}?)(?=[.;\n(]|$)/mu) || [])[1];
	return (memCity || (String(timezone || '').split('/').pop() || '').replace(/_/g, ' ')).trim().slice(0, 60);
}

// Validated location fields shared by the web-search modes.
function locationFields(body) {
	return {
		timezone: typeof body.timezone === 'string' && /^[A-Za-z_\/+-]{1,64}$/.test(body.timezone) ? body.timezone : '',
		country: typeof body.country === 'string' && /^[A-Z]{2}$/.test(body.country) ? body.country : '',
		today: typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10)
	};
}

// One Responses API call with web search; returns the JSON object the model wrote, or null.
async function webSearchJson(apiKey, instructions, { place, timezone, country }, { contextSize = 'low', maxTokens = 900 } = {}) {
	const location = { type: 'approximate' };
	if (timezone) location.timezone = timezone;
	if (country) location.country = country;
	if (place) location.city = place;
	const send = toolType => fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: IDEAS_MODEL,
			tools: [{ type: toolType, search_context_size: contextSize, user_location: location }],
			input: instructions,
			max_output_tokens: maxTokens
		})
	});
	let resp = await send('web_search');
	if (!resp.ok && resp.status !== 401) {
		console.error('web_search rejected, trying preview tool:', resp.status, await resp.text().catch(() => ''));
		resp = await send('web_search_preview');
	}
	if (!resp.ok) {
		console.error('Web search error:', resp.status, await resp.text().catch(() => ''));
		return null;
	}
	const data = await resp.json();
	const message = (data.output || []).filter(o => o.type === 'message').pop();
	const part = (message?.content || []).find(c => c.type === 'output_text');
	const text = part?.text || data.output_text || '';
	const out = parseJsonObject(text);
	if (!out) console.error('Web search reply was not JSON:', data.status, data.incomplete_details?.reason || '', String(text).slice(0, 400));
	return out;
}

// Pull the first JSON object out of a model's text (it may wrap it in prose or fences).
function parseJsonObject(text) {
	const s = String(text || '');
	const start = s.indexOf('{'), end = s.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// Step 1: does this task benefit from a web search? Returns { research, query } or null.
async function ideasGate(apiKey, name, tags, place) {
	const system = `You triage tasks in a personal to-do / habit app. Decide whether a quick web search would give the user genuinely useful, concrete options for THIS task.
Say yes (research=true) only when the task involves finding or choosing something out in the world: a place or venue to book (a pitch, court, restaurant, hall), a course, class, club or workshop, a trip or day out, an event, a gift or product to buy, a service or professional to hire, tickets, or organising an activity with others.
Say no for routines and habits (exercise sets, drinking water, prayer, medicine, reading, studying, journaling), simple personal actions (call someone, pay a bill, clean the house, reply to an email), work items, and anything too vague or private to search usefully.
If yes, write a short search query in the task's language that would find concrete options${place ? ` near ${place}` : ''}.
Reply with JSON only: {"research": true|false, "query": "..."}`;
	const resp = await openaiChat(apiKey, {
		model: FALLBACK_MODEL,
		messages: [{ role: 'system', content: system }, { role: 'user', content: `Task: ${name}${tags ? `\nTags: ${tags}` : ''}` }],
		max_tokens: 80,
		temperature: 0,
		response_format: { type: 'json_object' }
	});
	if (!resp.ok) return null;
	const data = await resp.json();
	const out = parseJsonObject(data.choices?.[0]?.message?.content);
	if (!out || out.research !== true) return { research: false };
	return { research: true, query: String(out.query || name).slice(0, 200) };
}

// Web-search citations carry a tracking parameter; keep only clean http(s) links.
function cleanUrl(u) {
	if (typeof u !== 'string') return '';
	try {
		const p = new URL(u.trim());
		if (p.protocol !== 'https:' && p.protocol !== 'http:') return '';
		p.searchParams.delete('utm_source');
		return p.href.slice(0, 500);
	} catch { return ''; }
}

// Step 2: search the web and turn results into a few options.
async function ideasSearch(apiKey, { name, tags, query, place, timezone, country, language, today, manual }) {
	const lang = LANGUAGE_NAMES[language] || 'English';
	// Asked from the card: any task (work, study, chores, personal), so look for whatever
	// helps get it done, not only local venues.
	const instructions = manual ? `The user asked for help with this task from their personal planner: "${name}"${tags ? ` (tags: ${tags})` : ''}.
First work out what the task is really about (it may be a work item, a study topic, a chore, a purchase, an outing or a personal goal), then search the web with your own query for resources that help get it done: how-to guides, official docs, tools or apps, templates or checklists, services, products, or places${place ? ` in or near ${place}` : ''} when the task is about going somewhere. Today is ${today}.
Give 3 or 4 concrete ideas, each with its real URL from the results. Never invent names, prices, addresses or URLs. If the name is too vague or private to search, give general practical ideas for that kind of task anyway (url may then be "").
Write in ${lang}, in a natural, friendly tone. Each idea: a short title (max 8 words) and one helpful sentence (max 25 words) saying why it fits or what to do.
Add one short "tip" (max 20 words) with a practical next step.
Reply with JSON only, no prose and no markdown: {"ideas":[{"title":"...","detail":"...","url":"https://..."}],"tip":"..."}` : `The user just added this task to their personal planner: "${name}"${tags ? ` (tags: ${tags})` : ''}.
Search the web (suggested query: "${query}") and give them 3 or 4 concrete, practical ideas that help them get it done: specific places, venues, booking sites, apps, courses or options, ideally${place ? ` in or near ${place}` : ' near where they live'}. Today is ${today}.
Prefer options you actually found in the search results, each with its real URL. Never invent names, prices, addresses or URLs. If you mention a price or opening time, it must come from the results.
Write in ${lang}, in a natural, friendly tone. Each idea: a short title (max 8 words) and one helpful sentence (max 25 words) saying why it fits or what to do.
Add one short "tip" (max 20 words) with a practical next step (e.g. "Book 2-3 days ahead for evening slots").
Reply with JSON only, no prose and no markdown: {"ideas":[{"title":"...","detail":"...","url":"https://..."}],"tip":"..."}`;
	const out = await webSearchJson(apiKey, instructions, { place, timezone, country }, { contextSize: manual ? 'medium' : 'low', maxTokens: 1500 });
	if (!out || !Array.isArray(out.ideas)) return { ideas: [], failed: true };
	const ideas = out.ideas.slice(0, 4).map(i => ({
		title: String(i?.title || '').trim().slice(0, 80),
		detail: String(i?.detail || '').trim().slice(0, 240),
		url: cleanUrl(i?.url)
	})).filter(i => i.title);
	if (!ideas.length) return null;
	return { ideas, tip: String(out.tip || '').trim().slice(0, 200) };
}

async function handleIdeas(req, res, apiKey, user, body) {
	const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
	if (!name) return res.status(400).json({ error: 'name required' });
	const tags = typeof body.tags === 'string' ? body.tags.slice(0, 300) : '';
	const { timezone, country, today } = locationFields(body);
	const place = userPlace(await getMemory(user.id), timezone);
	try {
		// The user asked from the task card: always search. Otherwise only when it would help.
		const gate = body.manual === true
			? { research: true, query: name }
			: await ideasGate(apiKey, name, tags, place);
		if (!gate || !gate.research) return res.status(200).json({ ideas: [] });
		// Quota is only spent on tasks that actually get researched.
		const isPremium = !!user.app_metadata?.premium;
		const quota = await consumeQuota(await ideasQuotaId(user.id), isPremium ? IDEAS_DAILY_LIMIT * 4 : IDEAS_DAILY_LIMIT);
		if (!quota) return res.status(500).json({ error: 'Could not verify your usage quota.' });
		if (!quota.allowed) return res.status(429).json({ error: 'Ideas limit reached', code: 'ideas_limit' });
		const result = await ideasSearch(apiKey, { name, tags, query: gate.query, place, timezone, country, language: body.language, today, manual: body.manual === true });
		return res.status(200).json(result || { ideas: [] });
	} catch (err) {
		console.error('Ideas error:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
}

// ---- Weekly picks from the user's interests (mode: 'picks') ----
// The app asks about once a week; one web search covers all interests and
// returns a handful of concrete, dated things to do in the coming days.
const PICKS_DAILY_LIMIT = parseInt(process.env.AI_PICKS_DAILY_LIMIT || '2', 10);
const MAX_INTERESTS = 15;

// [{label, detail}] from whatever the client or the model sent.
function sanitizeInterests(list, max = MAX_INTERESTS) {
	if (!Array.isArray(list)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of list) {
		const label = String((raw && (raw.label || raw)) || '').trim().slice(0, 40);
		if (!label || typeof label !== 'string' || seen.has(label.toLowerCase())) continue;
		seen.add(label.toLowerCase());
		out.push({ label, detail: String((raw && raw.detail) || '').trim().slice(0, 120) });
		if (out.length >= max) break;
	}
	return out;
}

async function handlePicks(req, res, apiKey, user, body) {
	const interests = sanitizeInterests(body.interests);
	if (!interests.length) return res.status(400).json({ error: 'interests required' });
	const dislikes = (Array.isArray(body.dislikes) ? body.dislikes : []).filter(d => typeof d === 'string').map(d => d.trim().slice(0, 80)).filter(Boolean).slice(-20);
	const { timezone, country, today } = locationFields(body);
	const memory = await getMemory(user.id);
	const place = userPlace(memory, timezone);
	const isPremium = !!user.app_metadata?.premium;
	const quota = await consumeQuota(await featureQuotaId('picks', user.id), isPremium ? PICKS_DAILY_LIMIT * 3 : PICKS_DAILY_LIMIT);
	if (!quota) return res.status(500).json({ error: 'Could not verify your usage quota.' });
	if (!quota.allowed) return res.status(429).json({ error: 'You already got fresh picks today. Try again tomorrow.', code: 'picks_limit' });
	const lang = LANGUAGE_NAMES[body.language] || 'English';
	const weekday = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
	const instructions = `You find personal "picks" for a user of a life-planning app: concrete things they could do in the next 10 days, based on what they enjoy.
Today is ${weekday} ${today}. They live${place ? ` in or near ${place}` : ' near the location given'}.
THEIR INTERESTS:
${interests.map(i => `- ${i.label}${i.detail ? ` (${i.detail})` : ''}`).join('\n')}
${dislikes.length ? `NOT FOR THEM (avoid similar): ${dislikes.join('; ')}\n` : ''}${memory ? `WHAT THE COACH KNOWS ABOUT THEM (may be outdated):\n${memory.slice(0, 800)}\n` : ''}
Search the web for what is actually on or available soon: films showing in cinemas this week, concerts and events with dates, exhibitions, matches, courses starting soon, a good day trip or weekend getaway for the season, a new restaurant, and so on. Cover different interests; at most 2 picks per interest.
Give 5 or 6 picks. Prefer real, dated, local things you found in the results, each with its real URL. Never invent names, dates, prices or URLs; if you are unsure of a date, leave "date" empty and describe it in "when".
Write in ${lang}, warm and brief, like a friend who knows their taste.
Each pick: "interest" (exactly one of their interest labels), "title" (max 8 words), "detail" (one sentence, max 25 words: what it is and why it suits them), "when" (short, e.g. "Sat 21 Nov, 20:00" or "Any weekend"), "date" (YYYY-MM-DD of the best day to do it, or ""), "url", and "task" (a short to-do title to add to their planner, e.g. "Get tickets for Dune 3").
Reply with JSON only, no prose and no markdown: {"picks":[{"interest":"...","title":"...","detail":"...","when":"...","date":"","url":"https://...","task":"..."}]}`;
	try {
		const out = await webSearchJson(apiKey, instructions, { place, timezone, country }, { contextSize: 'medium', maxTokens: 2000 });
		const labels = new Map(interests.map(i => [i.label.toLowerCase(), i.label]));
		const picks = (out && Array.isArray(out.picks) ? out.picks : []).slice(0, 8).map(p => ({
			interest: labels.get(String(p?.interest || '').toLowerCase()) || '',
			title: String(p?.title || '').trim().slice(0, 80),
			detail: String(p?.detail || '').trim().slice(0, 240),
			when: String(p?.when || '').trim().slice(0, 60),
			date: typeof p?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date >= today ? p.date : '',
			url: cleanUrl(p?.url),
			task: String(p?.task || p?.title || '').trim().slice(0, 120)
		})).filter(p => p.title);
		return res.status(200).json({ picks });
	} catch (err) {
		console.error('Picks error:', err);
		return res.status(500).json({ error: 'Internal server error' });
	}
}

// The coach saves what the user enjoys, so weekly picks can follow their taste.
const SAVE_INTERESTS_TOOL = {
	type: 'function',
	function: {
		name: 'save_interests',
		description: 'Add, refine or remove the user\'s interests (things they enjoy doing in their free time). Used to find weekly picks for them. Call it when the user clearly says they enjoy (or no longer enjoy) something, or agrees to save it.',
		parameters: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'One short, warm line confirming what you saved.' },
				add: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							label: { type: 'string', description: 'Short interest name in the user\'s language, e.g. "Cinema". Reuse an existing label to refine it.' },
							detail: { type: 'string', description: 'Their taste within it, e.g. "sci-fi, original language".' }
						},
						required: ['label']
					}
				},
				remove: { type: 'array', items: { type: 'string' }, description: 'Labels of existing interests to drop.' }
			},
			required: ['message']
		}
	}
};

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
	if (body.mode === 'greeting') return handleGreeting(req, res, apiKey, user, body);
	if (body.mode === 'ideas') return handleIdeas(req, res, apiKey, user, body);
	if (body.mode === 'picks') return handlePicks(req, res, apiKey, user, body);
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
	const lastUserText = (messages.filter(m => m.role === 'user').pop() || {}).content || '';
	const planRequest = isChat && isPlanRequest(lastUserText);
	const memory = isChat ? await getMemory(user.id) : '';

	const systemPrompt = `You are Fiblia, the user's personal coach.

HOW YOU SEE THEM
The user's tiles are a map of their mind: what they care about, what they promised themselves, and how their days really go. Read it the way a chess master reads a board. Before answering, take in the whole position: are they present or have they drifted away (see USAGE), which areas are collapsing and which are holding, what matters most for their life, and which single move would change the game. Weigh areas by what matters in a life: health, body and wellbeing first; then family and the people they love; then work and projects; then hobbies and nice-to-haves. The user can override this order.

HOW YOU SPEAK
- Open with your honest read of the overall position, in one or two sentences of your own words, like someone who knows them well. If USAGE shows they have been away, notice that first, warmly and without guilt.
- Then give your priorities in order and say why that order: "First ... because ... After that ...". Name real tiles, real dates and real gaps ("you haven't touched it since July").
- Finish with one concrete first move and offer to set it up, or ask one sharp question.
- Fit the move to what the task is. Think before suggesting: taking a pill or medicine is a moment, not a session, so tie it to a cue or reminder ("keep it next to your coffee cup", "a reminder at breakfast"). A prayer or ritual happens at its own time. A call or message is one small action. Study, practice, exercise or a project can get a time block ("20 minutes after dinner"). Never give a task a duration that makes no sense for it.
- Sound like a human coach talking: short flowing paragraphs. Never numbered or bulleted lists, never bold headings, unless the user asks for a list or a plan (see PLANS).
- No filler such as "Your data highlights", "Here are some areas", "Focusing on this could help improve your overall well-being". No generic tips and no motivational closing lines.
- Translate internal labels into human language: never write "dying", "thriving", "wilting", health percentages, ids, or "the data".
- Direct, a little bold, warm, never preachy or guilt-inducing. Keep broad answers under about 150 words. Emojis rarely.

ENCOURAGEMENT
- Encourage like a coach who has watched their whole journey, never with empty praise. Look back: use each task's history (totals, best month, longest streak, how often they kept a schedule) to remind them what they have already proven they can do. Be honest about where they stand now. Then point forward to what is realistically within reach, using their own best as the proof ("You did 14 days in a row in September. Two good weeks and you're back there.").
- Every compliment and every "you can do this" must be tied to a real fact from their history. If something has never been done, encourage the first step instead of inventing a past.

PLANS
When the user asks for a plan (a week, a month, three months...):
- Open with two or three sentences: what their history proves they can do, where they stand now, and what this plan will get them to.
- Then lay out the plan in phases with short plain headings that carry real dates, e.g. "Month 1 · Foundation (12 Nov – 12 Dec)". Under each heading, two or three short lines. Each line is a real task by name, with a measurable target and when it happens ("namaz-akşam: 5 of 7 evenings, right after dinner"). Later phases build on earlier ones; keep the first phase light enough to succeed.
- Add one line for the weekly rhythm (which days, which moments).
- Respect real dates and the season. If a key date is unknown (an exam, a deadline), ask instead of inventing it.
- Use tasks from the board. Anything new must be clearly marked as a new idea and fit their tags.
- Close with what the end of the plan looks like if they follow it, the thing they will be proud of, and ask whether to save the plan and add its milestones as tasks.
- When they agree, call save_plan with a compact summary of the phases, dates and targets, and in the same reply call propose_task_changes to create the dated one-time milestone tasks (and any schedule changes the plan needs).
- If the data contains an ACTIVE PLAN, that is the plan you agreed together: refer to it, measure progress against its targets, praise what is on track with facts, and adjust it when they ask. Call save_plan with cancel=true only if they clearly want to drop it.

FRESH IDEAS (beyond the board)
- You are not limited to the tiles. When an area is thin, stale, or the user asks what to do, you may suggest one fresh idea that isn't on the board yet and fits that area and this person: for family, a weekend day trip or a shared activity with the specific people in their tags; for hobbies, a beginner course, a workshop or a club for that exact hobby in their city; for health, an activity that suits what they already try to do.
- Use what you know: their tags and tasks, the date and season, and their location (the city from memory, otherwise a guess from the timezone; say "in Istanbul" only if you're fairly sure). Suggest kinds of things ("a weekend ceramics workshop", "a day trip to a nearby town by the sea"), never specific venues, prices, dates or events you can't verify, and suggest where to look if useful.
- One idea at a time, woven naturally into your answer, then offer to add it as a task. If they say yes, use propose_task_changes to create it (a one-time task, tagged with the matching existing tag).

INTERESTS AND PICKS
- The data may list INTERESTS (what they enjoy in their free time) and THIS WEEK'S PICKS (concrete things found on the web for them). Use them: when free time, the weekend, family time, rest or low mood comes up, suggest one fitting pick by name and offer to add it as a dated task (propose_task_changes, frequency once, end_date = the pick's date).
- Learn their taste. When they mention enjoying something (a film genre, hiking, jazz, cooking), or not enjoying it, save it with save_interests. If the list is empty and the talk turns to free time, ask one light question about what they enjoy and offer to remember it.
- Interests are saved right away (no review needed); confirm in one short line. Weekly picks then follow them automatically.

ACCURACY
- Understand what each task really is from its name and its full tag path. Tags are nested with "›": "family › hilal" means something for or with Hilal, a person in their family; "work › r&d" is a work project. Describe tasks by what they are ("helping Hilal with her LGS practice tests"), never just by their bucket ("family tasks").
- Tell apart never started, abandoned (a long gap), deliberately skipped, inconsistent, and declining. Never say something is skipped unless the facts show skips.
- State only what the facts show. If you infer a cause or a link between tasks, say it's a guess and ask.
- If a schedule has clearly failed, suggest a lighter one rather than "try harder".
- Do not advise starting, stopping, or changing medication or treatment (helping them remember a medicine they already take is fine). For pain or health concerns, suggest speaking to a professional.

Answer direct questions directly, and go deeper when the user asks for detail. You can also propose task changes when they clearly ask you to.

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
		const response = await openaiChat(apiKey, {
				model: jsonMode ? FALLBACK_MODEL : (planRequest ? PLAN_MODEL : CHAT_MODEL),
				messages: [
					{ role: 'system', content: systemPrompt },
					...messages
				],
				max_tokens: 1500,
				temperature: jsonMode ? 0.5 : 0.7,
				// Auto-reschedule uses strict JSON; chat can propose task changes.
				...(jsonMode
					? { response_format: { type: 'json_object' } }
					: { tools: [TASK_CHANGES_TOOL, SAVE_PLAN_TOOL, SAVE_INTERESTS_TOOL], tool_choice: 'auto' })
		});

		if (!response.ok) {
			const errData = await response.json().catch(() => ({}));
			console.error('OpenAI error:', response.status, errData);
			// Never forward OpenAI's status: its 429 would look like the user's own quota.
			return res.status(502).json({ error: 'The AI assistant is temporarily unavailable. Please try again shortly.', code: 'ai_unavailable', upstream: response.status });
		}

		const data = await response.json();
		const toolCalls = data.choices?.[0]?.message?.tool_calls || [];
		if (toolCalls.length) {
			let reply = '', actions = [], plan = null, interests = null;
			for (const call of toolCalls) {
				let args = {};
				try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* treated as nothing valid */ }
				const msg = typeof args.message === 'string' ? args.message.slice(0, 500) : '';
				if (call.function?.name === 'propose_task_changes') { actions = actions.concat(sanitizeActions(args.actions)); reply = reply || msg; }
				else if (call.function?.name === 'save_plan') { plan = sanitizePlan(args) || plan; reply = reply || msg; }
				else if (call.function?.name === 'save_interests') {
					const add = sanitizeInterests(args.add), remove = (Array.isArray(args.remove) ? args.remove : []).filter(x => typeof x === 'string').map(x => x.slice(0, 40)).slice(0, MAX_INTERESTS);
					if (add.length || remove.length) interests = { add, remove };
					reply = reply || msg;
				}
			}
			const content = data.choices?.[0]?.message?.content;
			if (typeof content === 'string' && content.trim()) reply = content.slice(0, 6000) + (reply ? '\n\n' + reply : '');
			return res.status(200).json({ reply, actions: actions.slice(0, MAX_ACTIONS), ...(plan ? { plan } : {}), ...(interests ? { interests } : {}) });
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
