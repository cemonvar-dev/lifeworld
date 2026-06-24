// Stripe webhook — flips Supabase app_metadata.premium on subscription changes.
//
// Required env vars (Vercel, server-only):
//   STRIPE_WEBHOOK_SECRET     - the signing secret from the Stripe webhook endpoint (whsec_...)
//   SUPABASE_URL              - https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY - service role key (admin API + customer mapping)
//
// One-time DB setup: run scripts/stripe-premium.sql in the Supabase SQL editor.
//
// Checkout setup (how a user's id reaches this webhook):
//   Create a Stripe Payment Link / Checkout Session and set
//   `client_reference_id` to the Supabase user id. On checkout.session.completed
//   we read it, mark the user premium, and remember their Stripe customer id so
//   later subscription.updated / .deleted events can resolve back to the user.

import crypto from 'crypto';

// Stripe needs the raw request body to verify the signature.
export const config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function readRawBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks);
}

// Verify Stripe's signature header without the stripe SDK.
function verifyStripeSignature(rawBody, sigHeader, secret) {
	if (!sigHeader) return false;
	const parts = Object.fromEntries(
		sigHeader.split(',').map(kv => kv.split('=').map(s => s.trim()))
	);
	const timestamp = parts.t;
	const signature = parts.v1;
	if (!timestamp || !signature) return false;

	// Reject events older than 5 minutes (replay protection).
	const age = Math.floor(Date.now() / 1000) - Number(timestamp);
	if (!Number.isFinite(age) || Math.abs(age) > 300) return false;

	const expected = crypto
		.createHmac('sha256', secret)
		.update(`${timestamp}.${rawBody.toString('utf8')}`)
		.digest('hex');

	const a = Buffer.from(expected);
	const b = Buffer.from(signature);
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

// Remember which Supabase user owns a Stripe customer (for later sub events).
async function saveCustomerMapping(userId, customerId) {
	if (!userId || !customerId) return;
	await fetch(`${SUPABASE_URL}/rest/v1/stripe_customers`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
			Prefer: 'resolution=merge-duplicates'
		},
		body: JSON.stringify({ user_id: userId, customer_id: customerId })
	});
}

async function userIdForCustomer(customerId) {
	if (!customerId) return null;
	const resp = await fetch(
		`${SUPABASE_URL}/rest/v1/stripe_customers?customer_id=eq.${encodeURIComponent(customerId)}&select=user_id`,
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
	if (!STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
		console.error('Stripe webhook env not configured');
		return res.status(500).json({ error: 'Server not configured' });
	}

	const rawBody = await readRawBody(req);
	if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) {
		return res.status(400).json({ error: 'Invalid signature' });
	}

	let event;
	try {
		event = JSON.parse(rawBody.toString('utf8'));
	} catch {
		return res.status(400).json({ error: 'Invalid payload' });
	}

	try {
		const obj = event.data?.object || {};
		switch (event.type) {
			case 'checkout.session.completed': {
				const userId = obj.client_reference_id || obj.metadata?.supabase_user_id || null;
				await saveCustomerMapping(userId, obj.customer);
				await setPremium(userId, true);
				break;
			}
			case 'customer.subscription.updated': {
				const userId = obj.metadata?.supabase_user_id || (await userIdForCustomer(obj.customer));
				const active = obj.status === 'active' || obj.status === 'trialing';
				await setPremium(userId, active);
				break;
			}
			case 'customer.subscription.deleted': {
				const userId = obj.metadata?.supabase_user_id || (await userIdForCustomer(obj.customer));
				await setPremium(userId, false);
				break;
			}
			default:
				// Ignore other event types.
				break;
		}
	} catch (err) {
		console.error('Stripe webhook handler error:', err);
		return res.status(500).json({ error: 'Handler error' });
	}

	return res.status(200).json({ received: true });
}
