// Interests + weekly picks. The user picks what they enjoy (or tells the coach),
// and about once a week /api/ai (mode 'picks') searches the web for concrete
// things to do nearby. Picks show as a card in the coach chat, where each one can
// be added as a dated task or dismissed ("Not for me" teaches the next search).
// Stored in public.user_interests (scripts/user-interests.sql); hidden without it.
// Uses app.js globals: supa, currentUserId, API_BASE, createTileByName, openAiChat,
// escapeHtml, todayLocal, _t, i18n.
(function () {
	const PRESETS = [
		{ icon: '🎬', label: 'Cinema' }, { icon: '✈️', label: 'Travel' }, { icon: '🎵', label: 'Concerts' },
		{ icon: '🎭', label: 'Theatre' }, { icon: '⚽', label: 'Sports' }, { icon: '🍽️', label: 'Food & restaurants' },
		{ icon: '🌲', label: 'Nature & hiking' }, { icon: '🏛️', label: 'Museums & art' }, { icon: '📚', label: 'Courses & workshops' },
		{ icon: '👨‍👩‍👧', label: 'Family outings' }, { icon: '📖', label: 'Books' }, { icon: '🎮', label: 'Games' }
	];
	const DAY = 86400000;
	let row = null;      // { interests, dislikes, picks } once loaded; false if the table is missing
	let loading = null;
	let refreshing = false;
	const $ = id => document.getElementById(id);
	const norm = s => String(s || '').trim().toLowerCase();
	const iconFor = label => (PRESETS.find(p => norm(_t(p.label)) === norm(label) || norm(p.label) === norm(label)) || {}).icon || '⭐';
	const interests = () => (row && row.interests) || [];
	const items = () => (row && row.picks && Array.isArray(row.picks.items) ? row.picks.items : []);

	// ---- Storage ----
	async function load(force) {
		if (!currentUserId) return null;
		if (row !== null && !force) return row;
		if (loading) return loading;
		loading = (async () => {
			const { data, error } = await supa.from('user_interests').select('interests,dislikes,picks').eq('user_id', currentUserId).maybeSingle();
			row = error ? false : (data || { interests: [], dislikes: [], picks: null });
			loading = null;
			return row;
		})();
		return loading;
	}

	async function save(patch) {
		if (!row) return false;
		Object.assign(row, patch);
		const { error } = await supa.from('user_interests').upsert({
			user_id: currentUserId, interests: row.interests || [], dislikes: row.dislikes || [], picks: row.picks || null, updated_at: new Date().toISOString()
		});
		if (error) console.error('Saving interests failed:', error);
		return !error;
	}

	// ---- Weekly refresh ----
	// New picks once a week: whenever the last batch is over a week old, and again
	// from Thursday so there's something fresh for the weekend.
	function needsRefresh() {
		if (!row || !interests().length) return false;
		const at = row.picks && row.picks.at ? new Date(row.picks.at).getTime() : 0;
		if (!at || Date.now() - at > 7 * DAY) return true;
		const now = new Date(), dow = now.getDay();
		if (![4, 5, 6, 0].includes(dow)) return false;
		const thursday = new Date(now); thursday.setHours(0, 0, 0, 0); thursday.setDate(thursday.getDate() - ((dow + 3) % 7));
		return at < thursday.getTime();
	}

	async function refresh(manual) {
		if (refreshing || !row || !interests().length) return { ok: false };
		refreshing = true;
		renderCards();
		let result = { ok: false };
		try {
			const { data: { session } } = await supa.auth.getSession();
			if (!session) return result;
			const region = (navigator.language || '').split('-')[1];
			const response = await fetch(`${API_BASE}/api/ai`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
				body: JSON.stringify({
					mode: 'picks',
					interests: interests(),
					dislikes: (row.dislikes || []).slice(-20),
					language: i18n.lang,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					country: region && /^[A-Z]{2}$/.test(region) ? region : undefined,
					today: todayLocal()
				})
			});
			const data = await response.json().catch(() => ({}));
			if (response.status === 429) result = { ok: false, limited: true };
			else if (response.ok && Array.isArray(data.picks) && data.picks.length) {
				const stamp = Date.now().toString(36);
				await save({ picks: { items: data.picks.map((p, i) => ({ ...p, id: stamp + i, status: 'new' })), at: new Date().toISOString(), seen: false } });
				window.track?.('picks_found', { count: data.picks.length, manual: !!manual });
				result = { ok: true };
				if (!manual) announce(data.picks.length);
			}
		} catch (e) {
			console.error('Picks request failed:', e);
		} finally {
			refreshing = false;
		}
		renderCards();
		return result;
	}

	async function maybeRefresh() {
		if (!(await load())) return;
		if (needsRefresh()) refresh(false);
	}

	// Picks arrived on their own: tell the user where they are.
	function announce(count) {
		if (document.hidden) { window.notifyPicks?.(count); return; }
		if (!$('aiChatOverlay')?.classList.contains('hidden')) { showInChat(); return; }
		toast(`✨ ${_t('Your picks for this week are ready')}`, _t('View'), () => openPicks());
	}

	function toast(text, actionLabel, onAction) {
		$('picksToast')?.remove();
		const t = document.createElement('div');
		t.id = 'picksToast';
		t.className = 'fixed left-1/2 -translate-x-1/2 bottom-36 sm:bottom-24 z-[9999] flex items-center gap-3 max-w-[calc(100vw-2rem)] bg-violet-50 text-slate-700 border border-violet-200 text-sm rounded-xl shadow-lg shadow-slate-900/10 pl-4 pr-2 py-2';
		t.innerHTML = `<span class="truncate">${escapeHtml(text)}</span>`;
		if (actionLabel) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'shrink-0 px-3 py-1 rounded-lg font-semibold text-violet-700 hover:bg-violet-100';
			b.textContent = actionLabel;
			b.addEventListener('click', () => { t.remove(); onAction(); });
			t.appendChild(b);
		}
		document.body.appendChild(t);
		setTimeout(() => t.remove(), 9000);
	}

	// ---- Picks card in the coach chat ----
	async function openPicks() {
		openAiChat();
		await showInChat();
	}

	// Wait for the coach's opening line so the card lands below it.
	async function afterGreeting() {
		for (let i = 0; i < 40 && $('aiGreetingLoading'); i++) await new Promise(r => setTimeout(r, 200));
	}

	async function showInChat() {
		if (!(await load())) return;
		await afterGreeting();
		const container = $('aiChatMessages');
		if (!container) return;
		container.querySelectorAll('[data-picks-card]').forEach(el => el.remove());
		const wrap = document.createElement('div');
		wrap.className = 'flex flex-col items-start';
		wrap.dataset.picksCard = '1';
		container.appendChild(wrap);
		renderCard(wrap);
		container.scrollTop = container.scrollHeight;
		if (row.picks && !row.picks.seen && items().length) { row.picks.seen = true; save({ picks: row.picks }); }
		window.track?.('picks_opened', { count: items().length });
	}

	function renderCards() {
		document.querySelectorAll('[data-picks-card]').forEach(renderCard);
		window.mountInterestsSettings?.();
	}

	function renderCard(wrap) {
		const btn = 'px-2.5 py-1 rounded-lg text-xs font-semibold transition disabled:opacity-50';
		const shell = inner => `<div class="w-full max-w-[94%] rounded-2xl rounded-bl-sm border border-violet-200 bg-violet-50 p-3 text-sm">${inner}</div>`;
		if (!interests().length) {
			wrap.innerHTML = shell(`<div class="font-semibold text-violet-700 mb-1">✨ Picks for you</div>
				<div class="text-slate-600">Tell me what you enjoy, and each week I'll look for things to do around you: films, trips, concerts, courses…</div>
				<div class="mt-2"><button type="button" data-picks-interests class="${btn} bg-violet-100 text-violet-700 hover:bg-violet-200">Choose interests</button></div>`);
		} else {
			const visible = items().filter(p => p.status !== 'hidden');
			const list = visible.map(p => {
				const title = escapeHtml(p.title);
				const head = p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-violet-700 hover:underline">${title} ↗</a>` : `<span class="font-semibold text-slate-700">${title}</span>`;
				const meta = [p.interest ? `${iconFor(p.interest)} ${escapeHtml(p.interest)}` : '', escapeHtml(p.when || '')].filter(Boolean).join(' · ');
				const action = p.status === 'added'
					? `<span class="text-xs text-emerald-600 font-semibold">✓ Added as task</span>`
					: `<button type="button" data-pick-add="${p.id}" class="${btn} bg-violet-100 text-violet-700 hover:bg-violet-200">＋ Add as task</button>
					   <button type="button" data-pick-hide="${p.id}" class="${btn} text-slate-500 hover:bg-violet-100">Not for me</button>`;
				return `<li class="py-2">
					<div translate="no">${head}</div>
					${meta ? `<div translate="no" class="text-[11px] text-slate-500 mt-0.5">${meta}</div>` : ''}
					${p.detail ? `<div translate="no" class="text-xs text-slate-600 mt-0.5">${escapeHtml(p.detail)}</div>` : ''}
					<div class="flex flex-wrap gap-1.5 mt-1.5">${action}</div>
				</li>`;
			}).join('');
			const empty = refreshing
				? `<div class="text-xs text-violet-600 animate-pulse py-2">Looking around for you…</div>`
				: `<div class="text-xs text-slate-500 py-2">${items().length ? 'You’ve gone through all of this week’s picks.' : 'No picks yet. Tap Refresh and I’ll look around.'}</div>`;
			wrap.innerHTML = shell(`<div class="flex items-center justify-between gap-2 mb-1">
					<span class="font-semibold text-violet-700">✨ Picks for you</span>
					${row.picks && row.picks.at ? `<span class="text-[10px] text-slate-400">${escapeHtml(new Date(row.picks.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>` : ''}
				</div>
				${refreshing && visible.length ? `<div class="text-xs text-violet-600 animate-pulse">Looking around for you…</div>` : ''}
				${visible.length ? `<ul class="divide-y divide-violet-100">${list}</ul>` : empty}
				<div data-picks-msg class="hidden text-xs text-slate-500 mt-1"></div>
				<div class="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-violet-100">
					<button type="button" data-picks-interests class="${btn} text-violet-700 hover:bg-violet-100">✏️ Interests</button>
					<button type="button" data-picks-refresh ${refreshing ? 'disabled' : ''} class="${btn} text-violet-700 hover:bg-violet-100">↻ Refresh</button>
				</div>
				<div class="text-[10px] text-slate-400 mt-1">AI-generated from web results; check details before booking.</div>`);
		}
		wrap.querySelectorAll('[data-picks-interests]').forEach(b => b.addEventListener('click', openInterestsPicker));
		wrap.querySelector('[data-picks-refresh]')?.addEventListener('click', async () => {
			const r = await refresh(true);
			if (r.limited) {
				const msg = wrap.querySelector('[data-picks-msg]');
				if (msg) { msg.textContent = _t('You already got fresh picks today. Try again tomorrow.'); msg.classList.remove('hidden'); }
			}
		});
		wrap.querySelectorAll('[data-pick-add]').forEach(b => b.addEventListener('click', () => addPick(b.dataset.pickAdd, b)));
		wrap.querySelectorAll('[data-pick-hide]').forEach(b => b.addEventListener('click', () => hidePick(b.dataset.pickHide)));
	}

	async function addPick(id, button) {
		const p = items().find(x => x.id === id);
		if (!p) return;
		button.disabled = true;
		const created = await createTileByName(p.task || p.title, 'once', { endDate: p.date || null, open: false });
		if (!created) { button.disabled = false; return; }
		const notes = [p.detail, p.when, p.url].filter(Boolean).join('\n');
		if (notes && 'notes' in created) {
			const { error } = await supa.from('tasks').update({ notes }).eq('id', created.id);
			if (!error) created.notes = notes;
		}
		p.status = 'added';
		await save({ picks: row.picks });
		window.track?.('pick_added', { dated: !!p.date });
		renderCards();
	}

	async function hidePick(id) {
		const p = items().find(x => x.id === id);
		if (!p) return;
		p.status = 'hidden';
		const dislikes = [...(row.dislikes || []), p.interest ? `${p.title} (${p.interest})` : p.title].slice(-30);
		await save({ picks: row.picks, dislikes });
		window.track?.('pick_hidden');
		renderCards();
	}

	// ---- Interests picker ----
	function openInterestsPicker() {
		if (!row) return;
		$('interestsOverlay')?.remove();
		const chosen = new Map(interests().map(i => [norm(i.label), { ...i }]));
		const overlay = document.createElement('div');
		overlay.id = 'interestsOverlay';
		overlay.className = 'fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-[80] flex items-end sm:items-center justify-center';
		document.body.appendChild(overlay);
		const presetLabels = PRESETS.map(p => ({ icon: p.icon, label: _t(p.label) }));
		const render = () => {
			const custom = [...chosen.values()].filter(i => !presetLabels.some(p => norm(p.label) === norm(i.label)));
			const all = [...presetLabels, ...custom.map(i => ({ icon: '⭐', label: i.label }))];
			overlay.innerHTML = `<div class="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl w-full sm:w-[420px] max-h-[88vh] overflow-y-auto p-5">
				<div class="flex items-center justify-between mb-1">
					<div class="text-lg font-semibold text-slate-700">✨ What do you enjoy?</div>
					<button type="button" data-int-close aria-label="Close" class="grid place-items-center h-8 w-8 rounded-full text-2xl text-slate-400 hover:bg-slate-100">&times;</button>
				</div>
				<div class="text-xs text-slate-500 mb-3">Each week Fiblia looks for things to do around you that match these.</div>
				<div class="flex flex-wrap gap-2">
					${all.map(p => { const on = chosen.has(norm(p.label)); return `<button type="button" data-int-chip="${escapeHtml(p.label)}" class="px-3 py-1.5 rounded-full text-sm border transition ${on ? 'bg-violet-100 text-violet-700 border-violet-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}"><span translate="no">${p.icon} ${escapeHtml(p.label)}</span>${on ? ' ✓' : ''}</button>`; }).join('')}
				</div>
				<div class="flex gap-2 mt-3">
					<input data-int-custom type="text" maxlength="40" placeholder="Something else…" class="flex-1 min-w-0 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300/50" />
					<button type="button" data-int-add class="px-3 py-1.5 rounded-lg text-sm font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200">Add</button>
				</div>
				${chosen.size ? `<div class="mt-4 text-xs font-semibold text-slate-500">Your taste (optional)</div>
				<div class="mt-1 space-y-1.5">${[...chosen.values()].map(i => `<label class="flex items-center gap-2">
					<span translate="no" class="w-28 shrink-0 truncate text-sm text-slate-700">${iconFor(i.label)} ${escapeHtml(i.label)}</span>
					<input data-int-detail="${escapeHtml(i.label)}" type="text" maxlength="120" value="${escapeHtml(i.detail || '')}" placeholder="e.g. sci-fi, weekend trips, jazz" class="flex-1 min-w-0 rounded-lg border px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-300/50" />
				</label>`).join('')}</div>` : ''}
				<div data-int-error class="hidden mt-2 text-xs text-red-500">Couldn't save. Please try again.</div>
				<div class="flex gap-2 mt-4">
					<button type="button" data-int-save class="flex-1 py-2 rounded-xl bg-violet-100 text-violet-700 text-sm font-semibold hover:bg-violet-200 disabled:opacity-50">Save</button>
					<button type="button" data-int-close class="px-4 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-100">Cancel</button>
				</div>
			</div>`;
		};
		const syncDetails = () => overlay.querySelectorAll('[data-int-detail]').forEach(inp => { const i = chosen.get(norm(inp.dataset.intDetail)); if (i) i.detail = inp.value.trim(); });
		const addCustom = () => {
			const inp = overlay.querySelector('[data-int-custom]');
			const label = (inp.value || '').trim().slice(0, 40);
			if (label && !chosen.has(norm(label))) { syncDetails(); chosen.set(norm(label), { label, detail: '' }); render(); }
		};
		render();
		overlay.addEventListener('click', async e => {
			if (e.target === overlay || e.target.closest('[data-int-close]')) { overlay.remove(); return; }
			const chip = e.target.closest('[data-int-chip]');
			if (chip) {
				syncDetails();
				const key = norm(chip.dataset.intChip);
				if (chosen.has(key)) chosen.delete(key); else chosen.set(key, { label: chip.dataset.intChip, detail: '' });
				render();
				return;
			}
			if (e.target.closest('[data-int-add]')) { addCustom(); return; }
			const saveBtn = e.target.closest('[data-int-save]');
			if (saveBtn) {
				syncDetails();
				saveBtn.disabled = true;
				const hadPicks = items().length > 0;
				const ok = await save({ interests: [...chosen.values()].slice(0, 15) });
				if (!ok) { saveBtn.disabled = false; overlay.querySelector('[data-int-error]')?.classList.remove('hidden'); return; }
				overlay.remove();
				window.track?.('interests_saved', { count: chosen.size, source: 'picker' });
				renderCards();
				if (!hadPicks && interests().length) refresh(true);
			}
		});
		overlay.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-int-custom]')) { e.preventDefault(); addCustom(); } });
	}

	// ---- Coach integration ----
	// What the coach sees: interests and this week's picks.
	function picksContext() {
		if (!row) return '';
		const list = interests();
		if (!list.length) return '\n\nINTERESTS: none saved yet.';
		let out = `\n\nINTERESTS: ${list.map(i => i.label + (i.detail ? ` (${i.detail})` : '')).join('; ')}`;
		const shown = items().filter(p => p.status !== 'hidden');
		if (shown.length) {
			out += `\nTHIS WEEK'S PICKS (found ${String(row.picks.at || '').slice(0, 10)} on the web; the user sees them as cards in this chat):\n` +
				shown.map(p => `- [${p.interest || '?'}] ${p.title} | when: ${p.when || '?'}${p.date ? ` (${p.date})` : ''} | ${p.detail}${p.status === 'added' ? ' | ALREADY ADDED AS TASK' : ''}`).join('\n');
		}
		if ((row.dislikes || []).length) out += `\nNOT FOR THEM: ${row.dislikes.slice(-10).join('; ')}`;
		return out;
	}

	// The coach's save_interests tool: { add: [{label, detail}], remove: [label] }.
	async function applyCoachInterests(change) {
		if (!(await load())) return;
		const map = new Map(interests().map(i => [norm(i.label), { ...i }]));
		(change.remove || []).forEach(l => map.delete(norm(l)));
		(change.add || []).forEach(i => {
			const key = norm(i.label);
			const prev = map.get(key);
			map.set(key, { label: prev ? prev.label : i.label, detail: i.detail || (prev && prev.detail) || '' });
		});
		const hadPicks = items().length > 0;
		await save({ interests: [...map.values()].slice(0, 15) });
		window.track?.('interests_saved', { count: map.size, source: 'coach' });
		renderCards();
		if (!hadPicks && interests().length) refresh(false);
	}

	// Chat opened: show fresh, unseen picks under the coach's first line.
	async function onCoachOpened() {
		if (!(await load())) return;
		if (row.picks && !row.picks.seen && items().some(p => p.status === 'new')) showInChat();
	}

	// ---- Settings: a short summary with an Edit button ----
	window.mountInterestsSettings = async function () {
		const mount = $('interestsSettingsMount');
		if (!mount) return;
		if (!(await load())) { mount.innerHTML = ''; mount.classList.add('hidden'); return; }
		mount.classList.remove('hidden');
		const list = interests();
		mount.innerHTML = `<div class="flex items-center justify-between gap-2">
				<div class="text-sm font-semibold">✨ Interests</div>
				<button type="button" data-int-edit class="text-xs font-semibold text-violet-700 px-2 py-1 rounded-lg hover:bg-violet-50">${list.length ? 'Edit' : 'Choose'}</button>
			</div>
			<div class="text-xs text-slate-500 mt-1">${list.length ? `<span translate="no">${list.map(i => `${iconFor(i.label)} ${escapeHtml(i.label)}`).join(', ')}</span>` : escapeHtml(_t('Pick what you enjoy and Fiblia will find things to do each week.'))}</div>`;
		mount.querySelector('[data-int-edit]').addEventListener('click', openInterestsPicker);
	};

	// ---- Startup: load once signed in, then check for a weekly refresh ----
	async function start() {
		for (let i = 0; i < 80 && !currentUserId; i++) await new Promise(r => setTimeout(r, 250));
		if (!currentUserId) return;
		await maybeRefresh();
		document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeRefresh(); });
		document.getElementById('aiPicksBtn')?.addEventListener('click', () => { window.track?.('picks_chip'); showInChat(); });
	}

	window.picksContext = picksContext;
	window.applyCoachInterests = applyCoachInterests;
	window.onCoachOpened = onCoachOpened;
	window.openPicks = openPicks;
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
