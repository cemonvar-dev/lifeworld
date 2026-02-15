export default async function handler(req, res) {
	// CORS
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

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
				model: 'gpt-3.5-turbo',
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
