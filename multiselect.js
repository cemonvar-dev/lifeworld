// Select several cards and act on them at once. Enter with the "Select" button,
// or Ctrl/Cmd+click a card (Shift+click selects a range). Uses app.js globals:
// tiles, rawTiles, TAGS, TAGS_BY_ID, tagPath, quickLog, setTilePinned, updateTask,
// deleteTile, activeTileId, applyFilters, scheduleReminders, todayLocal,
// openAiChat, escapeHtml, _t, supa.
(function () {
	const selected = new Set();
	let active = false, lastClicked = null, undoTimer = null, busy = false;
	const $ = id => document.getElementById(id);
	const gallery = () => $('gallery');
	const visibleIds = () => [...gallery().querySelectorAll('.tile[data-tile-id]')].map(t => t.dataset.tileId);

	function enter() {
		if (active) return;
		active = true;
		document.body.classList.add('tile-selecting');
		$('selectModeBtn')?.classList.add('ring-2', 'ring-blue-400');
		$('mobileSelectBtn')?.classList.add('ring-2', 'ring-blue-400', 'text-blue-600');
		renderBar();
		decorate();
		window.track?.('multiselect_started');
	}
	function exit() {
		active = false; selected.clear(); lastClicked = null;
		document.body.classList.remove('tile-selecting');
		$('selectModeBtn')?.classList.remove('ring-2', 'ring-blue-400');
		$('mobileSelectBtn')?.classList.remove('ring-2', 'ring-blue-400', 'text-blue-600');
		$('bulkBar')?.remove();
		closeMenu();
		decorate();
	}
	window.exitTileSelection = exit;

	function toggle(id, on) {
		if (on === undefined ? !selected.has(id) : on) selected.add(id); else selected.delete(id);
	}

	// Checkboxes on cards and section headings, re-applied after every gallery render.
	function decorate() {
		const g = gallery();
		if (!g) return;
		g.querySelectorAll('.tile[data-tile-id]').forEach(el => {
			let box = el.querySelector(':scope > [data-sel-box]');
			const on = selected.has(el.dataset.tileId);
			el.classList.toggle('ring-2', active && on);
			el.classList.toggle('ring-blue-500', active && on);
			if (!active) { box?.remove(); return; }
			if (!box) {
				box = document.createElement('span');
				box.dataset.selBox = '';
				box.setAttribute('aria-hidden', 'true');
				el.appendChild(box);
			}
			box.className = `absolute top-2 left-2 z-20 grid place-items-center w-6 h-6 rounded-full border-2 shadow-sm transition ${on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white/90 border-slate-300 text-transparent'}`;
			box.innerHTML = '<svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10.5l3.2 3.2L15 7"/></svg>';
			el.setAttribute('aria-pressed', String(on));
		});
		g.querySelectorAll('section[data-drop-group]').forEach(sec => {
			const head = sec.firstElementChild;
			let all = head.querySelector('[data-sel-all]');
			if (!active) { all?.remove(); return; }
			const ids = [...sec.querySelectorAll('.tile[data-tile-id]')].map(t => t.dataset.tileId);
			const n = ids.filter(id => selected.has(id)).length;
			if (!all) {
				all = document.createElement('button');
				all.type = 'button';
				all.dataset.selAll = '';
				all.className = 'ml-2 self-center inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border transition';
				head.appendChild(all);
			}
			const full = ids.length && n === ids.length;
			all.classList.toggle('bg-blue-600', full); all.classList.toggle('text-white', full); all.classList.toggle('border-blue-600', full);
			all.classList.toggle('bg-white', !full); all.classList.toggle('text-slate-500', !full); all.classList.toggle('border-slate-200', !full);
			all.textContent = full ? `✓ ${_t('All selected')}` : _t('Select all');
			all.onclick = e => { e.stopPropagation(); ids.forEach(id => toggle(id, !full)); update(); };
		});
	}

	function update() { decorate(); renderBar(); }

	// ---- Click handling (capture: wins over the card's own handlers) ----
	document.addEventListener('click', e => {
		const tile = e.target.closest('#gallery .tile[data-tile-id]');
		if (!tile) return;
		const id = tile.dataset.tileId;
		const mod = e.ctrlKey || e.metaKey;
		if (!active && !mod) return;
		e.preventDefault(); e.stopPropagation();
		if (!active) enter();
		if (e.shiftKey && lastClicked) {
			const ids = visibleIds(), a = ids.indexOf(lastClicked), b = ids.indexOf(id);
			if (a >= 0 && b >= 0) ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => toggle(x, true));
		} else toggle(id);
		lastClicked = id;
		update();
	}, true);
	document.addEventListener('keydown', e => {
		if (!active) return;
		if (e.key === 'Escape' && !document.querySelector('[data-bulk-menu]')) { e.preventDefault(); exit(); }
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
			e.preventDefault(); visibleIds().forEach(id => toggle(id, true)); update();
		}
	});

	// ---- Bottom action bar ----
	const ACTIONS = [
		['done', '✅', 'Done'], ['skip', '⏭️', 'Skip'], ['tag', '🏷️', 'Tags'], ['pin', '📌', 'Pin'],
		['date', '📅', 'Date'], ['complete', '✔️', 'Complete'], ['ai', '✨', 'Ask AI'], ['delete', '🗑️', 'Delete']
	];
	function renderBar() {
		if (!active) return;
		let bar = $('bulkBar');
		if (!bar) {
			bar = document.createElement('div');
			bar.id = 'bulkBar';
			bar.className = 'fixed left-1/2 -translate-x-1/2 bottom-20 sm:bottom-6 z-[60] w-[calc(100%-1.5rem)] sm:w-auto max-w-3xl rounded-2xl bg-slate-900 text-white shadow-2xl shadow-slate-900/30 px-2 py-2 flex items-center gap-1';
			document.body.appendChild(bar);
			bar.addEventListener('click', onBarClick);
		}
		const n = selected.size;
		const allPinned = n && [...selected].every(id => rawTiles[id]?.pinned);
		bar.innerHTML = `
			<div class="shrink-0 pl-2 pr-1 text-sm font-semibold whitespace-nowrap">${escapeHtml(_t('{n} selected', { n }))}</div>
			<div class="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto no-scrollbar">
				${ACTIONS.map(([act, icon, label]) => `<button type="button" data-bulk="${act}" ${n ? '' : 'disabled'} class="shrink-0 inline-flex flex-col sm:flex-row items-center gap-0.5 sm:gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] sm:text-xs font-semibold hover:bg-white/10 disabled:opacity-35 disabled:hover:bg-transparent ${act === 'delete' ? 'text-red-300' : ''}"><span class="text-base leading-none">${icon}</span><span>${escapeHtml(act === 'pin' && allPinned ? _t('Unpin') : _t(label))}</span></button>`).join('')}
			</div>
			<button type="button" data-bulk="exit" class="shrink-0 grid place-items-center w-9 h-9 rounded-xl text-xl text-slate-300 hover:bg-white/10" aria-label="${escapeHtml(_t('Close'))}">&times;</button>`;
	}

	function closeMenu() { document.querySelector('[data-bulk-menu]')?.remove(); }
	function menu(anchor, html, onClick) {
		closeMenu();
		const m = document.createElement('div');
		m.dataset.bulkMenu = '';
		m.className = 'fixed z-[70] w-64 max-h-[60vh] overflow-y-auto rounded-2xl bg-white text-slate-700 shadow-2xl ring-1 ring-slate-200 p-1.5 text-sm';
		m.innerHTML = html;
		document.body.appendChild(m);
		const r = anchor.getBoundingClientRect();
		m.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 128, innerWidth - 264)) + 'px';
		m.style.top = Math.max(8, r.top - m.offsetHeight - 8) + 'px';
		m.addEventListener('click', e => { e.stopPropagation(); onClick(e, m); });
		setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off, true); } }, true), 0);
		return m;
	}

	function toast(text, undo) {
		$('tileMoveToast')?.remove();
		clearTimeout(undoTimer);
		const t = document.createElement('div');
		t.id = 'tileMoveToast';
		t.className = 'fixed left-1/2 -translate-x-1/2 bottom-36 sm:bottom-24 z-[9999] flex items-center gap-3 max-w-[calc(100vw-2rem)] bg-slate-800 text-white text-sm rounded-xl shadow-lg pl-4 pr-2 py-2';
		t.innerHTML = `<span class="truncate">${escapeHtml(text)}</span>`;
		if (undo) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'shrink-0 px-3 py-1 rounded-lg font-semibold text-amber-300 hover:bg-white/10';
			b.textContent = _t('Undo');
			b.addEventListener('click', async () => { t.remove(); clearTimeout(undoTimer); await undo(); window.track?.('bulk_undone'); toast(_t('Undone')); });
			t.appendChild(b);
		}
		document.body.appendChild(t);
		undoTimer = setTimeout(() => t.remove(), 6000);
	}

	// ---- Bulk operations ----
	const ids = () => [...selected].filter(id => rawTiles[id]);
	const shown = id => tiles.find(t => t.id === id);
	async function run(name, fn) {
		if (busy) return;
		busy = true;
		try { await fn(); window.track?.('bulk_action', { action: name, count: Math.min(selected.size, 100) }); }
		catch (err) { console.error('bulk action failed:', err); toast(_t("Couldn't save. Please try again.")); }
		busy = false;
		applyFilters();
		// Drop cards the filters now hide (e.g. done today), so the next action can't hit them unseen.
		const visible = new Set(visibleIds());
		[...selected].forEach(id => { if (!visible.has(id)) selected.delete(id); });
		update();
	}

	async function logAll(status) {
		const list = ids();
		const before = list.map(id => [id, shown(id)?.status || 'noaction']);
		for (const id of list) await quickLog(id, status);
		const day = todayLocal();
		toast(_t('{n} cards updated', { n: list.length }), async () => {
			for (const [id, prev] of before) {
				if (prev === 'done' || prev === 'skipped') await quickLog(id, prev);
				else if (window.clearTileDay) await window.clearTileDay(id, day);
			}
			applyFilters(); update();
		});
	}

	async function saveTags(id, tagIds) {
		const raw = rawTiles[id];
		raw.tag_ids = tagIds;
		const t = shown(id); if (t) t.tags = [...tagIds];
		const { error } = await supa.from('tasks').update({ tag_ids: tagIds }).eq('id', id);
		if (error) throw error;
	}
	function tagMenu(anchor) {
		const list = ids();
		const rows = TAGS.map(t => ({ id: t.id, path: tagPath(t.id) })).sort((a, b) => a.path.localeCompare(b.path));
		const state = id => { const n = list.filter(x => (rawTiles[x].tag_ids || []).includes(id)).length; return n === 0 ? 'none' : n === list.length ? 'all' : 'some'; };
		const html = () => `<input data-tag-q type="search" placeholder="${escapeHtml(_t('Search tags…'))}" class="w-full mb-1 px-3 py-2 rounded-xl bg-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
			<div class="px-3 py-1 text-[11px] text-slate-400">${escapeHtml(_t('Tap to add to all · tap again to remove'))}</div>
			${rows.map(r => { const st = state(r.id); const c = window.tagColor ? tagColor(r.id) : ''; return `<button type="button" data-tag="${r.id}" data-path="${escapeHtml(r.path.toLocaleLowerCase())}" class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left hover:bg-slate-50"><span class="shrink-0 w-4 text-center text-blue-600 font-bold">${st === 'all' ? '✓' : st === 'some' ? '–' : ''}</span><span class="shrink-0 w-2.5 h-2.5 rounded-full ${c ? '' : 'border border-slate-300'}" ${c ? `style="background:${c}"` : ''}></span><span translate="no" class="truncate">${escapeHtml(r.path)}</span></button>`; }).join('')}`;
		const m = menu(anchor, html(), async (e, el) => {
			const b = e.target.closest('[data-tag]');
			if (!b) return;
			const tagId = b.dataset.tag, st = state(tagId);
			const before = list.map(id => [id, [...(rawTiles[id].tag_ids || [])]]);
			await run('tag', async () => {
				for (const id of list) {
					const cur = rawTiles[id].tag_ids || [];
					const next = st === 'all' ? cur.filter(x => x !== tagId) : (cur.includes(tagId) ? cur : [...cur, tagId]);
					if (next.length !== cur.length) await saveTags(id, next);
				}
				toast(st === 'all' ? _t('Removed “{name}” from {n} cards', { name: TAGS_BY_ID[tagId].name, n: list.length }) : _t('Added “{name}” to {n} cards', { name: TAGS_BY_ID[tagId].name, n: list.length }), async () => {
					for (const [id, tags] of before) await saveTags(id, tags);
					applyFilters(); update();
				});
			});
			el.remove();
		});
		const q = m.querySelector('[data-tag-q]');
		q.addEventListener('input', () => { const v = q.value.trim().toLocaleLowerCase(); m.querySelectorAll('[data-tag]').forEach(b => { b.style.display = !v || b.dataset.path.includes(v) ? '' : 'none'; }); });
		setTimeout(() => q.focus(), 0);
	}

	async function pinAll() {
		const list = ids();
		const target = !list.every(id => rawTiles[id].pinned);
		const before = list.map(id => [id, !!rawTiles[id].pinned]);
		for (const id of list) if (!!rawTiles[id].pinned !== target) await setTilePinned(id, target);
		toast(target ? _t('{n} cards pinned', { n: list.length }) : _t('{n} cards unpinned', { n: list.length }), async () => {
			for (const [id, was] of before) if (!!rawTiles[id].pinned !== was) await setTilePinned(id, was);
			update();
		});
	}

	function dateMenu(anchor) {
		const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };
		const nextMonday = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return fmt(d); })();
		const once = ids().filter(id => (rawTiles[id].frequency_mode || 'daily') === 'once');
		const skipped = ids().length - once.length;
		const opt = (v, label) => `<button type="button" data-date="${v}" class="w-full px-3 py-2 rounded-xl text-left hover:bg-slate-50">${escapeHtml(label)}</button>`;
		menu(anchor, `
			<div class="px-3 pt-1 pb-1.5 text-[11px] text-slate-400">${escapeHtml(skipped ? _t('Sets the date of {n} one-time tasks ({m} repeating skipped)', { n: once.length, m: skipped }) : _t('Sets the date of {n} one-time tasks', { n: once.length }))}</div>
			${opt(plus(0), _t('Today'))}${opt(plus(1), _t('Tomorrow'))}${opt(nextMonday, _t('Next Monday'))}${opt(plus(7), _t('In a week'))}${opt('', _t('No date'))}
			<div class="flex items-center gap-2 px-3 py-2"><input data-date-pick type="date" class="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-slate-200 text-sm" /><button type="button" data-date-apply class="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold">${escapeHtml(_t('Set'))}</button></div>`,
			(e, el) => {
				const b = e.target.closest('[data-date]');
				const pick = e.target.closest('[data-date-apply]') ? el.querySelector('[data-date-pick]').value : null;
				if (!b && !pick) return;
				const value = b ? b.dataset.date : pick;
				el.remove();
				if (!once.length) { toast(_t('Only one-time tasks have a date.')); return; }
				run('date', async () => {
					const before = once.map(id => [id, rawTiles[id].end_date || null]);
					for (const id of once) { rawTiles[id].end_date = value || null; await updateTask(id, { end_date: value || null }); }
					scheduleReminders();
					toast(_t('{n} cards updated', { n: once.length }), async () => {
						for (const [id, d] of before) { rawTiles[id].end_date = d; await updateTask(id, { end_date: d }); }
						scheduleReminders(); applyFilters(); update();
					});
				});
			});
	}

	async function completeAll() {
		const list = ids();
		const before = list.map(id => [id, rawTiles[id].status || 'in progress']);
		const set = async (id, status) => { rawTiles[id].status = status; const t = shown(id); if (t) t.taskStatus = status; await updateTask(id, { status }); };
		for (const id of list) await set(id, 'completed');
		scheduleReminders();
		toast(_t('{n} cards completed', { n: list.length }), async () => {
			for (const [id, st] of before) await set(id, st);
			scheduleReminders(); applyFilters(); update();
		});
		list.forEach(id => selected.delete(id));
	}

	function deleteAll(anchor) {
		const list = ids();
		menu(anchor, `<div class="p-2">
			<div class="font-semibold text-slate-800 mb-1">${escapeHtml(_t('Delete {n} cards?', { n: list.length }))}</div>
			<div class="text-xs text-slate-500 mb-3">${escapeHtml(_t('Their history and attachments are deleted too. This can\'t be undone.'))}</div>
			<div class="flex justify-end gap-2"><button type="button" data-no class="px-3 py-1.5 rounded-lg bg-slate-100 text-sm font-medium">${escapeHtml(_t('Cancel'))}</button><button type="button" data-yes class="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-semibold">${escapeHtml(_t('Delete'))}</button></div></div>`,
			(e, el) => {
				if (e.target.closest('[data-no]')) { el.remove(); return; }
				if (!e.target.closest('[data-yes]')) return;
				el.remove();
				run('delete', async () => {
					for (const id of list) { activeTileId = id; await deleteTile(); selected.delete(id); }
					toast(_t('{n} cards deleted', { n: list.length }));
				});
			});
	}

	function askAi() {
		const names = ids().map(id => `"${rawTiles[id].name}"`).join(', ');
		openAiChat();
		const input = $('aiChatInput');
		if (input) { input.value = _t('About these tasks: {names}. ', { names }); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
	}

	function onBarClick(e) {
		const b = e.target.closest('[data-bulk]');
		if (!b || b.disabled) return;
		e.stopPropagation();
		const act = b.dataset.bulk;
		if (act === 'exit') return exit();
		if (act === 'done') return run('done', () => logAll('done'));
		if (act === 'skip') return run('skip', () => logAll('skipped'));
		if (act === 'tag') return tagMenu(b);
		if (act === 'pin') return run('pin', pinAll);
		if (act === 'date') return dateMenu(b);
		if (act === 'complete') return run('complete', completeAll);
		if (act === 'delete') return deleteAll(b);
		if (act === 'ai') return askAi();
	}

	function init() {
		const g = gallery();
		if (g) new MutationObserver(() => { if (active) decorate(); }).observe(g, { childList: true });
		$('selectModeBtn')?.addEventListener('click', () => (active ? exit() : enter()));
		// Phones: the top nav is hidden, so add a round button next to the bell.
		const mta = $('mobileTopActions');
		if (mta && !$('mobileSelectBtn')) {
			const b = document.createElement('button');
			b.id = 'mobileSelectBtn';
			b.type = 'button';
			b.setAttribute('aria-label', _t('Select'));
			b.title = _t('Select');
			b.className = 'sm:hidden grid place-items-center h-10 w-10 shrink-0 rounded-full border border-slate-200/80 bg-white/70 backdrop-blur text-slate-600 shadow-sm active:scale-95 transition';
			b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';
			b.addEventListener('click', () => (active ? exit() : enter()));
			mta.prepend(b);
		}
		const style = document.createElement('style');
		style.textContent = `.no-scrollbar{scrollbar-width:none}.no-scrollbar::-webkit-scrollbar{display:none} body.tile-selecting #gallery .tile{cursor:pointer;user-select:none}`;
		document.head.appendChild(style);
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
