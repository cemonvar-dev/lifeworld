// First-run guide and Getting started checklist. Progress through both is saved
// to the account, so neither returns on another device once finished.
const ONBOARDING_KEY = 'lw_onboarded';
const CHECKLIST_KEY = 'lw_checklist_done';
const TRIED_AI_KEY = 'lw_tried_ai';

function shouldShowOnboarding(user, tileCount, storedFlag) {
	return tileCount === 0 && !storedFlag && !(user && user.user_metadata && user.user_metadata.onboarded);
}

function shouldShowChecklist(user, onboardedFlag, checklistFlag) {
	const meta = (user && user.user_metadata) || {};
	return !!(meta.onboarded || onboardedFlag) && !meta.checklist_done && !checklistFlag;
}

// Which Getting started steps are done, from the user's own tiles.
function gettingStartedProgress(tasks, triedAi) {
	return {
		create: tasks.length > 0,
		done: tasks.some(t => (t.task_logs || []).some(l => l.status === 'done' || l.status === 'completed')),
		reminder: tasks.some(t => t.reminder_at || (t.time_of_day || []).length > 0),
		ai: !!triedAi
	};
}

(function () {
	const STEP_COUNT = 3;
	const EXAMPLES = ['Morning walk', 'Read 10 pages', 'Drink water'];
	const CHECKLIST = [
		{ key: 'create', label: 'Create a tile' },
		{ key: 'done', label: 'Mark a tile Done' },
		{ key: 'reminder', label: 'Set a reminder' },
		{ key: 'ai', label: 'Try the AI coach' }
	];
	let currentUser = null;
	let shown = false;
	let step = 0;
	let tileMode = 'daily';
	let overlay = null;

	const button = 'px-4 py-2 rounded-lg text-sm font-semibold transition';
	const secondary = `${button} text-slate-500 hover:bg-slate-100`;
	const primary = `${button} text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50`;
	const read = key => { try { return localStorage.getItem(key); } catch (e) { return null; } };
	const write = key => { try { localStorage.setItem(key, '1'); } catch (e) {} };
	const saveFlag = data => supa.auth.updateUser({ data }).then(({ error }) => {
		if (error) console.error('Onboarding save error:', error);
	});

	function modeClass(mode) {
		return `px-3 py-1 rounded-full transition ${mode === tileMode ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`;
	}

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
			<div class="flex flex-wrap gap-2 mt-3">${EXAMPLES.map(text => `<button type="button" data-onboarding-example="${text}" class="px-3 py-1.5 rounded-full border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition">${text}</button>`).join('')}</div>
			<div class="inline-flex items-center rounded-full border border-slate-200 bg-white p-0.5 text-xs font-semibold mt-3">
				<button type="button" data-onboarding-mode="daily" class="${modeClass('daily')}">Daily</button>
				<button type="button" data-onboarding-mode="once" class="${modeClass('once')}">One-time</button>
			</div>`;
	}

	function finish() {
		write(ONBOARDING_KEY);
		overlay.remove();
		overlay = null;
		if (currentUser) currentUser.user_metadata = { ...currentUser.user_metadata, onboarded: true };
		saveFlag({ onboarded: true });
		refreshChecklist();
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
		overlay.querySelector('[data-onboarding="skip"]').addEventListener('click', () => {
			window.track?.('onboarding_skipped', { step: step + 1 });
			finish();
		});
		overlay.querySelector('[data-onboarding="back"]')?.addEventListener('click', () => { step--; render(); });
		overlay.querySelector('[data-onboarding="next"]')?.addEventListener('click', () => { step++; render(); });
		const nameInput = overlay.querySelector('#onboardingName');
		if (!nameInput) return;
		const createBtn = overlay.querySelector('[data-onboarding="create"]');
		const create = async () => {
			const name = nameInput.value.trim();
			if (!name) { nameInput.focus(); return; }
			createBtn.disabled = true;
			const mode = tileMode;
			window.track?.('onboarding_completed', { frequency: mode });
			finish();
			await createTileByName(name, mode);
		};
		createBtn.addEventListener('click', create);
		nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
		overlay.querySelectorAll('[data-onboarding-example]').forEach(btn => {
			btn.addEventListener('click', () => {
				nameInput.value = _t(btn.dataset.onboardingExample);
				nameInput.focus();
			});
		});
		overlay.querySelectorAll('[data-onboarding-mode]').forEach(btn => {
			btn.addEventListener('click', () => {
				tileMode = btn.dataset.onboardingMode;
				overlay.querySelectorAll('[data-onboarding-mode]').forEach(b => { b.className = modeClass(b.dataset.onboardingMode); });
			});
		});
		nameInput.focus();
	}

	function openGuide() {
		if (overlay) return;
		step = 0;
		tileMode = 'daily';
		overlay = document.createElement('div');
		overlay.id = 'onboardingOverlay';
		overlay.className = 'fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-[60] flex items-center justify-center p-4';
		document.body.appendChild(overlay);
		render();
	}

	function closeChecklist(reason) {
		window.track?.('checklist_closed', { reason });
		write(CHECKLIST_KEY);
		if (currentUser) currentUser.user_metadata = { ...currentUser.user_metadata, checklist_done: true };
		saveFlag({ checklist_done: true });
		document.getElementById('gettingStarted')?.remove();
	}

	function runChecklistAction(key) {
		if (key === 'create') openGuide();
		else if (key === 'reminder' && tiles.length) openTilePopup(tiles[0].id);
		else if (key === 'ai') document.getElementById('aiChatBtn').click();
	}

	function refreshChecklist() {
		const gallery = document.getElementById('gallery');
		if (!gallery || !currentUser) return;
		let panel = document.getElementById('gettingStarted');
		if (!shouldShowChecklist(currentUser, read(ONBOARDING_KEY), read(CHECKLIST_KEY))) {
			if (panel) panel.remove();
			return;
		}
		const progress = gettingStartedProgress(Object.values(rawTiles), read(TRIED_AI_KEY));
		const doneCount = CHECKLIST.filter(item => progress[item.key]).length;
		if (doneCount === CHECKLIST.length) { closeChecklist('completed'); return; }
		if (!panel) {
			panel = document.createElement('section');
			panel.id = 'gettingStarted';
			panel.className = 'mt-4 rounded-2xl bg-white/80 border border-slate-200/80 shadow-sm p-3';
			gallery.parentNode.insertBefore(panel, gallery);
		}
		panel.innerHTML = `<div class="flex items-center justify-between gap-2 mb-2">
				<div class="text-sm font-semibold text-slate-700">Getting started</div>
				<div class="flex items-center gap-2">
					<span class="text-xs text-slate-500">${doneCount} of ${CHECKLIST.length} done</span>
					<button type="button" data-checklist-hide class="text-xs font-semibold text-slate-400 hover:text-slate-600 transition">Hide</button>
				</div>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-4 gap-1.5">${CHECKLIST.map(item => {
				const finished = progress[item.key];
				const clickable = !finished && item.key !== 'done' && !(item.key === 'reminder' && !tiles.length);
				return `<button type="button" ${clickable ? `data-checklist-item="${item.key}"` : 'disabled'} class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs font-medium transition ${finished ? 'text-slate-400 line-through' : clickable ? 'text-slate-700 bg-slate-100 hover:bg-slate-200' : 'text-slate-700 bg-slate-100'}"><span aria-hidden="true">${finished ? '✅' : '⬜'}</span><span>${item.label}</span></button>`;
			}).join('')}</div>`;
		panel.querySelector('[data-checklist-hide]').addEventListener('click', () => closeChecklist('hidden'));
		panel.querySelectorAll('[data-checklist-item]').forEach(btn => {
			btn.addEventListener('click', () => runChecklistAction(btn.dataset.checklistItem));
		});
	}

	window.showOnboarding = openGuide;
	window.refreshGettingStarted = refreshChecklist;
	window.maybeShowOnboarding = function (user) {
		currentUser = user;
		if (!shown && shouldShowOnboarding(user, tiles.length, read(ONBOARDING_KEY))) {
			shown = true;
			openGuide();
		}
		refreshChecklist();
	};

	document.addEventListener('DOMContentLoaded', () => {
		document.getElementById('aiChatBtn')?.addEventListener('click', () => {
			write(TRIED_AI_KEY);
			refreshChecklist();
		});
		document.getElementById('replayGuideBtn')?.addEventListener('click', openGuide);
	});
})();
