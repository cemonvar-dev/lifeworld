// Tags panel: browse, open, create, rename, color, nest, reorder and delete tags.
// Replaces the old "Filter by Tag" popup. Uses app.js globals: TAGS, TAGS_BY_ID,
// tiles, rawTiles, activeTagFilter, activePinnedFilter, supa, currentUserId,
// rebuildTagIndex, getDescendantIds, applyFilters, updateFilterBar, setTagFilter,
// logDay, coachDaysSince, escapeHtml, _t, refreshTagTree (assigned here).
(function () {
	const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];
	const STATE_KEY = 'lw_tag_tree_collapsed';
	const FINISHED = ['completed', 'cancelled', 'failed'];

	let view = 'list';      // 'list' | 'move' | 'delete'
	let target = null;      // tag id for move/delete views
	let editingId = null;   // tag being renamed inline
	let addingUnder;        // undefined = not adding; null = top level; id = sub-tag of id
	let busy = false;
	let collapsed = loadCollapsed();

	const $ = id => document.getElementById(id);
	const lc = s => String(s || '').toLocaleLowerCase();

	function loadCollapsed() {
		try { const v = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); if (Array.isArray(v)) return new Set(v); } catch (e) {}
		return null; // decided on first open (collapse roots when there are many tags)
	}
	function saveCollapsed() { try { localStorage.setItem(STATE_KEY, JSON.stringify([...collapsed])); } catch (e) {} }

	const childrenOf = pid => TAGS.filter(t => (t.parent_id || null) === (pid || null))
		.sort((a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || a.name.localeCompare(b.name));

	// Nearest color up the tree (sub-tags inherit their parent's color).
	function tagColor(id) {
		let cur = TAGS_BY_ID[id], guard = 0;
		while (cur && guard++ < 30) { if (cur.color) return cur.color; cur = cur.parent_id ? TAGS_BY_ID[cur.parent_id] : null; }
		return '';
	}
	window.tagColor = tagColor;

	// Stats for a tag including its sub-tags: active cards, cards needing attention, last Done.
	function stats(id) {
		const ids = getDescendantIds(id); ids.add(id);
		const members = tiles.filter(t => !FINISHED.includes(t.taskStatus) && (t.tags || []).some(x => ids.has(x)));
		let last = '';
		members.forEach(t => (rawTiles[t.id]?.task_logs || []).forEach(l => {
			if (l.status !== 'done' && l.status !== 'completed') return;
			const d = logDay(l); if (d > last) last = d;
		}));
		return { count: members.length, attention: members.filter(t => (t.health || 0) < 40).length, last };
	}
	const ago = day => { if (!day) return ''; const n = coachDaysSince(day); return n <= 0 ? _t('Today') : n === 1 ? _t('Yesterday') : _t('{n}d ago', { n }); };

	function toast(text) {
		const panel = $('tagPanel');
		panel.querySelector('[data-tag-toast]')?.remove();
		const t = document.createElement('div');
		t.dataset.tagToast = '';
		t.className = 'absolute left-1/2 -translate-x-1/2 bottom-4 z-20 max-w-[90%] bg-white text-slate-700 border border-slate-200 text-sm rounded-xl px-4 py-2 shadow-lg shadow-slate-900/10';
		t.textContent = text;
		panel.appendChild(t);
		setTimeout(() => t.remove(), 3500);
	}

	async function run(fn) {
		if (busy) return;
		busy = true;
		try { await fn(); } catch (e) { console.error('Tag action failed:', e); toast(_t("Couldn't save. Please try again.")); }
		busy = false;
		afterChange();
	}
	function afterChange() {
		rebuildTagIndex();
		applyFilters();
		updateFilterBar();
		render();
	}

	// ---- Data operations ----
	const ops = {
		async create(name, parentId) {
			const sibs = childrenOf(parentId);
			const row = { user_id: currentUserId, name, ...(parentId ? { parent_id: parentId } : {}), sort_order: sibs.length ? Math.max(...sibs.map(s => s.sort_order || 0)) + 1 : 0 };
			const { data, error } = await supa.from('tags').insert(row).select().single();
			if (error) throw error;
			if (data && !TAGS.some(t => t.id === data.id)) TAGS.push(data);
			if (parentId && collapsed) { collapsed.delete(parentId); saveCollapsed(); }
			window.track?.('tag_created', { nested: !!parentId });
		},
		async rename(id, name) {
			const { error } = await supa.from('tags').update({ name }).eq('id', id);
			if (error) throw error;
			TAGS_BY_ID[id].name = name;
		},
		async color(id, color) {
			const { error } = await supa.from('tags').update({ color: color || null }).eq('id', id);
			if (error) throw error;
			TAGS_BY_ID[id].color = color || null;
			window.track?.('tag_colored');
		},
		async move(id, dir) {
			const cur = TAGS_BY_ID[id];
			const sibs = childrenOf(cur.parent_id);
			const i = sibs.findIndex(t => t.id === id), j = i + dir;
			if (j < 0 || j >= sibs.length) return;
			[sibs[i], sibs[j]] = [sibs[j], sibs[i]];
			for (let k = 0; k < sibs.length; k++) {
				if (sibs[k].sort_order === k) continue;
				const { error } = await supa.from('tags').update({ sort_order: k }).eq('id', sibs[k].id);
				if (error) throw error;
				sibs[k].sort_order = k;
			}
		},
		async reparent(id, parentId) {
			if (parentId && (parentId === id || getDescendantIds(id).has(parentId))) { toast(_t("Can't move a tag under one of its own children.")); return; }
			const sibs = childrenOf(parentId).filter(t => t.id !== id);
			const order = sibs.length ? Math.max(...sibs.map(s => s.sort_order || 0)) + 1 : 0;
			const { error } = await supa.from('tags').update({ parent_id: parentId, sort_order: order }).eq('id', id);
			if (error) throw error;
			Object.assign(TAGS_BY_ID[id], { parent_id: parentId, sort_order: order });
			if (parentId && collapsed) { collapsed.delete(parentId); saveCollapsed(); }
		},
		async remove(id) {
			for (const task of Object.values(rawTiles).filter(t => (t.tag_ids || []).includes(id))) {
				task.tag_ids = task.tag_ids.filter(x => x !== id);
				const { error } = await supa.from('tasks').update({ tag_ids: task.tag_ids }).eq('id', task.id);
				if (error) throw error;
				const shown = tiles.find(t => t.id === task.id);
				if (shown) shown.tags = [...task.tag_ids];
			}
			const { error } = await supa.from('tags').delete().eq('id', id); // sub-tags' parent_id -> null via FK
			if (error) throw error;
			TAGS.forEach(t => { if (t.parent_id === id) t.parent_id = null; });
			TAGS.splice(TAGS.findIndex(t => t.id === id), 1);
			if (activeTagFilter === id) setTagFilter(null);
			window.track?.('tag_deleted');
		}
	};

	// ---- Rendering ----
	function icon(path, cls = 'w-4 h-4') {
		return `<svg class="${cls}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
	}
	const CHEVRON = '<path d="M7 5l5 5-5 5"/>';
	const DOTS = '<circle cx="4.5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.3" fill="currentColor" stroke="none"/>';

	function highlight(name, q) {
		const i = q ? lc(name).indexOf(q) : -1;
		if (i < 0) return escapeHtml(name);
		return escapeHtml(name.slice(0, i)) + `<mark class="bg-amber-100 text-inherit rounded px-0.5">${escapeHtml(name.slice(i, i + q.length))}</mark>` + escapeHtml(name.slice(i + q.length));
	}

	function dot(color, extra = '') {
		return color
			? `<span class="shrink-0 w-2.5 h-2.5 rounded-full ${extra}" style="background:${color}"></span>`
			: `<span class="shrink-0 w-2.5 h-2.5 rounded-full border border-slate-300 ${extra}"></span>`;
	}

	function inputRow(level, value, onSubmit, placeholder) {
		const row = document.createElement('div');
		row.className = 'flex items-center gap-2 py-1.5 pr-2';
		row.style.paddingLeft = (12 + level * 18 + 22) + 'px';
		row.innerHTML = `<input type="text" maxlength="60" class="flex-1 min-w-0 px-3 py-1.5 rounded-lg border border-blue-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
			<button type="button" data-ok class="shrink-0 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700">${escapeHtml(_t('Save'))}</button>
			<button type="button" data-cancel class="shrink-0 px-2 py-1.5 rounded-lg text-xs text-slate-500 hover:bg-slate-100">${escapeHtml(_t('Cancel'))}</button>`;
		const input = row.querySelector('input');
		input.value = value || '';
		input.placeholder = placeholder || '';
		const cancel = () => { editingId = null; addingUnder = undefined; render(); };
		const submit = () => { const v = input.value.trim(); if (!v) return cancel(); onSubmit(v); };
		row.querySelector('[data-ok]').addEventListener('click', submit);
		row.querySelector('[data-cancel]').addEventListener('click', cancel);
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
		});
		setTimeout(() => { input.focus(); input.select(); }, 0);
		return row;
	}

	function simpleRow({ label, count, active, onClick, leading }) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = `w-full flex items-center gap-2.5 pl-3 pr-3 py-2 rounded-xl text-left transition ${active ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50 text-slate-700'}`;
		row.innerHTML = `<span class="w-4 shrink-0"></span>${leading}<span class="flex-1 truncate text-sm font-medium">${escapeHtml(label)}</span><span class="text-xs text-slate-400 tabular-nums">${count}</span><span class="w-8 shrink-0"></span>`;
		row.addEventListener('click', onClick);
		return row;
	}

	function tagRow(tag, level, q, hasKids, isOpen) {
		const s = stats(tag.id);
		const active = activeTagFilter === tag.id;
		const row = document.createElement('div');
		row.className = `group relative flex items-center gap-1.5 pr-1 rounded-xl transition ${active ? 'bg-blue-50' : 'hover:bg-slate-50'}`;
		row.style.paddingLeft = (4 + level * 18) + 'px';
		row.dataset.tagRow = tag.id;
		const chevron = hasKids
			? `<button type="button" data-toggle class="shrink-0 grid place-items-center w-6 h-8 rounded-md text-slate-400 hover:text-slate-700" aria-label="${escapeHtml(isOpen ? _t('Collapse') : _t('Expand'))}" aria-expanded="${isOpen}">${icon(CHEVRON, `w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`)}</button>`
			: '<span class="shrink-0 w-6"></span>';
		const meta = [
			s.attention ? `<span class="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600" title="${escapeHtml(_t('need attention'))}"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>${s.attention}</span>` : '',
			s.last ? `<span class="hidden sm:inline text-[11px] text-slate-400 whitespace-nowrap">✓ ${escapeHtml(ago(s.last))}</span>` : ''
		].join('');
		row.innerHTML = `${chevron}
			<button type="button" data-open class="flex-1 min-w-0 flex items-center gap-2.5 py-2 text-left">
				${dot(tagColor(tag.id))}
				<span translate="no" class="flex-1 min-w-0 truncate text-sm ${active ? 'font-semibold text-blue-800' : 'text-slate-700'}">${highlight(tag.name, q)}</span>
				${meta}
				<span class="text-xs text-slate-400 tabular-nums w-6 text-right">${s.count}</span>
			</button>
			<button type="button" data-menu class="shrink-0 grid place-items-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="${escapeHtml(_t('More actions'))}" aria-haspopup="menu">${icon(DOTS)}</button>`;
		row.querySelector('[data-toggle]')?.addEventListener('click', e => {
			e.stopPropagation();
			collapsed[isOpen ? 'add' : 'delete'](tag.id);
			saveCollapsed();
			render();
		});
		row.querySelector('[data-open]').addEventListener('click', () => openTag(tag.id));
		row.querySelector('[data-menu]').addEventListener('click', e => { e.stopPropagation(); openMenu(tag.id, e.currentTarget); });
		return row;
	}

	function openTag(id) {
		close();
		if (window.openTagList) window.openTagList(id); else setTagFilter(id);
	}

	function renderList(body) {
		const q = lc($('tagSearch').value.trim());
		// Visible set: everything, or matches plus their ancestors when searching.
		let visible = null;
		if (q) {
			visible = new Set();
			TAGS.filter(t => lc(t.name).includes(q)).forEach(t => {
				let cur = t, guard = 0;
				while (cur && guard++ < 30) { visible.add(cur.id); cur = cur.parent_id ? TAGS_BY_ID[cur.parent_id] : null; }
			});
		}
		const active = tiles.filter(t => !FINISHED.includes(t.taskStatus));
		if (!q) {
			body.appendChild(simpleRow({
				label: _t('All cards'), count: active.length, active: !activeTagFilter && !activePinnedFilter,
				leading: `<span class="shrink-0 w-2.5 h-2.5 rounded-full bg-gradient-to-br from-blue-400 to-violet-400"></span>`,
				onClick: () => { close(); if (activeTagFilter || activePinnedFilter) (window.exitTagList ? window.exitTagList() : setTagFilter(null)); }
			}));
		}
		if (addingUnder === null) body.appendChild(inputRow(0, '', name => run(() => ops.create(name, null)).then(() => { addingUnder = undefined; render(); }), _t('New tag name')));

		const list = document.createElement('div');
		list.className = 'mt-1';
		const walk = (pid, level) => {
			childrenOf(pid).forEach(tag => {
				if (visible && !visible.has(tag.id)) return;
				const kids = childrenOf(tag.id).filter(k => !visible || visible.has(k.id));
				const isOpen = !!q || !collapsed.has(tag.id);
				if (editingId === tag.id) list.appendChild(inputRow(level, tag.name, name => { editingId = null; run(() => ops.rename(tag.id, name)); }, _t('Tag name')));
				else list.appendChild(tagRow(tag, level, q, kids.length > 0 || addingUnder === tag.id, isOpen || addingUnder === tag.id));
				if (addingUnder === tag.id) list.appendChild(inputRow(level + 1, '', name => run(() => ops.create(name, tag.id)).then(() => { addingUnder = undefined; render(); }), _t('Sub-tag name')));
				if (isOpen) walk(tag.id, level + 1);
			});
		};
		walk(null, 0);
		body.appendChild(list);

		if (!TAGS.length && addingUnder === undefined) {
			const empty = document.createElement('div');
			empty.className = 'text-center text-sm text-slate-400 py-10';
			empty.textContent = _t('No tags yet. Create your first one.');
			body.appendChild(empty);
		} else if (q && !visible.size) {
			const empty = document.createElement('div');
			empty.className = 'text-center text-sm text-slate-400 py-10';
			empty.textContent = _t('No tags match “{q}”', { q: $('tagSearch').value.trim() });
			body.appendChild(empty);
		}
		const untagged = active.filter(t => !t.tags || !t.tags.length).length;
		if (!q && untagged) {
			const sep = document.createElement('div');
			sep.className = 'my-2 border-t border-slate-100';
			body.appendChild(sep);
			body.appendChild(simpleRow({
				label: _t('Untagged'), count: untagged, active: activeTagFilter === '__untagged__',
				leading: dot('', 'border-dashed'),
				onClick: () => { close(); setTagFilter('__untagged__'); }
			}));
		}
	}

	function renderMove(body) {
		const tag = TAGS_BY_ID[target];
		if (!tag) { view = 'list'; return renderList(body); }
		const blocked = getDescendantIds(tag.id); blocked.add(tag.id);
		body.innerHTML = `<div class="flex items-center gap-2 px-2 pt-1 pb-3">
			<button type="button" data-back class="grid place-items-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100" aria-label="${escapeHtml(_t('Back'))}">${icon('<path d="M13 5l-5 5 5 5"/>')}</button>
			<div class="text-sm text-slate-600">${escapeHtml(_t('Move “{name}” to…', { name: tag.name }))}</div></div>`;
		body.querySelector('[data-back]').addEventListener('click', () => { view = 'list'; render(); });
		const option = (label, parentId, level, color) => {
			const b = document.createElement('button');
			b.type = 'button';
			const current = (tag.parent_id || null) === (parentId || null);
			b.className = `w-full flex items-center gap-2.5 pr-3 py-2 rounded-xl text-left text-sm transition ${current ? 'bg-blue-50 text-blue-800 font-semibold' : 'hover:bg-slate-50 text-slate-700'}`;
			b.style.paddingLeft = (12 + level * 18) + 'px';
			b.innerHTML = `${parentId ? dot(color) : `<span class="shrink-0 text-slate-400">${icon('<path d="M3 10h14M10 3v14"/>', 'w-3.5 h-3.5')}</span>`}<span translate="no" class="flex-1 truncate">${escapeHtml(label)}</span>${current ? `<span class="text-xs">${escapeHtml(_t('Current'))}</span>` : ''}`;
			b.addEventListener('click', () => { if (current) { view = 'list'; render(); return; } view = 'list'; run(() => ops.reparent(tag.id, parentId)); });
			return b;
		};
		body.appendChild(option(_t('Top level'), null, 0));
		const walk = (pid, level) => childrenOf(pid).forEach(t => {
			if (blocked.has(t.id)) return;
			body.appendChild(option(t.name, t.id, level, tagColor(t.id)));
			walk(t.id, level + 1);
		});
		walk(null, 0);
	}

	function renderDelete(body) {
		const tag = TAGS_BY_ID[target];
		if (!tag) { view = 'list'; return renderList(body); }
		const cards = Object.values(rawTiles).filter(t => (t.tag_ids || []).includes(tag.id)).length;
		const kids = childrenOf(tag.id).length;
		body.innerHTML = `<div class="px-4 py-6 text-center">
			<div class="mx-auto mb-3 grid place-items-center w-12 h-12 rounded-full bg-red-50 text-red-500">${icon('<path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/>', 'w-6 h-6')}</div>
			<div class="text-base font-semibold text-slate-800 mb-2">${escapeHtml(_t('Delete “{name}”?', { name: tag.name }))}</div>
			<div class="text-sm text-slate-500 space-y-1">
				${cards ? `<p>${escapeHtml(_t('It will be removed from {n} cards. The cards themselves stay.', { n: cards }))}</p>` : ''}
				${kids ? `<p>${escapeHtml(_t('Its {n} sub-tags will move to the top level.', { n: kids }))}</p>` : ''}
				<p>${escapeHtml(_t("This can't be undone."))}</p>
			</div>
			<div class="mt-5 flex justify-center gap-2">
				<button type="button" data-cancel class="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200">${escapeHtml(_t('Cancel'))}</button>
				<button type="button" data-confirm class="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700">${escapeHtml(_t('Delete'))}</button>
			</div></div>`;
		body.querySelector('[data-cancel]').addEventListener('click', () => { view = 'list'; render(); });
		body.querySelector('[data-confirm]').addEventListener('click', () => { view = 'list'; run(() => ops.remove(tag.id)); });
	}

	function render() {
		const body = $('tagFilterGrid');
		if (!body) return;
		closeMenu();
		const scroll = body.scrollTop;
		body.innerHTML = '';
		$('tagSearchWrap').classList.toggle('hidden', view !== 'list');
		$('tagNewBtn').classList.toggle('invisible', view !== 'list');
		if (view === 'move') renderMove(body);
		else if (view === 'delete') renderDelete(body);
		else renderList(body);
		body.scrollTop = scroll;
	}

	// ---- Row menu ----
	function closeMenu() { $('tagPanel')?.querySelector('[data-tag-menu]')?.remove(); }
	function openMenu(id, anchor) {
		closeMenu();
		const tag = TAGS_BY_ID[id];
		const panel = $('tagPanel');
		const sibs = childrenOf(tag.parent_id);
		const idx = sibs.findIndex(t => t.id === id);
		const menu = document.createElement('div');
		menu.dataset.tagMenu = '';
		menu.setAttribute('role', 'menu');
		menu.className = 'absolute z-30 w-56 rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 p-1.5 text-sm';
		const item = (label, path, fn, opts = {}) => `<button type="button" role="menuitem" data-act="${fn}" ${opts.disabled ? 'disabled' : ''} class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left ${opts.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50'} disabled:opacity-35 disabled:hover:bg-transparent">${icon(path)}<span>${escapeHtml(label)}</span></button>`;
		menu.innerHTML = `
			<div class="px-3 pt-1.5 pb-2"><div class="text-[11px] font-medium text-slate-400 mb-1.5">${escapeHtml(_t('Color'))}</div>
				<div class="flex flex-wrap gap-1.5">
					<button type="button" data-color="" class="w-6 h-6 rounded-full border border-slate-300 grid place-items-center text-slate-400 ${!tag.color ? 'ring-2 ring-offset-1 ring-slate-400' : ''}" title="${escapeHtml(_t('No color'))}" aria-label="${escapeHtml(_t('No color'))}">${icon('<path d="M5 15L15 5"/>', 'w-3 h-3')}</button>
					${COLORS.map(c => `<button type="button" data-color="${c}" class="w-6 h-6 rounded-full ${tag.color === c ? 'ring-2 ring-offset-1 ring-slate-500' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}
				</div></div>
			<div class="my-1 border-t border-slate-100"></div>
			${item(_t('Rename'), '<path d="M4 14.5V16h1.5L14 7.5 12.5 6 4 14.5zM12.5 6L14 4.5 15.5 6 14 7.5"/>', 'rename')}
			${item(_t('Add sub-tag'), '<path d="M10 4v12M4 10h12"/>', 'sub')}
			${item(_t('Move to…'), '<path d="M4 10h11M11 6l4 4-4 4"/>', 'moveTo')}
			${item(_t('Move up'), '<path d="M10 15V5M6 9l4-4 4 4"/>', 'up', { disabled: idx <= 0 })}
			${item(_t('Move down'), '<path d="M10 5v10M6 11l4 4 4-4"/>', 'down', { disabled: idx >= sibs.length - 1 })}
			<div class="my-1 border-t border-slate-100"></div>
			${item(_t('Delete'), '<path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/>', 'delete', { danger: true })}`;
		panel.appendChild(menu);
		// Position under the ⋯ button, kept inside the panel.
		const pr = panel.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
		const mh = menu.offsetHeight;
		let top = ar.bottom - pr.top + 4;
		if (top + mh > pr.height - 8) top = Math.max(8, ar.top - pr.top - mh - 4);
		menu.style.top = top + 'px';
		menu.style.right = Math.max(8, pr.right - ar.right) + 'px';
		menu.addEventListener('click', e => {
			e.stopPropagation();
			const c = e.target.closest('[data-color]');
			if (c) { run(() => ops.color(id, c.dataset.color)); return; }
			const act = e.target.closest('[data-act]')?.dataset.act;
			if (!act) return;
			closeMenu();
			if (act === 'rename') { editingId = id; render(); }
			else if (act === 'sub') { addingUnder = id; render(); }
			else if (act === 'moveTo') { view = 'move'; target = id; render(); }
			else if (act === 'up') run(() => ops.move(id, -1));
			else if (act === 'down') run(() => ops.move(id, 1));
			else if (act === 'delete') { view = 'delete'; target = id; render(); }
		});
		menu.querySelector('button:not([disabled])')?.focus();
	}

	// ---- Open / close ----
	function open() {
		if (!collapsed) {
			// First time: with many tags, start with sub-trees folded.
			collapsed = new Set(TAGS.length > 12 ? TAGS.filter(t => !t.parent_id && childrenOf(t.id).length).map(t => t.id) : []);
			saveCollapsed();
		}
		view = 'list'; editingId = null; addingUnder = undefined;
		const search = $('tagSearch');
		search.value = '';
		search.placeholder = _t('Search tags…');
		$('tagFilterOverlay').classList.remove('hidden');
		render();
		window.track?.('tags_panel_opened', { tags: Math.min(TAGS.length, 50) });
	}
	function close() {
		closeMenu();
		$('tagFilterOverlay').classList.add('hidden');
	}

	window.openTagPanel = open;
	window.closeTagPanel = close;
	refreshTagTree = render; // setTagFilter() re-renders an open panel through this

	document.addEventListener('DOMContentLoaded', wire);
	if (document.readyState !== 'loading') wire();
	let wired = false;
	function wire() {
		if (wired || !$('tagPanel')) return;
		wired = true;
		$('tagSearch').addEventListener('input', () => { if (view === 'list') render(); });
		$('tagSearch').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; render(); } });
		$('tagNewBtn').addEventListener('click', () => { $('tagSearch').value = ''; addingUnder = null; editingId = null; render(); $('tagFilterGrid').scrollTop = 0; });
		$('tagPanel').addEventListener('click', e => { if (!e.target.closest('[data-tag-menu]') && !e.target.closest('[data-menu]')) closeMenu(); });
		document.addEventListener('keydown', e => {
			if (e.key !== 'Escape' || $('tagFilterOverlay').classList.contains('hidden')) return;
			if ($('tagPanel').querySelector('[data-tag-menu]')) { closeMenu(); e.stopPropagation(); return; }
			if (view !== 'list') { view = 'list'; render(); e.stopPropagation(); return; }
			close();
		}, true);
	}
})();
