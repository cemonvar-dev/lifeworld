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

// ---- Progress screen ----
(function () {
	let overlay = null;
	const card = 'rounded-2xl bg-white border border-slate-200/80 p-4';
	const heading = 'text-sm font-semibold text-slate-700 mb-2';

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
			? winsHtml(p) + weekSummaryHtml(p) + trendHtml(p) + heatmapHtml(p) + streaksHtml(p)
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
			overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('[data-progress-close]')) close(); });
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
