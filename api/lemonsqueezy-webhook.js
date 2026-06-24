// Lemon Squeezy webhook — flips Supabase app_metadata.premium on subscription changes.
//
// Required env vars (Vercel, server-only):
//   LEMONSQUEEZY_WEBHOOK_SECRET - the signing secret set on the LS webhook
//   SUPABASE_URL                - https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (admin API + customer mapping)
//
// One-time DB setup: run scripts/billing-premium.sql in the Supabase SQL editor.
//
// Checkout setup (how a user's id reaches this webhook):
//   Use a Lemon Squeezy hosted checkout URL and pass the Supabase user id as
//   custom data, e.g.
//     https://STORE.lemonsqueezy.com/checkout/buy/VARIANT_ID?checkout[custom][user_id]=<uid>
//   LS returns it as meta.custom_data.user_id on the subscription webhooks. We
//   also remember the LS customer_id so later events still resolve to the user.

import crypto from 'crypto';

// Lemon Squeezy signs the raw request body; disable Vercel's body parser.
export const config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LEMONSQUEEZY_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

// Subscription statuses that should grant premium access.
// "cancelled" still has access until the period ends, when LS sends an
// `expired` status — so we keep premium ON for cancelled and OFF for expired.
const ACTIVE_STATUSES = new Set(['active', 'on_trial', 'past_due', 'cancelled']);

async function readRawBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks);
}

// Verify the X-Signature header (hex HMAC-SHA256 of the raw body).
function verifySignature(rawBody, sigHeader, secret) {
	if (!sigHeader) return false;
	const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
	const a = Buffer.from(expected);
	const b = Buffer.from(sigHeader);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Set app_metadata.premium for a Supabase user via the admin API.
async function setPremium(userId, premium) {
	if (!userId) return false;
	const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
		},
		body: JSON.stringify({ app_metadata: { premium } })
	});
	return resp.ok;
}

// Remember which Supabase user owns a Lemon Squeezy customer.
async function saveCustomerMapping(userId, customerId) {
	if (!userId || !customerId) return;
	await fetch(`${SUPABASE_URL}/rest/v1/billing_customers`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			Prefer: 'resolution=merge-duplicates'
		},
		body: JSON.stringify({ user_id: userId, customer_id: String(customerId) })
	});
}

async function userIdForCustomer(customerId) {
	if (!customerId) return null;
	const resp = await fetch(
		`${SUPABASE_URL}/rest/v1/billing_customers?customer_id=eq.${encodeURIComponent(String(customerId))}&select=user_id`,
		{
			headers: {
				apikey: SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
			}
		}
	);
	if (!resp.ok) return null;
	const rows = await resp.json();
	return rows?.[0]?.user_id || null;
}

export default async function handler(req, res) {
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
	if (!LEMONSQUEEZY_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
		console.error('Lemon Squeezy webhook env not configured');
		return res.status(500).json({ error: 'Server not configured' });
	}

	const rawBody = await readRawBody(req);
	if (!verifySignature(rawBody, req.headers['x-signature'], LEMONSQUEEZY_WEBHOOK_SECRET)) {
		return res.status(400).json({ error: 'Invalid signature' });
	}

	let event;
	try {
		event = JSON.parse(rawBody.toString('utf8'));
	} catch {
		return res.status(400).json({ error: 'Invalid payload' });
	}

	try {
		const eventName = event.meta?.event_name || '';
		// We only care about subscription lifecycle events.
		if (eventName.startsWith('subscription_')) {
			const attrs = event.data?.attributes || {};
			const customerId = attrs.customer_id;
			const userId = event.meta?.custom_data?.user_id || (await userIdForCustomer(customerId));

			if (userId && customerId) await saveCustomerMapping(userId, customerId);

			const premium = ACTIVE_STATUSES.has(attrs.status);
			await setPremium(userId, premium);
		}
	} catch (err) {
		console.error('Lemon Squeezy webhook handler error:', err);
		return res.status(500).json({ error: 'Handler error' });
	}

	return res.status(200).json({ received: true });
}
