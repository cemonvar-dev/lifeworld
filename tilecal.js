// Day-by-day history for a tile: the month calendar in the tile detail (tap a
// day to log it) and the 14-day strip on "Business" cards. Uses app.js globals:
// rawTiles, tiles, logDay, todayLocal, isTaskScheduledOnDate, calMarkStatus,
// calculateHealth, healthToPlant, applyFilters, scheduleReminders, supa,
// openTilePopup, openAddLogPopup, logDatePicker, escapeHtml, _t, i18n.
(function () {
	const VIEW_KEY = 'lw_tile_view';
	const pad = n => String(n).padStart(2, '0');
	const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
	const locale = () => (window.i18n && i18n.lang) || undefined;

	// Latest done/skip status per day (logs are newest-first).
	function statusByDay(raw) {
		const out = {};
		(raw.task_logs || []).forEach(l => {
			if (l.status !== 'done' && l.status !== 'completed' && l.status !== 'skipped') return;
			const d = logDay(l);
			if (d && !(d in out)) out[d] = l.status === 'skipped' ? 'skipped' : 'done';
		});
		return out;
	}

	// 'done' | 'skipped' | 'missed' | 'open' (today, due, nothing yet) | 'due' (future) | 'none'
	function dayState(raw, day, byDay, today) {
		if (byDay[day]) return byDay[day];
		const created = raw.created_at ? keyOf(new Date(raw.created_at)) : '';
		if (created && day < created) return 'none';
		if (!isTaskScheduledOnDate(raw, parse(day))) return 'none';
		if (day > today) return 'due';
		return day === today ? 'open' : 'missed';
	}
	window.tileDayState = (tileId, day) => { const raw = rawTiles[tileId]; return raw ? dayState(raw, day, statusByDay(raw), todayLocal()) : 'none'; };

	// ---- 14-day strip (Business cards) ----
	const STRIP_CLASS = {
		done: 'bg-emerald-500', skipped: 'bg-slate-300', missed: 'bg-red-100 ring-1 ring-inset ring-red-300',
		open: 'bg-white ring-1 ring-inset ring-blue-400', due: 'bg-slate-100', none: 'bg-slate-100/60'
	};
	window.tileHistoryStrip = function (tileId, days = 14) {
		const raw = rawTiles[tileId];
		if (!raw) return '';
		const byDay = statusByDay(raw), today = todayLocal();
		const cells = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(); d.setDate(d.getDate() - i);
			const k = keyOf(d), st = dayState(raw, k, byDay, today);
			const label = { done: _t('Done'), skipped: _t('Skipped'), missed: _t('Missed'), open: _t('Today') }[st] || '';
			cells.push(`<span class="flex-1 h-2.5 rounded-[3px] ${STRIP_CLASS[st]}" title="${escapeHtml(d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) + (label ? ' · ' + label : ''))}"></span>`);
		}
		return `<div class="w-full flex gap-[3px]" aria-hidden="true">${cells.join('')}</div>`;
	};

	// ---- Month calendar (tile detail) ----
	let monthOffset = 0, forTile = null;
	const getView = () => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'calendar'; } catch (e) { return 'calendar'; } };
	const setView = v => { try { localStorage.setItem(VIEW_KEY, v); } catch (e) {} };

	const CELL = {
		done: 'bg-emerald-500 text-white font-semibold hover:bg-emerald-600',
		skipped: 'bg-slate-200 text-slate-600 hover:bg-slate-300',
		missed: 'bg-red-50 text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-100',
		open: 'text-blue-700 font-semibold hover:bg-blue-50',
		due: 'text-slate-700',
		none: 'text-slate-400 hover:bg-slate-50'
	};

	function refreshPopup(tileId) {
		const body = document.getElementById('popupBody');
		const top = body ? body.scrollTop : 0;
		openTilePopup(tileId);
		if (body) body.scrollTop = top;
	}

	async function clearDay(tileId, day) {
		const raw = rawTiles[tileId];
		const hits = (raw.task_logs || []).filter(l => logDay(l) === day && ['done', 'skipped', 'completed'].includes(l.status));
		for (const l of hits) {
			const { error } = await supa.from('task_logs').delete().eq('id', l.id);
			if (error) { console.error('Clear day error:', error); return; }
		}
		raw.task_logs = raw.task_logs.filter(l => !hits.includes(l));
		const dt = tiles.find(t => t.id === tileId);
		if (dt) {
			dt.count = raw.task_logs.length;
			if (day === todayLocal()) dt.status = 'noaction';
			const health = calculateHealth(raw), plant = healthToPlant(health);
			Object.assign(dt, { health, emoji: plant.emoji, healthLabel: plant.label, healthColor: plant.color });
		}
		applyFilters();
		scheduleReminders();
	}

	function closeDayMenu() { document.querySelector('[data-cal-menu]')?.remove(); }

	function openDayMenu(tileId, day, cell, mount) {
		closeDayMenu();
		const raw = rawTiles[tileId];
		const st = statusByDay(raw)[day];
		const log = (raw.task_logs || []).find(l => logDay(l) === day && ['done', 'skipped', 'completed'].includes(l.status));
		const menu = document.createElement('div');
		menu.dataset.calMenu = '';
		menu.className = 'absolute z-20 w-48 rounded-xl bg-white shadow-xl ring-1 ring-slate-200 p-1.5 text-sm';
		const btn = (act, label, cls = '') => `<button type="button" data-cal-act="${act}" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-slate-50 ${cls}">${label}</button>`;
		menu.innerHTML = `<div class="px-3 pt-1 pb-1.5 text-[11px] font-medium text-slate-400">${escapeHtml(parse(day).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
			${st !== 'done' ? btn('done', `✅ ${escapeHtml(_t('Done'))}`) : ''}
			${st !== 'skipped' ? btn('skipped', `⏭️ ${escapeHtml(_t('Skip'))}`) : ''}
			${btn('note', `📝 ${escapeHtml(log ? _t('Edit note') : _t('Add with note'))}`)}
			${st ? btn('clear', `↺ ${escapeHtml(_t('Clear'))}`, 'text-slate-500') : ''}`;
		mount.appendChild(menu);
		const mr = mount.getBoundingClientRect(), cr = cell.getBoundingClientRect();
		let left = cr.left - mr.left + cr.width / 2 - 96;
		left = Math.max(0, Math.min(left, mr.width - 192));
		let top = cr.bottom - mr.top + 4;
		if (top + menu.offsetHeight > mr.height + 40) top = cr.top - mr.top - menu.offsetHeight - 4;
		menu.style.left = left + 'px';
		menu.style.top = top + 'px';
		menu.addEventListener('click', async e => {
			e.stopPropagation();
			const act = e.target.closest('[data-cal-act]')?.dataset.calAct;
			if (!act) return;
			closeDayMenu();
			if (act === 'done' || act === 'skipped') {
				await calMarkStatus(tileId, day, act);
				window.track?.(act === 'done' ? 'task_completed' : 'task_skipped', { source: 'tile_calendar' });
				refreshPopup(tileId);
			} else if (act === 'clear') {
				await clearDay(tileId, day);
				window.track?.('log_cleared', { source: 'tile_calendar' });
				refreshPopup(tileId);
			} else if (act === 'note') {
				if (log) openAddLogPopup(log);
				else { openAddLogPopup(); try { logDatePicker && logDatePicker.setDate([day], true); } catch (err) {} }
			}
		});
	}

	function renderCalendar(tileId, mount) {
		const raw = rawTiles[tileId];
		if (!raw) return;
		const byDay = statusByDay(raw), today = todayLocal();
		const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + monthOffset);
		const y = base.getFullYear(), m = base.getMonth();
		const first = new Date(y, m, 1), daysIn = new Date(y, m + 1, 0).getDate();
		const lead = (first.getDay() + 6) % 7; // Monday first
		const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'narrow' }));
		const counts = { done: 0, skipped: 0, missed: 0 };
		let cells = '';
		for (let i = 0; i < lead; i++) cells += '<span></span>';
		for (let d = 1; d <= daysIn; d++) {
			const k = `${y}-${pad(m + 1)}-${pad(d)}`;
			const st = dayState(raw, k, byDay, today);
			if (counts[st] != null) counts[st]++;
			const future = k > today;
			const isToday = k === today;
			cells += `<button type="button" data-day="${k}" ${future ? 'disabled' : ''} class="relative h-9 rounded-lg text-[13px] tabular-nums transition ${CELL[st]} ${isToday ? 'ring-2 ring-blue-500 ring-offset-1' : ''} ${future ? 'cursor-default' : ''}">${d}${st === 'due' ? '<span class="absolute left-1/2 -translate-x-1/2 bottom-1 w-1 h-1 rounded-full bg-blue-400"></span>' : ''}</button>`;
		}
		const title = first.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
		const navBtn = (dir, path, label) => `<button type="button" data-nav="${dir}" class="grid place-items-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100" aria-label="${escapeHtml(label)}"><svg class="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></button>`;
		mount.innerHTML = `<div class="relative select-none">
			<div class="flex items-center gap-1 mb-1">
				${navBtn(-1, 'M12 5l-5 5 5 5', _t('Previous month'))}
				<div class="flex-1 text-center text-sm font-semibold text-slate-700 capitalize">${escapeHtml(title)}</div>
				${monthOffset !== 0 ? `<button type="button" data-nav="0" class="px-2 h-7 rounded-lg text-[11px] font-semibold text-blue-600 hover:bg-blue-50">${escapeHtml(_t('Today'))}</button>` : ''}
				${navBtn(1, 'M8 5l5 5-5 5', _t('Next month'))}
			</div>
			<div class="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase text-slate-400 mb-1">${weekdays.map(w => `<span>${escapeHtml(w)}</span>`).join('')}</div>
			<div class="grid grid-cols-7 gap-1">${cells}</div>
			<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
				<span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-emerald-500"></span>${counts.done} ${escapeHtml(_t('Done'))}</span>
				<span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-slate-200"></span>${counts.skipped} ${escapeHtml(_t('Skipped'))}</span>
				<span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-red-50 ring-1 ring-inset ring-red-200"></span>${counts.missed} ${escapeHtml(_t('Missed'))}</span>
				<span class="ml-auto text-slate-400">${escapeHtml(_t('Tap a day to log it'))}</span>
			</div>
		</div>`;
		const box = mount.firstElementChild;
		box.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', e => {
			e.stopPropagation();
			const dir = Number(b.dataset.nav);
			monthOffset = dir === 0 ? 0 : monthOffset + dir;
			renderCalendar(tileId, mount);
		}));
		box.querySelectorAll('[data-day]:not([disabled])').forEach(c => c.addEventListener('click', e => {
			e.stopPropagation();
			openDayMenu(tileId, c.dataset.day, c, box);
		}));
		box.addEventListener('click', e => { if (!e.target.closest('[data-cal-menu]')) closeDayMenu(); });
	}

	// Called by openTilePopup after it renders the Timeline tab.
	window.mountTileCalendar = function (tileId) {
		const mount = document.getElementById('tileCalendarMount');
		const list = document.getElementById('tileTimelineList');
		const sw = document.getElementById('tlViewSwitch');
		if (!mount || !list || !sw) return;
		if (forTile !== tileId) { forTile = tileId; monthOffset = 0; }
		const apply = () => {
			const v = getView();
			mount.classList.toggle('hidden', v !== 'calendar');
			list.classList.toggle('hidden', v !== 'list');
			sw.querySelectorAll('[data-tlview]').forEach(b => {
				const on = b.dataset.tlview === v;
				b.classList.toggle('bg-white', on); b.classList.toggle('shadow-sm', on); b.classList.toggle('text-slate-800', on);
				b.classList.toggle('text-slate-500', !on);
				b.setAttribute('aria-pressed', String(on));
			});
			if (v === 'calendar') renderCalendar(tileId, mount);
		};
		sw.querySelectorAll('[data-tlview]').forEach(b => b.addEventListener('click', () => { setView(b.dataset.tlview); apply(); }));
		apply();
	};

	// ---- "Business" card body (Settings → Card style) ----
	// Keeps the classes app.js wires up: .tile-pin, .quick-done, .quick-skip, .line-clamp-3.
	window.businessTileHtml = function (tile, ctx) {
		const raw = rawTiles[tile.id] || {};
		const groupColor = ctx.groupTag && ctx.groupTag !== PINNED_GROUP && ctx.groupTag !== 'Untagged' && window.tagColor ? tagColor(ctx.groupTag) : '';
		const color = groupColor || ((tile.tags || [])[0] && window.tagColor ? tagColor(tile.tags[0]) : '') || '#cbd5e1';
		const once = (raw.frequency_mode || 'daily') === 'once';
		let status;
		if (ctx.tp.finished) status = { label: ctx.tp.label, cls: 'bg-slate-100 text-slate-600' };
		else if (tile.health >= 70) status = { label: _t('On track'), cls: 'bg-emerald-50 text-emerald-700' };
		else if (tile.health >= 40) status = { label: _t('At risk'), cls: 'bg-amber-50 text-amber-700' };
		else status = { label: _t('Off track'), cls: 'bg-red-50 text-red-700' };
		const btnCls = on => `flex-1 h-8 rounded-lg text-xs font-semibold transition ${on ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`;
		const due = once && raw.end_date ? parse(raw.end_date).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : '';
		return `
			<span class="absolute left-0 top-3 bottom-3 w-1 rounded-r-full" style="background:${color}" aria-hidden="true"></span>
			<button type="button" class="tile-pin absolute top-2 right-2 z-10 w-7 h-7 rounded-full flex items-center justify-center text-xs transition ${ctx.isPinned ? 'bg-amber-100 ring-1 ring-amber-300' : 'text-slate-300 hover:bg-slate-100 grayscale opacity-60 hover:opacity-100'}" title="${ctx.isPinned ? 'Unpin' : 'Pin to top'}" aria-label="${ctx.isPinned ? 'Unpin tile' : 'Pin tile to top'}" aria-pressed="${ctx.isPinned}">📌</button>
			<div translate="no" class="text-sm font-semibold text-slate-800 text-left w-full line-clamp-3 pr-7 leading-snug">${escapeHtml(tile.name)}</div>
			<div class="w-full flex items-center gap-2">
				<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${status.cls}">${escapeHtml(status.label)}</span>
				${ctx.tp.finished || once ? '' : `<span class="ml-auto text-[11px] font-medium tabular-nums text-slate-400">${tile.health}%</span>`}
			</div>
			${once ? `<div class="w-full text-[11px] text-slate-500">📅 ${escapeHtml(due || _t('No date'))}</div>` : window.tileHistoryStrip(tile.id)}
			<div class="w-full flex items-center justify-between gap-2 text-[11px] text-slate-500">
				<span class="whitespace-nowrap ${ctx.nextDueClass}">🔔 ${ctx.nextDue}</span>
				<span class="whitespace-nowrap text-slate-400" title="Last done">✓ ${ctx.lastDone}</span>
			</div>
			<div class="flex gap-2 mt-auto w-full">
				<button class="quick-done ${btnCls(tile.status === 'done' || tile.status === 'completed')}" data-tile-id="${tile.id}">✓ ${escapeHtml(_t('Done'))}</button>
				<button class="quick-skip ${btnCls(tile.status === 'skipped')}" data-tile-id="${tile.id}">${escapeHtml(_t('Skip'))}</button>
			</div>`;
	};
})();
