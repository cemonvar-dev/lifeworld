// In-app feedback form. Stays hidden until scripts/feedback.sql has created the
// table, so the app can ship before the migration runs.
(function () {
	const MAX_LENGTH = 2000;
	let overlay, input, errorEl, sendBtn, formEl, thanksEl;

	function build() {
		overlay = document.createElement('div');
		overlay.id = 'feedbackOverlay';
		overlay.className = 'fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-4';
		overlay.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="feedbackTitle" class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
			<div id="feedbackTitle" class="text-lg font-semibold text-slate-700 mb-1">Send feedback</div>
			<div id="feedbackForm">
				<p class="text-sm text-slate-500 mb-3">Tell us what works, what doesn't, or what you'd like to see.</p>
				<textarea id="feedbackMessage" rows="5" maxlength="${MAX_LENGTH}" placeholder="Your message…" class="w-full rounded-lg border px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-300"></textarea>
				<div id="feedbackError" class="hidden mt-1 text-xs text-red-500">Couldn't send your feedback. Please try again.</div>
				<div class="flex justify-end gap-2 mt-3">
					<button type="button" data-feedback-close class="px-4 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:bg-slate-100 transition">Cancel</button>
					<button type="button" id="feedbackSend" class="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition disabled:opacity-50">Send</button>
				</div>
			</div>
			<div id="feedbackThanks" class="hidden">
				<p class="text-sm text-slate-600 mb-4">Thank you. Every message is read by the Fiblia team.</p>
				<div class="flex justify-end"><button type="button" data-feedback-close class="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition">Close</button></div>
			</div>
		</div>`;
		document.body.appendChild(overlay);
		input = overlay.querySelector('#feedbackMessage');
		errorEl = overlay.querySelector('#feedbackError');
		sendBtn = overlay.querySelector('#feedbackSend');
		formEl = overlay.querySelector('#feedbackForm');
		thanksEl = overlay.querySelector('#feedbackThanks');
		overlay.querySelectorAll('[data-feedback-close]').forEach(btn => btn.addEventListener('click', close));
		overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
		sendBtn.addEventListener('click', send);
	}

	function open() {
		input.value = '';
		errorEl.classList.add('hidden');
		formEl.classList.remove('hidden');
		thanksEl.classList.add('hidden');
		sendBtn.disabled = false;
		overlay.classList.remove('hidden');
		input.focus();
	}

	function close() {
		overlay.classList.add('hidden');
	}

	async function send() {
		const message = input.value.trim();
		if (!message) { input.focus(); return; }
		sendBtn.disabled = true;
		errorEl.classList.add('hidden');
		const { error } = await supa.from('feedback').insert({
			message: message.slice(0, MAX_LENGTH),
			page: location.pathname,
			language: i18n.lang,
			user_agent: navigator.userAgent.slice(0, 300)
		});
		sendBtn.disabled = false;
		if (error) {
			console.error('Feedback error:', error);
			errorEl.classList.remove('hidden');
			return;
		}
		formEl.classList.add('hidden');
		thanksEl.classList.remove('hidden');
		// Only the event: the message itself never goes to analytics.
		if (window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture('feedback_submitted');
	}

	document.addEventListener('DOMContentLoaded', async () => {
		const { error } = await supa.from('feedback').select('id').limit(1);
		if (error) return;
		build();
		document.querySelectorAll('.feedback-open').forEach(btn => {
			btn.classList.remove('hidden');
			btn.addEventListener('click', open);
		});
	});
})();
