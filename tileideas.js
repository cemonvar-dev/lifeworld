// Web-researched ideas for newly added tasks. After the user types a new task,
// /api/ai (mode 'ideas') decides whether it's worth looking up (booking a pitch,
// finding a course, planning a trip...) and, if so, searches the web for a few
// concrete options. Most tasks get nothing back, and that's by design.
// Ideas are saved on the task (tasks.ai_ideas, scripts/task-ai-ideas.sql) or,
// until that column exists, in this browser only.
// Uses app.js globals: rawTiles, activeTileId, openTilePopup, tagPath, supa,
// API_BASE, escapeHtml, todayLocal, _t, i18n.
(function () {
	const pending = new Set();
	const LOCAL_KEY = id => 'lw_ideas_' + id;

	function getIdeas(raw) {
		if (!raw) return null;
		if ('ai_ideas' in raw) return raw.ai_ideas || null;
		try { return JSON.parse(localStorage.getItem(LOCAL_KEY(raw.id)) || 'null'); } catch (e) { return null; }
	}

	async function saveIdeas(raw, value) {
		if ('ai_ideas' in raw) {
			raw.ai_ideas = value;
			const { error } = await supa.from('tasks').update({ ai_ideas: value }).eq('id', raw.id);
			if (error) console.error('Saving ideas failed:', error);
			return;
		}
		try { localStorage.setItem(LOCAL_KEY(raw.id), JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
	}

	const popupShows = id => activeTileId === id && !document.getElementById('tileOverlay')?.classList.contains('hidden');

	// Fire-and-forget: called right after the user creates a task.
	async function requestTileIdeas(tileId) {
		const raw = rawTiles[tileId];
		if (!raw || pending.has(tileId) || getIdeas(raw)) return;
		pending.add(tileId);
		if (popupShows(tileId)) render(raw, tileId);
		let result = null;
		try {
			const { data: { session } } = await supa.auth.getSession();
			if (!session) return;
			const tags = (raw.tag_ids || []).map(id => (typeof tagPath === 'function' ? tagPath(id) : '')).filter(Boolean).join(', ');
			const region = (navigator.language || '').split('-')[1];
			const response = await fetch(`${API_BASE}/api/ai`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
				body: JSON.stringify({
					mode: 'ideas',
					name: raw.name,
					tags,
					language: i18n.lang,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					country: region && /^[A-Z]{2}$/.test(region) ? region : undefined,
					today: todayLocal()
				})
			});
			if (response.ok) result = await response.json();
		} catch (e) {
			console.error('Ideas request failed:', e);
		} finally {
			pending.delete(tileId);
		}
		const current = rawTiles[tileId];
		if (!current) return;
		if (result && Array.isArray(result.ideas) && result.ideas.length) {
			await saveIdeas(current, { ideas: result.ideas, tip: result.tip || '', at: new Date().toISOString() });
			window.track?.('task_ideas_found', { count: result.ideas.length });
			if (!popupShows(tileId)) toast(current);
			// App in the background (or closed to the tray): tell them on the phone too.
			if (document.hidden) window.notifyTileIdeas?.(current, result.ideas.length);
		}
		if (popupShows(tileId)) render(current, tileId);
	}

	function toast(raw) {
		document.getElementById('tileIdeasToast')?.remove();
		const t = document.createElement('div');
		t.id = 'tileIdeasToast';
		t.className = 'fixed left-1/2 -translate-x-1/2 bottom-36 sm:bottom-24 z-[9999] flex items-center gap-3 max-w-[calc(100vw-2rem)] bg-violet-50 text-slate-700 border border-violet-200 text-sm rounded-xl shadow-lg shadow-slate-900/10 pl-4 pr-2 py-2';
		t.innerHTML = `<span class="truncate">💡 ${escapeHtml(_t('Fiblia found ideas for'))} <b translate="no">${escapeHtml(raw.name)}</b></span>`;
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'shrink-0 px-3 py-1 rounded-lg font-semibold text-violet-700 hover:bg-violet-100';
		b.textContent = _t('View');
		b.addEventListener('click', () => { t.remove(); openTilePopup(raw.id); window.track?.('task_ideas_opened', { source: 'toast' }); });
		t.appendChild(b);
		document.body.appendChild(t);
		setTimeout(() => t.remove(), 9000);
	}

	function render(raw, tileId) {
		const mount = document.getElementById('tileIdeasMount');
		if (!mount) return;
		if (pending.has(tileId)) {
			mount.innerHTML = `<div class="mt-3 rounded-lg border border-violet-100 bg-violet-50/60 px-3 py-2 text-xs text-violet-600 animate-pulse">💡 Looking for ideas…</div>`;
			return;
		}
		const saved = getIdeas(raw);
		if (!saved || saved.dismissed || !Array.isArray(saved.ideas) || !saved.ideas.length) { mount.innerHTML = ''; return; }
		const button = 'px-3 py-1.5 rounded-lg text-xs font-semibold transition disabled:opacity-50';
		const item = i => {
			const title = escapeHtml(i.title);
			const head = i.url
				? `<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-violet-700 hover:underline">${title} ↗</a>`
				: `<span class="font-semibold text-slate-700">${title}</span>`;
			return `<li class="py-1.5">${head}${i.detail ? `<div class="text-xs text-slate-600 mt-0.5">${escapeHtml(i.detail)}</div>` : ''}</li>`;
		};
		mount.innerHTML = `<div class="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3">
			<div class="text-xs font-semibold text-violet-700 mb-1">💡 Ideas from the web</div>
			<ul translate="no" class="text-sm divide-y divide-violet-100">${saved.ideas.map(item).join('')}</ul>
			${saved.tip ? `<div translate="no" class="text-xs text-slate-500 mt-1 italic">${escapeHtml(saved.tip)}</div>` : ''}
			<div class="flex flex-wrap gap-2 mt-2">
				${'notes' in raw ? `<button type="button" data-ideas-notes class="${button} bg-violet-100 text-violet-700 hover:bg-violet-200">Add to notes</button>` : ''}
				<button type="button" data-ideas-hide class="${button} text-slate-500 hover:bg-violet-100">Hide</button>
			</div>
			<div class="text-[10px] text-slate-400 mt-1">AI-generated from web results; check details before booking.</div>
		</div>`;
		mount.querySelector('[data-ideas-hide]').addEventListener('click', async () => {
			await saveIdeas(raw, { ...saved, dismissed: true });
			window.track?.('task_ideas_hidden');
			render(raw, tileId);
		});
		mount.querySelector('[data-ideas-notes]')?.addEventListener('click', async e => {
			const btn = e.currentTarget;
			btn.disabled = true;
			const lines = saved.ideas.map(i => `• ${i.title}${i.url ? ' — ' + i.url : ''}`).join('\n');
			const notes = (raw.notes ? raw.notes.trimEnd() + '\n\n' : '') + lines;
			const { error } = await supa.from('tasks').update({ notes }).eq('id', tileId);
			if (error) { btn.disabled = false; return; }
			raw.notes = notes;
			const input = document.getElementById('tileNotesInput');
			if (input && activeTileId === tileId) input.value = notes;
			window.track?.('task_ideas_to_notes');
			btn.textContent = _t('Added ✓');
		});
	}

	window.requestTileIdeas = requestTileIdeas;
	window.renderTileIdeas = render;
})();
