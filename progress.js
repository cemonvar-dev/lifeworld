// Progress screen: this week vs last, a 12-week trend, an activity heatmap,
// streaks and wins. Everything is computed from the tiles already loaded.
const PROGRESS_WEEKS = 12;

function progressDayKey(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function progressAddDays(date, days) {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

// Weeks start on Monday.
function progressWeekStart(date) {
	const start = new Date(date);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (start.getDay() + 6) % 7);
	return start;
}

function progressLogDays(task, statuses) {
	return new Set((task.task_logs || []).filter(l => statuses.includes(l.status)).map(logDay).filter(Boolean));
}

function progressExisted(task, key) {
	return !task.created_at || progressDayKey(new Date(task.created_at)) <= key;
}

// Streaks count scheduled days in a row. Skips don't break a streak, and today
// only counts once it's done.
function progressStreaks(task, done, skipped, now) {
	const todayKey = progressDayKey(now);
	let current = 0;
	for (let i = 0; i < 400; i++) {
		const day = progressAddDays(now, -i);
		const key = progressDayKey(day);
		if (!progressExisted(task, key)) break;
		if (!isTaskScheduledOnDate(task, day)) continue;
		if (done.has(key)) current++;
		else if (skipped.has(key) || key === todayKey) continue;
		else break;
	}
	let best = 0;
	let run = 0;
	for (let i = 365; i >= 0; i--) {
		const day = progressAddDays(now, -i);
		const key = progressDayKey(day);
		if (!progressExisted(task, key) || !isTaskScheduledOnDate(task, day)) continue;
		if (done.has(key)) best = Math.max(best, ++run);
		else if (!skipped.has(key) && key !== todayKey) run = 0;
	}
	return { current, best: Math.max(best, current) };
}

function computeProgress(tasks, now = new Date()) {
	const todayKey = progressDayKey(now);
	const items = tasks.map(task => ({
		task,
		done: progressLogDays(task, ['done', 'completed']),
		skipped: progressLogDays(task, ['skipped']),
		routine: (task.frequency_mode || 'daily') !== 'once',
		active: !tilePlant(task, 0).finished
	}));
	const doneOn = key => items.filter(item => item.done.has(key)).length;
	const routines = items.filter(item => item.routine && item.active);

	// Expected vs fulfilled routine days in a date range (today only once done).
	const routineDays = (start, days) => {
		let expected = 0;
		let fulfilled = 0;
		for (let i = 0; i < days; i++) {
			const day = progressAddDays(start, i);
			const key = progressDayKey(day);
			if (key > todayKey) break;
			routines.forEach(item => {
				if (!progressExisted(item.task, key) || !isTaskScheduledOnDate(item.task, day)) return;
				const isDone = item.done.has(key);
				if (!isDone && (item.skipped.has(key) || key === todayKey)) return;
				expected++;
				if (isDone) fulfilled++;
			});
		}
		return { expected, fulfilled };
	};

	const weekStart = progressWeekStart(now);
	const daysSoFar = (now.getDay() + 6) % 7 + 1;
	const sumDone = (start, days) => {
		let total = 0;
		for (let i = 0; i < days; i++) total += doneOn(progressDayKey(progressAddDays(start, i)));
		return total;
	};
	const lastWeekStart = progressAddDays(weekStart, -7);
	const thisWeek = sumDone(weekStart, daysSoFar);

	let routinesDue = 0;
	let routinesKept = 0;
	routines.forEach(item => {
		let expected = 0;
		let fulfilled = 0;
		for (let i = 0; i < daysSoFar; i++) {
			const day = progressAddDays(weekStart, i);
			const key = progressDayKey(day);
			if (!progressExisted(item.task, key) || !isTaskScheduledOnDate(item.task, day)) continue;
			const isDone = item.done.has(key);
			if (!isDone && (item.skipped.has(key) || key === todayKey)) continue;
			expected++;
			if (isDone) fulfilled++;
		}
		if (expected) {
			routinesDue++;
			if (fulfilled >= expected) routinesKept++;
		}
	});

	const weeks = [];
	for (let w = PROGRESS_WEEKS - 1; w >= 0; w--) {
		const start = progressAddDays(weekStart, -7 * w);
		const { expected, fulfilled } = routineDays(start, 7);
		weeks.push({ start: progressDayKey(start), done: sumDone(start, w === 0 ? daysSoFar : 7), rate: expected ? Math.round(fulfilled / expected * 100) : null });
	}

	const heatmap = [];
	const heatmapStart = progressAddDays(weekStart, -7 * (PROGRESS_WEEKS - 1));
	for (let i = 0; i < PROGRESS_WEEKS * 7; i++) {
		const key = progressDayKey(progressAddDays(heatmapStart, i));
		heatmap.push({ key, count: key > todayKey ? 0 : doneOn(key), future: key > todayKey });
	}

	const streaks = routines
		.map(item => ({ id: item.task.id, name: item.task.name, ...progressStreaks(item.task, item.done, item.skipped, now) }))
		.filter(s => s.current > 0 || s.best > 0)
		.sort((a, b) => b.current - a.current || b.best - a.best)
		.slice(0, 5);

	const wins = [];
	const earlierWeeks = weeks.slice(0, -1).map(w => w.done);
	if (thisWeek > 0 && earlierWeeks.some(n => n > 0) && thisWeek > Math.max(...earlierWeeks)) wins.push({ type: 'best_week', count: thisWeek });
	const dueToday = routines.filter(item => progressExisted(item.task, todayKey) && isTaskScheduledOnDate(item.task, now) && !item.skipped.has(todayKey));
	if (dueToday.length && dueToday.every(item => item.done.has(todayKey))) wins.push({ type: 'perfect_day', count: dueToday.length });
	streaks.filter(s => s.current >= 3 && s.current === s.best).forEach(s => wins.push({ type: 'best_streak', name: s.name, count: s.current }));
	const weekAgo = progressDayKey(progressAddDays(now, -7));
	const monthBefore = progressDayKey(progressAddDays(now, -37));
	routines.forEach(item => {
		const days = [...item.done].sort();
		const earlier = days.filter(d => d < weekAgo);
		if (days.some(d => d >= weekAgo) && earlier.length && earlier[earlier.length - 1] < monthBefore) {
			wins.push({ type: 'comeback', name: item.task.name });
		}
	});

	return {
		thisWeek,
		lastWeekSoFar: sumDone(lastWeekStart, daysSoFar),
		lastWeekTotal: sumDone(lastWeekStart, 7),
		routinesDue,
		routinesKept,
		weeks,
		heatmap,
		streaks,
		wins: wins.slice(0, 3)
	};
}

// The last 7 days (today and the 6 before): day by day, areas, highlights and
// the time of day things get marked done. areaOf(task) -> { key, label, color }.
function computeWeekReview(tasks, areaOf, now = new Date()) {
	const todayKey = progressDayKey(now);
	const keys = Array.from({ length: 7 }, (_, i) => progressDayKey(progressAddDays(now, i - 6)));
	const inWindow = new Set(keys);
	const days = keys.map(key => ({ key, done: 0, skipped: 0, missed: 0 }));
	const byKey = Object.fromEntries(days.map(d => [d.key, d]));
	const areas = {};
	const perTask = [];
	const hours = { morning: 0, afternoon: 0, evening: 0, night: 0 };
	tasks.forEach(task => {
		const finished = tilePlant(task, 0).finished;
		const status = {};
		(task.task_logs || []).forEach(l => {
			const d = logDay(l);
			if (!inWindow.has(d) || !['done', 'completed', 'skipped'].includes(l.status) || status[d]) return;
			status[d] = l.status === 'skipped' ? 'skipped' : 'done';
			if (status[d] === 'done' && l.created_at) {
				const at = new Date(l.created_at);
				if (progressDayKey(at) === d) { // logged on the day itself, not back-filled
					const h = at.getHours();
					hours[h >= 5 && h < 12 ? 'morning' : h < 17 && h >= 12 ? 'afternoon' : h < 22 && h >= 17 ? 'evening' : 'night']++;
				}
			}
		});
		const area = areaOf(task);
		const a = areas[area.key] = areas[area.key] || { ...area, done: 0, active: 0, names: [] };
		if (!finished) a.active++;
		let due = 0, done = 0;
		keys.forEach(key => {
			const st = status[key];
			if (st) byKey[key][st]++;
			if (st === 'done') { a.done++; done++; }
			const scheduled = progressExisted(task, key) && isTaskScheduledOnDate(task, new Date(key + 'T00:00:00'));
			if (!finished && scheduled) {
				due++;
				if (!st && key < todayKey) byKey[key].missed++;
			}
		});
		if (done && !a.names.includes(task.name)) a.names.push(task.name);
		if (!finished) perTask.push({ id: task.id, name: task.name, routine: (task.frequency_mode || 'daily') !== 'once', due, done });
	});
	const areaList = Object.values(areas).filter(a => a.done > 0).sort((x, y) => y.done - x.done);
	const totalDone = areaList.reduce((n, a) => n + a.done, 0);
	areaList.forEach(a => { a.pct = totalDone ? Math.round(a.done / totalDone * 100) : 0; });
	return {
		days,
		totals: days.reduce((t, d) => ({ done: t.done + d.done, skipped: t.skipped + d.skipped, missed: t.missed + d.missed }), { done: 0, skipped: 0, missed: 0 }),
		areas: areaList,
		top: perTask.filter(t => t.done > 0).sort((x, y) => y.done - x.done || x.name.localeCompare(y.name)).slice(0, 3),
		slipped: perTask.filter(t => t.routine && t.due >= 2 && t.done / t.due <= 0.5).sort((x, y) => x.done / x.due - y.done / y.due || y.due - x.due).slice(0, 3),
		untouched: Object.values(areas).filter(a => a.active > 0 && a.done === 0 && a.key !== '__none__').sort((x, y) => y.active - x.active).slice(0, 3),
		hours
	};
}

// ---- Progress screen ----
(function () {
	let overlay = null;
	const card = 'rounded-2xl bg-white border border-slate-200/80 p-4';
	const heading = 'text-sm font-semibold text-slate-700 mb-2';

	const AREA_FALLBACK = ['#93c5fd', '#a7f3d0', '#fcd34d', '#f9a8d4', '#c4b5fd', '#fdba74', '#99f6e4', '#cbd5e1'];
	function areaOf(task) {
		const id = (task.tag_ids || []).find(x => TAGS_BY_ID[x]);
		if (!id) return { key: '__none__', label: _t('Untagged'), color: '#e2e8f0' };
		let cur = TAGS_BY_ID[id], guard = 0;
		while (cur.parent_id && TAGS_BY_ID[cur.parent_id] && guard++ < 30) cur = TAGS_BY_ID[cur.parent_id];
		const color = (window.tagColor && window.tagColor(cur.id)) || AREA_FALLBACK[Math.abs([...cur.id].reduce((h, c) => h * 31 + c.charCodeAt(0) | 0, 7)) % AREA_FALLBACK.length];
		return { key: cur.id, label: cur.name, color };
	}

	function weekReviewHtml(w) {
		const loc = (window.i18n && i18n.lang) || undefined;
		const max = Math.max(1, ...w.days.map(d => d.done + d.skipped + d.missed));
		const seg = (n, cls) => n ? `<span class="${cls}" style="width:${n / max * 100}%"></span>` : '';
		const rows = w.days.map(d => {
			const date = new Date(d.key + 'T00:00:00');
			return `<div class="flex items-center gap-2 text-xs">
				<span class="w-16 shrink-0 text-slate-500"><span class="font-semibold text-slate-700">${escapeHtml(date.toLocaleDateString(loc, { weekday: 'short' }))}</span> ${date.getDate()}</span>
				<span class="flex-1 flex h-3 rounded-full bg-slate-100 overflow-hidden">${seg(d.done, 'bg-emerald-300')}${seg(d.skipped, 'bg-amber-200')}${seg(d.missed, 'bg-rose-200')}</span>
				<span class="w-24 shrink-0 text-right tabular-nums text-[11px] whitespace-nowrap text-slate-500">${d.done}<span class="text-emerald-500"> ✓</span>${d.skipped ? ` · ${d.skipped}<span class="text-amber-500"> ⏭</span>` : ''}${d.missed ? ` · ${d.missed}<span class="text-rose-400"> ○</span>` : ''}</span>
			</div>`;
		}).join('');
		const areaBar = w.areas.length ? `<div class="flex h-3 rounded-full overflow-hidden mb-2">${w.areas.map(a => `<span style="width:${a.pct}%;background:${a.color}" title="${escapeHtml(a.label)} ${a.pct}%"></span>`).join('')}</div>
			<div class="flex flex-wrap gap-1.5">${w.areas.map(a => `<details class="group"><summary class="list-none cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 bg-white text-xs hover:bg-slate-50"><span class="w-2 h-2 rounded-full" style="background:${a.color}"></span><span translate="no" class="font-medium text-slate-700">${escapeHtml(a.label)}</span><span class="text-slate-400">${a.pct}%</span></summary><div translate="no" class="mt-1 ml-2 text-[11px] text-slate-500">${a.names.slice(0, 6).map(escapeHtml).join(' · ')}</div></details>`).join('')}</div>`
			: `<div class="text-xs text-slate-400">${escapeHtml(_t('Nothing marked done in the last 7 days.'))}</div>`;
		const list = (title, icon, items, fmt) => items.length ? `<div><div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">${escapeHtml(title)}</div>${items.map(x => `<div class="flex items-center justify-between gap-2 py-0.5 text-sm"><span translate="no" class="truncate text-slate-700">${icon} ${escapeHtml(x.name || x.label)}</span><span class="shrink-0 text-xs tabular-nums text-slate-500">${fmt(x)}</span></div>`).join('')}</div>` : '';
		const highlights = [
			list(_t('Most done'), '✅', w.top, x => x.routine && x.due ? `${x.done}/${x.due}` : _t('{n} done', { n: x.done })),
			list(_t('Slipped'), '⚠️', w.slipped, x => `${x.done}/${x.due}`),
			list(_t('Untouched all week'), '💤', w.untouched, x => _t('{n} cards', { n: x.active }))
		].filter(Boolean).join('');
		const hourTotal = Object.values(w.hours).reduce((a, b) => a + b, 0);
		const hourRow = hourTotal ? `<div><div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">${escapeHtml(_t('When you get things done'))}</div><div class="grid grid-cols-4 gap-2">${[['morning', '🌅', 'Morning'], ['afternoon', '☀️', 'Afternoon'], ['evening', '🌇', 'Evening'], ['night', '🌙', 'Night']].map(([k, i, l]) => { const pct = Math.round(w.hours[k] / hourTotal * 100); return `<div class="rounded-xl bg-slate-50 border border-slate-100 p-2 text-center"><div class="text-base leading-none">${i}</div><div class="text-sm font-semibold text-slate-700 mt-1">${pct}%</div><div class="text-[10px] text-slate-400">${escapeHtml(_t(l))}</div></div>`; }).join('')}</div></div>` : '';
		return `<div class="${card}">
			<div class="flex items-baseline justify-between mb-2"><div class="${heading} mb-0">${escapeHtml(_t('Last 7 days'))}</div><div class="text-xs text-slate-500">${escapeHtml(_t('{done} done · {skipped} skipped · {missed} missed', w.totals))}</div></div>
			<div class="flex flex-col gap-1.5">${rows}</div>
			<div class="flex items-center gap-3 mt-2 text-[10px] text-slate-400"><span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-emerald-300"></span>${escapeHtml(_t('Done'))}</span><span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-amber-200"></span>${escapeHtml(_t('Skipped'))}</span><span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-rose-200"></span>${escapeHtml(_t('Missed'))}</span></div>
			<div class="mt-4"><div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">${escapeHtml(_t('Where your week went'))}</div>${areaBar}</div>
			${highlights ? `<div class="mt-4 grid gap-3">${highlights}</div>` : ''}
			${hourRow ? `<div class="mt-4">${hourRow}</div>` : ''}
			<button type="button" data-week-ai class="mt-4 w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-violet-50 border border-violet-200 text-violet-700 text-sm font-semibold hover:bg-violet-100 transition">✨ ${escapeHtml(_t('Review my week with the coach'))}</button>
		</div>`;
	}

	function weekSummaryHtml(p) {
		const delta = p.thisWeek - p.lastWeekSoFar;
		const deltaHtml = delta > 0
			? `<span class="text-emerald-600 font-semibold">▲ ${escapeHtml(_t('{n} more than last week', { n: delta }))}</span>`
			: delta < 0
				? `<span class="text-amber-600 font-semibold">▼ ${escapeHtml(_t('{n} fewer than last week', { n: -delta }))}</span>`
				: `<span class="text-slate-500">${escapeHtml(_t('Same as last week'))}</span>`;
		const toMatch = p.lastWeekTotal - p.thisWeek;
		const pace = p.lastWeekTotal === 0 ? ''
			: toMatch > 0 ? _t('{n} more to match last week', { n: toMatch })
				: _t("You've already matched last week");
		return `<div class="${card}">
			<div class="text-xs font-semibold text-slate-500">${escapeHtml(_t('This week'))}</div>
			<div class="flex items-baseline gap-2 mt-1"><span class="text-3xl font-bold text-slate-800">${p.thisWeek}</span><span class="text-sm text-slate-500">${escapeHtml(_t('done'))}</span></div>
			<div class="text-sm mt-1">${deltaHtml}</div>
			${p.routinesDue ? `<div class="text-sm text-slate-600 mt-2">${escapeHtml(_t('Kept {kept} of {due} routines so far', { kept: p.routinesKept, due: p.routinesDue }))}</div>` : ''}
			${pace ? `<div class="text-xs text-slate-500 mt-1">${escapeHtml(pace)}</div>` : ''}
		</div>`;
	}

	function winsHtml(p) {
		if (!p.wins.length) return '';
		const text = win => win.type === 'best_week' ? _t('Your best week in 12 weeks: {n} done', { n: win.count })
			: win.type === 'perfect_day' ? _t('Everything due today is done')
				: win.type === 'best_streak' ? _t('New best: {name}, {n} in a row', { name: win.name, n: win.count })
					: _t('{name} is back after a long break', { name: win.name });
		const icon = { best_week: '🏆', perfect_day: '🎯', best_streak: '🔥', comeback: '🌱' };
		return `<div class="flex flex-col gap-1.5">${p.wins.map(win => `<div class="rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 text-sm text-emerald-800">${icon[win.type]} ${escapeHtml(text(win))}</div>`).join('')}</div>`;
	}

	function trendHtml(p) {
		const bars = p.weeks.map((week, i) => {
			const height = week.rate === null ? 0 : Math.max(4, week.rate);
			const label = week.rate === null ? '—' : `${week.rate}%`;
			const isCurrent = i === p.weeks.length - 1;
			return `<div class="flex-1 flex flex-col items-center justify-end h-full" title="${escapeHtml(`${week.start} · ${label} · ${_t('{n} done', { n: week.done })}`)}">
				<div class="w-full rounded-t ${isCurrent ? 'bg-blue-500' : 'bg-blue-200'}" style="height:${height}%"></div>
			</div>`;
		}).join('');
		const latest = p.weeks[p.weeks.length - 1];
		return `<div class="${card}">
			<div class="flex items-baseline justify-between"><div class="${heading}">${escapeHtml(_t('Last 12 weeks'))}</div>${latest.rate === null ? '' : `<div class="text-xs text-slate-500">${escapeHtml(_t('{n}% of routines this week', { n: latest.rate }))}</div>`}</div>
			<div class="flex items-end gap-1 h-24" aria-hidden="true">${bars}</div>
		</div>`;
	}

	function heatmapHtml(p) {
		const level = n => n === 0 ? 'bg-slate-100' : n === 1 ? 'bg-emerald-200' : n <= 3 ? 'bg-emerald-400' : 'bg-emerald-600';
		const cells = p.heatmap.map(day => day.future
			? '<div class="aspect-square rounded-[3px]"></div>'
			: `<div class="aspect-square rounded-[3px] ${level(day.count)}" title="${escapeHtml(`${day.key} · ${_t('{n} done', { n: day.count })}`)}"></div>`).join('');
		return `<div class="${card}">
			<div class="${heading}">${escapeHtml(_t('Activity'))}</div>
			<div class="grid grid-flow-col grid-rows-7 gap-1" style="grid-template-columns:repeat(${PROGRESS_WEEKS},minmax(0,1.125rem))">${cells}</div>
			<div class="flex items-center justify-end gap-1 mt-2 text-[10px] text-slate-400"><span>${escapeHtml(_t('Less'))}</span>${[0, 1, 2, 4].map(n => `<span class="w-2.5 h-2.5 rounded-[2px] ${level(n)}"></span>`).join('')}<span>${escapeHtml(_t('More'))}</span></div>
		</div>`;
	}

	function streaksHtml(p) {
		if (!p.streaks.length) return '';
		const rows = p.streaks.map(s => `<div class="flex items-center justify-between gap-3 py-1.5 border-t border-slate-100 first:border-t-0">
			<span translate="no" class="text-sm text-slate-700 truncate">${escapeHtml(s.name)}</span>
			<span class="text-xs whitespace-nowrap"><span class="${s.current ? 'text-orange-600 font-semibold' : 'text-slate-400'}">🔥 ${escapeHtml(_t('{n} in a row', { n: s.current }))}</span> <span class="text-slate-400">· ${escapeHtml(_t('Best: {n}', { n: s.best }))}</span></span>
		</div>`).join('');
		return `<div class="${card}"><div class="${heading}">${escapeHtml(_t('Streaks'))}</div>${rows}<div class="text-[11px] text-slate-400 mt-1">${escapeHtml(_t('Skipped days don’t break a streak.'))}</div></div>`;
	}

	function render() {
		const tasks = Object.values(rawTiles);
		const p = computeProgress(tasks);
		const body = tasks.length
			? winsHtml(p) + weekReviewHtml(computeWeekReview(tasks, areaOf)) + weekSummaryHtml(p) + trendHtml(p) + heatmapHtml(p) + streaksHtml(p)
			: `<div class="${card} text-center text-sm text-slate-500">${escapeHtml(_t('Create a tile to start tracking your progress.'))}</div>`;
		overlay.querySelector('#progressBody').innerHTML = body;
	}

	function close() {
		overlay.classList.add('hidden');
	}

	window.openProgress = function () {
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = 'progressOverlay';
			overlay.className = 'fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 hidden flex items-start sm:items-center justify-center p-4 overflow-y-auto';
			overlay.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="progressTitle" class="bg-slate-50 rounded-3xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col my-4">
				<div class="flex items-center justify-between px-5 pt-5 pb-3">
					<div id="progressTitle" class="text-lg font-semibold text-slate-700">Progress</div>
					<button type="button" data-progress-close aria-label="Close" class="grid place-items-center h-9 w-9 rounded-full text-2xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition">&times;</button>
				</div>
				<div id="progressBody" class="flex flex-col gap-3 px-5 pb-5 overflow-y-auto"></div>
			</div>`;
			document.body.appendChild(overlay);
			overlay.addEventListener('click', e => {
				if (e.target === overlay || e.target.closest('[data-progress-close]')) close();
				if (e.target.closest('[data-week-ai]')) {
					close();
					window.track?.('week_review_requested');
					if (window.openAiChat) openAiChat();
					if (window.sendAiMessage) sendAiMessage(_t('Review my last 7 days like my coach: what went well, what slipped, which area I neglected, and one concrete suggestion for next week.'));
				}
			});
			document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
		}
		render();
		overlay.classList.remove('hidden');
		window.track?.('progress_opened');
	};

	document.addEventListener('DOMContentLoaded', () => {
		document.getElementById('progressBtn')?.addEventListener('click', () => window.openProgress());
	});
})();
