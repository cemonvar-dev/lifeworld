// First-run guide for accounts with no tiles. Finishing or skipping it is saved
// to the account, so it never returns on another device.
const ONBOARDING_KEY = 'lw_onboarded';

function shouldShowOnboarding(user, tileCount, storedFlag) {
	return tileCount === 0 && !storedFlag && !(user && user.user_metadata && user.user_metadata.onboarded);
}

(function () {
	const STEP_COUNT = 3;
	const EXAMPLES = ['Morning walk', 'Read 10 pages', 'Drink water'];
	let shown = false;
	let step = 0;
	let overlay;

	const button = 'px-4 py-2 rounded-lg text-sm font-semibold transition';
	const secondary = `${button} text-slate-500 hover:bg-slate-100`;
	const primary = `${button} text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50`;

	function stepHtml() {
		if (step === 0) {
			return `<div class="text-4xl mb-3" aria-hidden="true">🌱</div>
				<h2 class="text-xl font-semibold text-slate-800 mb-2">Welcome to Fiblia</h2>
				<p class="text-sm text-slate-600">Turn your habits and tasks into tiles, and see everything that matters in one calm place.</p>`;
		}
		if (step === 1) {
			return `<div class="grid grid-cols-2 gap-2 mb-4">
					<img src="${healthBannerSrc('thriving')}" alt="Thriving" class="w-full h-16 object-cover rounded-lg" />
					<img src="${healthBannerSrc('dying')}" alt="Dying" class="w-full h-16 object-cover rounded-lg" />
				</div>
				<h2 class="text-xl font-semibold text-slate-800 mb-2">Tiles show how you're doing</h2>
				<p class="text-sm text-slate-600">Mark a tile Done and its health grows. Miss it and it fades. Use Skip for rest days, which don't count against you.</p>`;
		}
		return `<h2 class="text-xl font-semibold text-slate-800 mb-2">Create your first tile</h2>
			<p class="text-sm text-slate-600 mb-3">Start small. What do you want to keep doing?</p>
			<input id="onboardingName" type="text" maxlength="200" placeholder="Tile name…" class="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-300" />
			<div class="flex flex-wrap gap-2 mt-3">${EXAMPLES.map(text => `<button type="button" data-onboarding-example="${text}" class="px-3 py-1.5 rounded-full border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition">${text}</button>`).join('')}</div>`;
	}

	function finish() {
		try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch (e) {}
		overlay.remove();
		supa.auth.updateUser({ data: { onboarded: true } }).then(({ error }) => {
			if (error) console.error('Onboarding save error:', error);
		});
	}

	function render() {
		const isLast = step === STEP_COUNT - 1;
		const dots = Array.from({ length: STEP_COUNT }, (_, i) => `<span class="h-1.5 rounded-full transition-all ${i === step ? 'w-5 bg-blue-500' : 'w-1.5 bg-slate-300'}"></span>`).join('');
		overlay.innerHTML = `<div role="dialog" aria-modal="true" class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
			<div>${stepHtml()}</div>
			<div class="flex items-center gap-1 mt-5" aria-hidden="true">${dots}</div>
			<div class="flex items-center justify-between gap-2 mt-4">
				<button type="button" data-onboarding="skip" class="${secondary}">Skip for now</button>
				<div class="flex gap-2">
					${step > 0 ? `<button type="button" data-onboarding="back" class="${secondary}">Back</button>` : ''}
					<button type="button" data-onboarding="${isLast ? 'create' : 'next'}" class="${primary}">${isLast ? 'Create tile' : 'Next'}</button>
				</div>
			</div>
		</div>`;
		overlay.querySelector('[data-onboarding="skip"]').addEventListener('click', finish);
		overlay.querySelector('[data-onboarding="back"]')?.addEventListener('click', () => { step--; render(); });
		overlay.querySelector('[data-onboarding="next"]')?.addEventListener('click', () => { step++; render(); });
		const nameInput = overlay.querySelector('#onboardingName');
		if (!nameInput) return;
		const createBtn = overlay.querySelector('[data-onboarding="create"]');
		const create = async () => {
			const name = nameInput.value.trim();
			if (!name) { nameInput.focus(); return; }
			createBtn.disabled = true;
			finish();
			await createTileByName(name);
		};
		createBtn.addEventListener('click', create);
		nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
		overlay.querySelectorAll('[data-onboarding-example]').forEach(btn => {
			btn.addEventListener('click', () => {
				nameInput.value = _t(btn.dataset.onboardingExample);
				nameInput.focus();
			});
		});
		nameInput.focus();
	}

	window.maybeShowOnboarding = function (user) {
		let stored = null;
		try { stored = localStorage.getItem(ONBOARDING_KEY); } catch (e) {}
		if (shown || !shouldShowOnboarding(user, tiles.length, stored)) return;
		shown = true;
		overlay = document.createElement('div');
		overlay.id = 'onboardingOverlay';
		overlay.className = 'fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-[60] flex items-center justify-center p-4';
		document.body.appendChild(overlay);
		render();
	};
})();
