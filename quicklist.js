// Quick lists: a fresh board for a meeting or a brain dump. Creating a list
// makes a tag and filters to it; while any tag is selected, a typing bar adds
// tiles to it without opening the tile popup.
(function () {
	let modal = null;

	function todayPrefix() {
		const d = new Date();
		return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} `;
	}

	function showOnly(tagId, pinnedOnly = false) {
		activePinnedFilter = pinnedOnly;
		searchChips = [];
		const searchBox = document.getElementById('searchBox');
		if (searchBox) searchBox.value = '';
		activeTimelineFilter = null;
		activeStatusFilter = null;
		activeLifecycleFilter = 'active';
		activeMoodFilter = null;
		activeFreqFilter = null;
		syncLifecycleBtn();
		syncTodayBtn();
		syncStatusBtn();
		setTagFilter(tagId);
	}

	function exitList() {
		activePinnedFilter = false;
		searchChips = [];
		activeTimelineFilter = 'today';
		activeStatusFilter = 'noaction';
		activeLifecycleFilter = 'active';
		syncLifecycleBtn();
		syncTodayBtn();
		syncStatusBtn();
		setTagFilter(null);
	}

	async function createList(name) {
		const { data, error } = await supa.from('tags').insert({ user_id: currentUserId, name }).select().single();
		if (error || !data) throw error || new Error('tag insert failed');
		TAGS.push(data);
		rebuildTagIndex();
		window.track?.('list_created');
		return data;
	}

	function openNewList() {
		if (!modal) {
			modal = document.createElement('div');
			modal.id = 'newListOverlay';
			modal.className = 'fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-4';
			modal.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="newListTitle" class="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6">
				<div id="newListTitle" class="text-lg font-semibold text-slate-700 mb-3">📝 New list</div>
				<input id="newListName" type="text" maxlength="100" aria-label="List name" placeholder="List name" class="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-300" />
				<div id="newListError" class="hidden mt-1 text-xs text-red-500">That didn't save. Please try again.</div>
				<div class="flex justify-end gap-2 mt-4">
					<button type="button" data-list-cancel class="px-4 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:bg-slate-100 transition">Cancel</button>
					<button type="button" id="newListCreate" class="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition disabled:opacity-50">Create list</button>
				</div>
			</div>`;
			document.body.appendChild(modal);
			const input = modal.querySelector('#newListName');
			const button = modal.querySelector('#newListCreate');
			const close = () => modal.classList.add('hidden');
			const submit = async () => {
				const name = input.value.trim();
				if (!name) { input.focus(); return; }
				button.disabled = true;
				try {
					const tag = await createList(name);
					close();
					showOnly(tag.id);
					document.getElementById('quickAddInput')?.focus();
				} catch (e) {
					console.error('List create error:', e);
					modal.querySelector('#newListError').classList.remove('hidden');
				}
				button.disabled = false;
			};
			button.addEventListener('click', submit);
			input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
			modal.querySelector('[data-list-cancel]').addEventListener('click', close);
			modal.addEventListener('click', e => { if (e.target === modal) close(); });
		}
		const input = modal.querySelector('#newListName');
		input.value = todayPrefix();
		modal.querySelector('#newListError').classList.add('hidden');
		modal.classList.remove('hidden');
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	async function quickAdd(input, tagId, pinned) {
		const name = input.value.trim();
		if (!name) return;
		const error = document.getElementById('quickAddError');
		input.value = '';
		// Undated one-time tasks: make sure the view isn't hiding them.
		if (activeTimelineFilter || activeStatusFilter) {
			activeTimelineFilter = null;
			activeStatusFilter = null;
			syncTodayBtn();
			syncStatusBtn();
			updateFilterBar();
		}
		const created = await createTileByName(name, 'once', { tagIds: tagId ? [tagId] : [], pinned, endDate: null, open: false });
		if (!created) {
			input.value = name;
			error?.classList.remove('hidden');
			return;
		}
		error?.classList.add('hidden');
		window.track?.('task_created', { frequency: 'once', source: 'quick_list' });
		input.focus();
	}

	// Free-form notes for a list, saved on the tag, plus AI to pull tasks out of them.
	function wireListNotes(bar, tagId) {
		const area = bar.querySelector('#quickNotes');
		if (!area) return;
		const tag = TAGS_BY_ID[tagId];
		const status = bar.querySelector('[data-notes-status]');
		const aiButton = bar.querySelector('[data-notes-ai]');
		area.value = tag.notes || '';
		const syncButton = () => { aiButton.disabled = !area.value.trim(); };
		syncButton();
		let timer;
		const save = async () => {
			clearTimeout(timer);
			const text = area.value;
			if (text === (tag.notes || '')) return true;
			const { error } = await supa.from('tags').update({ notes: text || null }).eq('id', tagId);
			if (error) {
				console.error('List notes save error:', error);
				status.textContent = _t("Couldn't save your notes. Please try again.");
				status.className = 'text-[11px] text-red-500';
				return false;
			}
			tag.notes = text || null;
			status.textContent = _t('Saved');
			status.className = 'text-[11px] text-slate-400';
			return true;
		};
		area.addEventListener('input', () => { syncButton(); clearTimeout(timer); timer = setTimeout(save, 700); });
		area.addEventListener('blur', save);
		aiButton.addEventListener('click', async () => {
			const notes = area.value.trim();
			if (!notes) return;
			await save();
			window.track?.('list_notes_to_tasks');
			openAiChat();
			sendAiMessage(_t('Turn these meeting notes into tasks for the list "{name}". Only include real action items. Make them one-time tasks without a date unless the notes give one.', { name: tag.name }) + '\n\n' + notes.slice(0, 7000), { listTag: tag.name });
		});
	}

	// Called on every gallery render; keeps the bar (and what's typed) in place.
	window.openPinnedList = function () {
		showOnly(null, true);
		window.track?.('list_opened', { source: 'pinned' });
	};

	window.openTagList = function (tagId) {
		showOnly(tagId);
		window.track?.('list_opened', { source: 'heading' });
	};

	window.refreshQuickAdd = function () {
		const gallery = document.getElementById('gallery');
		if (!gallery) return;
		let bar = document.getElementById('quickAddBar');
		const pinnedMode = activePinnedFilter;
		const tagId = !pinnedMode && activeTagFilter && activeTagFilter !== '__untagged__' ? activeTagFilter : null;
		if (!pinnedMode && !tagId) { bar?.remove(); return; }
		const barKey = pinnedMode ? '__pinned__' : tagId;
		const count = pinnedMode ? tiles.filter(t => rawTiles[t.id] && rawTiles[t.id].pinned).length : tiles.filter(t => (t.tags || []).includes(tagId)).length;
		if (bar && bar.dataset.tag === barKey) {
			bar.querySelector('[data-quick-count]').textContent = _t('{n} tasks', { n: count });
			return;
		}
		bar?.remove();
		bar = document.createElement('section');
		bar.id = 'quickAddBar';
		bar.dataset.tag = barKey;
		bar.className = 'mt-4 rounded-2xl bg-white/90 border border-slate-200/80 shadow-sm p-3';
		bar.innerHTML = `<div class="flex items-center justify-between gap-2 mb-2">
				<div class="min-w-0 flex items-baseline gap-2">${pinnedMode ? `<span class="text-base font-semibold text-slate-800 truncate">📌 ${escapeHtml(_t('Pinned'))}</span>` : `<span translate="no" class="text-base font-semibold text-slate-800 truncate">📝 ${escapeHtml(tagPath(tagId))}</span>`}<span data-quick-count class="text-xs text-slate-400 whitespace-nowrap">${escapeHtml(_t('{n} tasks', { n: count }))}</span></div>
				<button type="button" data-quick-exit class="shrink-0 px-3 py-1 rounded-full text-xs font-semibold text-slate-500 bg-slate-100 hover:bg-slate-200 transition">Exit list</button>
			</div>
			<input id="quickAddInput" type="text" maxlength="200" placeholder="Add a task and press Enter" aria-label="Add a task and press Enter" class="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-300" />
			<div id="quickAddError" class="hidden mt-1 text-xs text-red-500">That didn't save. Please try again.</div>
			${!pinnedMode && 'notes' in (TAGS_BY_ID[tagId] || {}) ? `<div class="mt-3">
				<div class="flex items-center justify-between mb-1"><span class="text-xs font-semibold text-slate-500">Meeting notes</span><span data-notes-status class="text-[11px] text-slate-400"></span></div>
				<textarea id="quickNotes" rows="4" maxlength="10000" placeholder="Write notes here…" class="w-full shrink-0 rounded-lg border px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-300"></textarea>
				<div class="flex justify-end mt-2"><button type="button" data-notes-ai class="px-3 py-1.5 rounded-full text-xs font-semibold text-white bg-gradient-to-r from-purple-500 to-fuchsia-500 hover:opacity-90 transition disabled:opacity-40">${AI_ICON} Turn notes into tasks</button></div>
			</div>` : ''}`;
		const anchor = document.getElementById('gettingStarted') ? document.getElementById('gettingStarted').nextSibling : gallery;
		gallery.parentNode.insertBefore(bar, anchor);
		const input = bar.querySelector('#quickAddInput');
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); quickAdd(input, tagId, pinnedMode); }
		});
		bar.querySelector('[data-quick-exit]').addEventListener('click', exitList);
		if (tagId) wireListNotes(bar, tagId);
	};

	document.addEventListener('DOMContentLoaded', () => {
		document.getElementById('newListBtn')?.addEventListener('click', () => {
			closeCalendarMenu();
			openNewList();
		});
	});
})();
