// Tags in the tile detail: chips with color + path, a "Section" marker on the
// first tag (it decides the gallery section), and an inline picker with search,
// recent tags, the full tree and "create". Uses app.js globals: rawTiles, tiles,
// TAGS, TAGS_BY_ID, tagPath, rebuildTagIndex, applyFilters, updateTask, supa,
// currentUserId, escapeHtml, _t, openTagFilterPopup.
(function () {
	const RECENT_KEY = 'lw_recent_tags';
	let open = false, query = '', menuFor = null, justOpened = false;
	const lc = s => String(s || '').toLocaleLowerCase();
	const color = id => (window.tagColor ? window.tagColor(id) : '');
	const dot = id => { const c = color(id); return c ? `<span class="shrink-0 w-2 h-2 rounded-full" style="background:${c}"></span>` : '<span class="shrink-0 w-2 h-2 rounded-full border border-slate-300"></span>'; };
	const recent = () => { try { return (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter(id => TAGS_BY_ID[id]); } catch (e) { return []; } };
	const remember = id => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter(x => x !== id)].slice(0, 8))); } catch (e) {} };

	function pathHtml(id, q) {
		const parts = tagPath(id).split(' › ');
		const leaf = parts.pop();
		const mark = s => { const i = q ? lc(s).indexOf(q) : -1; return i < 0 ? escapeHtml(s) : escapeHtml(s.slice(0, i)) + `<mark class="bg-amber-100 text-inherit rounded px-0.5">${escapeHtml(s.slice(i, i + q.length))}</mark>` + escapeHtml(s.slice(i + q.length)); };
		return `${parts.length ? `<span class="text-slate-400">${parts.map(mark).join(' › ')} › </span>` : ''}<span class="font-semibold text-slate-700">${mark(leaf)}</span>`;
	}

	async function setTags(tileId, next) {
		const raw = rawTiles[tileId];
		const prev = raw.tag_ids || [];
		raw.tag_ids = next;
		const t = tiles.find(x => x.id === tileId);
		if (t) t.tags = [...next];
		applyFilters();
		render(tileId);
		try { await updateTask(tileId, { tag_ids: next }); }
		catch (e) { raw.tag_ids = prev; if (t) t.tags = [...prev]; applyFilters(); render(tileId); }
	}
	const add = (tileId, id) => { const cur = rawTiles[tileId].tag_ids || []; if (!cur.includes(id)) { remember(id); setTags(tileId, [...cur, id]); window.track?.('tile_tag_added', { source: 'chips' }); } };
	const remove = (tileId, id) => setTags(tileId, (rawTiles[tileId].tag_ids || []).filter(x => x !== id));
	const makeSection = (tileId, id) => { const cur = rawTiles[tileId].tag_ids || []; setTags(tileId, [id, ...cur.filter(x => x !== id)]); window.track?.('tile_section_changed'); };

	// Creates "family/defne/okul" level by level, reusing levels that exist.
	async function createPath(text) {
		const parts = String(text).split(/\s*(?:›|>|\/)\s*/).map(s => s.trim()).filter(Boolean).slice(0, 6);
		let parent = null;
		for (const name of parts) {
			const hit = TAGS.find(t => (t.parent_id || null) === parent && lc(t.name) === lc(name));
			if (hit) { parent = hit.id; continue; }
			const sibs = TAGS.filter(t => (t.parent_id || null) === parent);
			const { data, error } = await supa.from('tags').insert({ user_id: currentUserId, name: name.slice(0, 60), ...(parent ? { parent_id: parent } : {}), sort_order: sibs.length }).select().single();
			if (error || !data) throw error || new Error('create failed');
			if (!TAGS.some(t => t.id === data.id)) TAGS.push(data);
			rebuildTagIndex();
			parent = data.id;
		}
		window.track?.('tag_created', { nested: parts.length > 1, source: 'chips' });
		return parent;
	}

	function pickerHtml(tileId) {
		const sel = new Set(rawTiles[tileId].tag_ids || []);
		const q = lc(query.trim());
		const row = id => `<button type="button" data-pick="${id}" class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-sm hover:bg-slate-50 ${sel.has(id) ? 'bg-blue-50' : ''}">
			<span class="shrink-0 w-4 text-center text-blue-600 font-bold">${sel.has(id) ? '✓' : ''}</span>${dot(id)}<span translate="no" class="truncate">${pathHtml(id, q)}</span></button>`;
		const all = TAGS.map(t => t.id).sort((a, b) => tagPath(a).localeCompare(tagPath(b)));
		const matches = q ? all.filter(id => lc(tagPath(id)).includes(q)) : all;
		const rec = q ? [] : recent().slice(0, 5);
		const exact = q && TAGS.some(t => lc(tagPath(t.id)) === q.replace(/\s*(?:>|\/)\s*/g, ' › ') || lc(t.name) === q);
		const section = (title, ids) => ids.length ? `<div class="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(title)}</div>${ids.map(row).join('')}` : '';
		return `<div data-picker class="mt-2 rounded-xl border border-slate-200 bg-white shadow-sm">
			<div class="p-2 border-b border-slate-100 flex items-center gap-2">
				<input data-picker-q type="search" autocomplete="off" value="${escapeHtml(query)}" placeholder="${escapeHtml(_t('Search or create…'))}" class="flex-1 min-w-0 h-9 px-3 rounded-lg bg-slate-100 text-sm focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-200" />
				<button type="button" data-picker-done class="shrink-0 h-9 px-3 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100">${escapeHtml(_t('Close'))}</button>
			</div>
			<div class="max-h-60 overflow-y-auto overscroll-contain p-1">
				${q && !exact ? `<button type="button" data-create class="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-sm font-medium text-blue-700 hover:bg-blue-50"><span class="shrink-0 w-4 text-center">＋</span><span class="truncate">${escapeHtml(_t('Create “{name}”', { name: query.trim() }))}</span></button>` : ''}
				${section(_t('Recent'), rec)}
				${section(q ? _t('Matches') : _t('All tags'), matches)}
				${!TAGS.length && !q ? `<div class="px-3 py-4 text-sm text-slate-400">${escapeHtml(_t('No tags yet. Type a name to create one.'))}</div>` : ''}
			</div>
			<div class="border-t border-slate-100 px-2 py-1.5"><button type="button" data-manage class="text-xs font-semibold text-slate-500 hover:text-blue-600">${escapeHtml(_t('Manage tags'))} →</button></div>
		</div>`;
	}

	function render(tileId) {
		const mount = document.getElementById('tileTagChips');
		const raw = rawTiles[tileId];
		if (!mount || !raw) return;
		const ids = (raw.tag_ids || []).filter(id => TAGS_BY_ID[id]);
		const focused = document.activeElement && document.activeElement.matches('[data-picker-q]');
		const chip = (id, i) => `<span class="group inline-flex items-center gap-1.5 max-w-full pl-2.5 pr-1 py-1 rounded-full border ${i === 0 && ids.length > 1 ? 'border-blue-200 bg-blue-50/60' : 'border-slate-200 bg-white'} text-xs">
			<button type="button" data-chip="${id}" class="inline-flex items-center gap-1.5 min-w-0" title="${escapeHtml(tagPath(id))}">${dot(id)}<span translate="no" class="truncate">${pathHtml(id, '')}</span></button>
			${i === 0 && ids.length > 1 ? `<span class="shrink-0 px-1.5 py-px rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700" title="${escapeHtml(_t('Decides which gallery section the card appears in'))}">${escapeHtml(_t('Section'))}</span>` : ''}
			<button type="button" data-remove="${id}" class="shrink-0 grid place-items-center w-5 h-5 rounded-full text-slate-400 hover:text-red-600 hover:bg-red-50" aria-label="${escapeHtml(_t('Remove tag'))}">&times;</button>
		</span>`;
		mount.innerHTML = `<div class="flex flex-wrap items-center gap-1.5">
				${ids.map(chip).join('')}
				<button type="button" data-open-picker class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed ${open ? 'border-blue-400 text-blue-700 bg-blue-50' : 'border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600'} text-xs font-semibold">＋ ${escapeHtml(_t('Add tag'))}</button>
			</div>
			${menuFor && ids.includes(menuFor) && ids[0] !== menuFor ? `<div class="mt-1.5 flex items-center gap-2 text-xs"><button type="button" data-section="${menuFor}" class="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 font-semibold hover:bg-blue-100">${escapeHtml(_t('Show in this section'))}</button><span class="text-slate-400 truncate" translate="no">${escapeHtml(tagPath(menuFor))}</span></div>` : ''}
			${open ? pickerHtml(tileId) : ''}`;
		const q = mount.querySelector('[data-picker-q]');
		if (q) {
			q.addEventListener('input', () => { query = q.value; const pos = q.selectionStart; render(tileId); const n = mount.querySelector('[data-picker-q]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
			q.addEventListener('keydown', async e => {
				if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open = false; query = ''; render(tileId); return; }
				if (e.key === 'Enter' && !e.isComposing) {
					e.preventDefault();
					const first = mount.querySelector('[data-pick], [data-create]');
					if (first) first.click();
				}
				if (e.key === 'Backspace' && !q.value) { const cur = rawTiles[tileId].tag_ids || []; if (cur.length) remove(tileId, cur[cur.length - 1]); }
			});
			if (focused || justOpened) setTimeout(() => q.focus(), 0);
			justOpened = false;
		}
	}

	function wire(tileId) {
		const mount = document.getElementById('tileTagChips');
		if (!mount || mount.dataset.wired) return;
		mount.dataset.wired = '1';
		mount.addEventListener('click', async e => {
			e.stopPropagation();
			const t = e.target;
			const pick = t.closest('[data-pick]');
			if (pick) { const id = pick.dataset.pick; (rawTiles[tileId].tag_ids || []).includes(id) ? remove(tileId, id) : add(tileId, id); query = ''; return; }
			const rm = t.closest('[data-remove]');
			if (rm) { menuFor = null; remove(tileId, rm.dataset.remove); return; }
			const ch = t.closest('[data-chip]');
			if (ch) { menuFor = menuFor === ch.dataset.chip ? null : ch.dataset.chip; render(tileId); return; }
			const sec = t.closest('[data-section]');
			if (sec) { menuFor = null; makeSection(tileId, sec.dataset.section); return; }
			if (t.closest('[data-open-picker]')) { open = !open; query = ''; justOpened = open; render(tileId); return; }
			if (t.closest('[data-picker-done]')) { open = false; query = ''; render(tileId); return; }
			if (t.closest('[data-manage]')) { open = false; if (window.closeTilePopup) closeTilePopup(); openTagFilterPopup(); return; }
			if (t.closest('[data-create]')) {
				const text = query.trim();
				if (!text) return;
				try { const id = await createPath(text); query = ''; add(tileId, id); }
				catch (err) { console.error('Create tag failed:', err); }
			}
		});
	}

	// Called by openTilePopup after it renders.
	window.mountTileTagChips = function (tileId) {
		if (window.__chipsTile !== tileId) { open = false; query = ''; menuFor = null; window.__chipsTile = tileId; }
		wire(tileId);
		render(tileId);
	};
})();
