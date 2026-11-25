// "Plan" section of the tile detail: one summary line (frequency · timing ·
// reminder · next occurrence) that opens an editor with a frequency row, date
// chips, weekday presets, a month-day grid, timing icons and reminder options.
// Uses app.js globals: rawTiles, activeTileId, setFrequency, updateTask, supa,
// applyFilters, scheduleReminders, setTileReminder, computeReminderAt,
// nextDueDateStr, repeatEvery, isRepeatWeek, mondayOf, tileTimeOfDay, monthlyDom, todayLocal, openTilePopup, i18n, _t, escapeHtml.
(function () {
	const OPEN_KEY = 'lw_plan_open';
	const TIMING = [['morning', '🌅', 'Morning', 9], ['afternoon', '☀️', 'Afternoon', 14], ['evening', '🌇', 'Evening', 20], ['night', '🌙', 'Night', 22], ['', '🕒', 'Any time', null]];
	const pad = n => String(n).padStart(2, '0');
	const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
	const loc = () => (window.i18n && i18n.lang) || undefined;
	const isOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch (e) { return false; } };
	const setOpen = v => { try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch (e) {} };
	const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
	const dayShort = i => (i18n.dayName ? i18n.dayName(i, 'short') : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]);

	function relDay(k) {
		if (!k) return '';
		const n = Math.round((parse(k) - parse(todayLocal())) / 86400000);
		if (n === 0) return _t('Today');
		if (n === 1) return _t('Tomorrow');
		if (n === -1) return _t('Yesterday');
		return parse(k).toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short' });
	}
	const weekdays = raw => (raw.task_frequency_days || []).map(d => d.day_of_week).sort((a, b) => a - b);
	function weekdayLabel(days) {
		const s = [...days].sort().join(',');
		if (s === '0,1,2,3,4,5,6') return _t('Every day');
		if (s === '1,2,3,4,5') return _t('Weekdays');
		if (s === '0,6') return _t('Weekends');
		return MON_FIRST.filter(d => days.includes(d)).map(dayShort).join(', ') || _t('Pick days');
	}
	function freqLabel(raw) {
		const mode = raw.frequency_mode || 'daily';
		if (mode === 'once') return raw.end_date ? `📅 ${relDay(raw.end_date)}` : `📅 ${_t('No date')}`;
		if (mode === 'daily') return `🔁 ${_t('Every day')}`;
		if (mode === 'weekly') { const n = repeatEvery(raw); return `🔁 ${n > 1 ? _t('Every {n} weeks', { n }) + ' · ' : ''}${weekdayLabel(weekdays(raw))}`; }
		const dom = monthlyDom(raw);
		return `🗓️ ${dom >= 31 ? _t('Last day of the month') : _t('Every month on day {n}', { n: dom })}`;
	}
	function reminderLabel(raw) {
		if (!raw.reminder_at) return '';
		const d = new Date(raw.reminder_at);
		if (isNaN(d)) return '';
		if ((raw.frequency_mode || 'daily') !== 'once') return _t('{time} each time', { time: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
		return `${relDay(iso(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// Next occurrence date + the timing's hour, moved forward if already past.
	function reminderForTiming(raw) {
		const t = TIMING.find(x => x[0] === tileTimeOfDay(raw));
		if (!t || t[3] == null) return null;
		const [h, m] = (window.notifBucketTime && notifBucketTime(t[0])) || [t[3], 0];
		let day = nextDueDateStr(raw) || todayLocal();
		if (day < todayLocal()) day = todayLocal(); // overdue: never schedule in the past
		let when = parse(day); when.setHours(h, m, 0, 0);
		if (when <= new Date()) {
			const next = new Date(when); next.setDate(next.getDate() + 1);
			// For routines, find the following occurrence; for one-time tasks keep tomorrow.
			if ((raw.frequency_mode || 'daily') !== 'once') {
				for (let i = 0; i < 40 && !isTaskScheduledOnDate(raw, next); i++) next.setDate(next.getDate() + 1);
			}
			when = next;
		}
		return when;
	}

	function refresh(tileId) {
		const body = document.getElementById('popupBody');
		const top = body ? body.scrollTop : 0;
		openTilePopup(tileId);
		if (body) requestAnimationFrame(() => { body.scrollTop = top; });
	}

	async function setWeekdays(tileId, days) {
		const raw = rawTiles[tileId];
		await supa.from('task_frequency_days').delete().eq('task_id', tileId);
		raw.task_frequency_days = [];
		if (days.length) {
			const { data, error } = await supa.from('task_frequency_days').insert(days.map(d => ({ task_id: tileId, day_of_week: d }))).select();
			if (error) console.error('Weekdays save error:', error);
			raw.task_frequency_days = data && data.length === days.length ? data : days.map(d => ({ task_id: tileId, day_of_week: d }));
		}
		applyFilters(); scheduleReminders(); refresh(tileId);
	}
	async function setField(tileId, field, value) {
		rawTiles[tileId][field] = value;
		applyFilters(); scheduleReminders(); refresh(tileId);
		await updateTask(tileId, { [field]: value });
	}
	// Every N weeks: the anchor is the Monday of the week it starts in.
	async function setRepeat(tileId, n, startNextWeek) {
		const raw = rawTiles[tileId];
		const monday = mondayOf(new Date());
		if (startNextWeek) monday.setDate(monday.getDate() + 7);
		const patch = { repeat_every: n, repeat_anchor: n > 1 ? iso(monday) : null };
		Object.assign(raw, patch);
		applyFilters(); scheduleReminders(); refresh(tileId);
		const { error } = await supa.from('tasks').update(patch).eq('id', tileId);
		if (error) { console.error('Repeat save error:', error); window.showToast?.(_t('Could not save. Please try again.')); }
		window.track?.('plan_repeat_set', { every_weeks: n });
	}
	async function setFreq(tileId, mode) {
		const body = document.getElementById('popupBody');
		const top = body ? body.scrollTop : 0;
		await setFrequency(mode); // persists + re-renders
		if (mode === 'weekly' && !weekdays(rawTiles[tileId]).length) await setWeekdays(tileId, [new Date().getDay()]);
		if (body) requestAnimationFrame(() => { body.scrollTop = top; });
		window.track?.('plan_frequency_set', { frequency: mode });
	}

	// Compact editor: one card, a left label column, one control per row.
	const ON = 'bg-blue-50 text-blue-700 border-blue-300';
	const OFF = 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50';
	let remEditFor = null; // tile whose reminder "Change" panel is open
	let lastTile = null;
	const segmented = (items, current, attr) => `<div class="flex rounded-lg bg-slate-100 p-0.5">${items.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="flex-1 min-w-0 h-7 px-1 rounded-md text-xs font-semibold truncate transition ${String(current) === String(v) ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}">${l}</button>`).join('')}</div>`;
	const chip = (attr, v, l, on, x) => `<button type="button" data-${attr}="${v}" class="inline-flex items-center gap-1 px-3 h-8 rounded-full text-xs font-semibold border transition ${on ? ON : OFF}">${l}${on && x ? '<span aria-hidden="true" class="opacity-60">×</span>' : ''}</button>`;
	const row = (name, body, top) => `<div class="grid grid-cols-[76px_minmax(0,1fr)] gap-2 py-2.5 border-t border-slate-100 ${top ? 'items-start' : 'items-center'}"><div class="text-xs font-medium text-slate-400 leading-tight ${top ? 'pt-2' : ''}">${escapeHtml(name)}</div><div class="min-w-0">${body}</div></div>`;

	// Reminder when switched on: the timing's time, else 09:00 on the next occurrence.
	function defaultReminder(raw) {
		const t = reminderForTiming(raw);
		if (t) return t;
		const when = parse(nextDueDateStr(raw) || todayLocal());
		when.setHours(9, 0, 0, 0);
		return when > new Date() ? when : computeReminderAt('1h');
	}

	function editorHtml(raw, tileId) {
		const mode = raw.frequency_mode || 'daily';
		const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
		const rows = [row(_t('Repeats'), segmented([['once', escapeHtml(_t('Once'))], ['daily', escapeHtml(_t('Daily'))], ['weekly', escapeHtml(_t('Weekly'))], ['monthly', escapeHtml(_t('Monthly'))]], mode, 'plan-freq'))];
		if (mode === 'once') {
			const chips = [[plus(0), _t('Today')], [plus(1), _t('Tomorrow')]];
			const custom = raw.end_date && !chips.some(c => c[0] === raw.end_date);
			const pick = `<span class="inline-flex items-center h-8 rounded-full text-xs font-semibold border transition ${custom ? ON : OFF}">
				<label class="relative inline-flex items-center gap-1 h-full pl-3 ${custom ? 'pr-1' : 'pr-3'} cursor-pointer">📅 <span>${escapeHtml(custom ? relDay(raw.end_date) : _t('Pick a date'))}</span><input type="date" data-plan-date-pick value="${raw.end_date || ''}" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer" /></label>
				${custom ? `<button type="button" data-plan-date="" aria-label="${escapeHtml(_t('Clear'))}" class="h-full pl-1 pr-3 opacity-60 hover:opacity-100">×</button>` : ''}</span>`;
			rows.push(row(_t('Date'), `<div class="flex flex-wrap gap-1.5">${chips.map(([v, l]) => chip('plan-date', v, escapeHtml(l), raw.end_date === v, true)).join('')}${pick}</div>`));
		} else if (mode === 'weekly') {
			const days = weekdays(raw);
			rows.push(row(_t('Days'), `<div class="flex gap-1">${MON_FIRST.map(d => `<button type="button" data-plan-day="${d}" class="flex-1 min-w-0 h-8 rounded-lg text-xs font-semibold border transition ${days.includes(d) ? ON : OFF}">${escapeHtml(dayShort(d))}</button>`).join('')}</div>
				<div class="mt-1.5 flex flex-wrap gap-1">${[['1,2,3,4,5', _t('Weekdays')], ['0,6', _t('Weekends')], ['0,1,2,3,4,5,6', _t('Every day')]].map(([v, l]) => `<button type="button" data-plan-days="${v}" class="px-2 h-6 rounded-full text-[11px] font-semibold text-slate-500 hover:bg-slate-100">${escapeHtml(l)}</button>`).join('')}</div>`, true));
			rows.push(row(_t('Repeat every'), segmented([1, 2, 3, 4].map(n => [n, escapeHtml(n === 1 ? _t('Every week') : _t('{n} weeks', { n }))]), repeatEvery(raw), 'plan-every')));
			if (repeatEvery(raw) > 1) rows.push(row(_t('Starting'), segmented([['this', escapeHtml(_t('This week'))], ['next', escapeHtml(_t('Next week'))]], isRepeatWeek(raw, new Date()) ? 'this' : 'next', 'plan-start')));
		} else if (mode === 'monthly') {
			const dom = monthlyDom(raw);
			rows.push(row(_t('Day of month'), `<div class="grid grid-cols-7 gap-1">${Array.from({ length: 30 }, (_, i) => i + 1).map(d => `<button type="button" data-plan-dom="${d}" class="h-7 rounded-md text-xs tabular-nums border transition ${dom === d ? ON + ' font-semibold' : OFF}">${d}</button>`).join('')}
				<button type="button" data-plan-dom="31" class="col-span-5 h-7 rounded-md text-xs font-semibold border transition ${dom >= 31 ? ON : OFF}">${escapeHtml(_t('Last day of the month'))}</button></div>`, true));
		}
		const tod = tileTimeOfDay(raw);
		const todT = TIMING.find(x => x[0] && x[0] === tod);
		rows.push(row(_t('When'), `<div class="flex items-center gap-1.5">${TIMING.filter(t => t[0]).map(([v, icon, l]) => `<button type="button" data-plan-tod="${v}" title="${escapeHtml(_t(l))}" aria-label="${escapeHtml(_t(l))}" aria-pressed="${tod === v}" class="w-9 h-9 shrink-0 rounded-full border text-base leading-none transition ${tod === v ? ON : OFF}">${icon}</button>`).join('')}
			<span class="ml-1 min-w-0 truncate text-xs ${todT ? 'font-semibold text-slate-700' : 'text-slate-400'}">${escapeHtml(_t(todT ? todT[2] : 'Any time'))}</span></div>`));
		const rem = reminderLabel(raw);
		const editing = remEditFor === tileId;
		const forTiming = reminderForTiming(raw);
		const quick = [
			...(forTiming ? [['timing', `⏰ ${escapeHtml(_t('At {time}', { time: `${pad(forTiming.getHours())}:${pad(forTiming.getMinutes())}` }))} · ${escapeHtml(relDay(iso(forTiming)))}`]] : []),
			['1h', escapeHtml(_t('In 1 hour'))], ['tom9', escapeHtml(_t('Tomorrow 09:00'))]
		];
		rows.push(row(_t('Remind'), `<div class="flex items-center gap-2">
				<span class="flex-1 min-w-0 truncate text-sm ${rem ? 'font-medium text-slate-700' : 'text-slate-400'}">${rem ? `🔔 ${escapeHtml(rem)}` : escapeHtml(_t('Off'))}</span>
				<button type="button" data-plan-rem-edit class="shrink-0 text-xs font-semibold text-blue-700 hover:underline">${escapeHtml(_t(rem ? 'Change' : 'Pick a time'))}</button>
				<button type="button" role="switch" aria-checked="${!!rem}" aria-label="${escapeHtml(_t('Reminder'))}" data-plan-rem-toggle class="relative shrink-0 w-9 h-5 rounded-full border transition ${rem ? 'bg-blue-100 border-blue-300' : 'bg-slate-100 border-slate-200'}"><span class="absolute top-[1px] ${rem ? 'left-[17px] bg-blue-400' : 'left-[1px] bg-slate-300'} w-4 h-4 rounded-full transition-all"></span></button>
			</div>
			${editing ? `<div class="mt-2 flex flex-wrap items-center gap-1.5">${quick.map(([v, l]) => chip('plan-rem', v, l, false)).join('')}
				<input type="datetime-local" data-plan-rem-custom value="${toLocalInputValue(raw.reminder_at ? new Date(raw.reminder_at) : defaultReminder(raw))}" class="h-8 rounded-full border border-slate-200 bg-white px-3 text-xs text-slate-600" /></div>` : ''}`));
		return `<div class="pb-0.5">${rows.join('')}</div>`;
	}

	function render(tileId) {
		const mount = document.getElementById('tilePlanMount');
		const raw = rawTiles[tileId];
		if (!mount || !raw) return;
		const open = isOpen();
		const tod = TIMING.find(x => x[0] === tileTimeOfDay(raw));
		const next = nextDueDateStr(raw);
		const parts = [freqLabel(raw)];
		if (tod && tod[0]) parts.push(`${tod[1]} ${_t(tod[2])}`);
		const rem = reminderLabel(raw);
		if (rem) parts.push(`🔔 ${rem}`);
		const showNext = next && (raw.frequency_mode || 'daily') !== 'once' && (raw.frequency_mode || 'daily') !== 'daily';
		mount.innerHTML = `
			<div class="rounded-xl border border-slate-200 bg-white">
				<button type="button" data-plan-toggle class="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50" aria-expanded="${open}">
					<span class="flex-1 min-w-0">
						<span class="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(_t('Plan'))}</span>
						<span class="block text-sm font-medium text-slate-700 truncate">${parts.map(escapeHtml).join(' · ')}</span>
						${showNext ? `<span class="block text-xs text-slate-400">${escapeHtml(_t('Next: {date}', { date: relDay(next) }))}</span>` : ''}
					</span>
					<svg class="w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>
				</button>
				${open ? `<div class="px-3">${editorHtml(raw, tileId)}</div>` : ''}
			</div>`;
	}

	function wire(tileId) {
		const mount = document.getElementById('tilePlanMount');
		if (!mount || mount.dataset.wired) return;
		mount.dataset.wired = '1';
		mount.addEventListener('click', async e => {
			e.stopPropagation();
			const t = e.target, raw = rawTiles[tileId];
			const get = a => t.closest(`[data-${a}]`);
			if (get('plan-toggle')) { setOpen(!isOpen()); render(tileId); return; }
			if (t.matches('[data-plan-date-pick]')) { try { t.showPicker(); } catch (err) {} return; }
			let b;
			if ((b = get('plan-freq'))) { if (b.dataset.planFreq !== (raw.frequency_mode || 'daily')) await setFreq(tileId, b.dataset.planFreq); return; }
			if ((b = get('plan-date'))) { const v = b.dataset.planDate; await setField(tileId, 'end_date', v && v !== raw.end_date ? v : null); return; }
			if ((b = get('plan-day'))) { const d = Number(b.dataset.planDay); const cur = weekdays(raw); const next = cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d]; await setWeekdays(tileId, next); return; }
			if ((b = get('plan-every'))) { const n = Number(b.dataset.planEvery); if (n !== repeatEvery(raw)) await setRepeat(tileId, n, false); return; }
			if ((b = get('plan-start'))) { await setRepeat(tileId, repeatEvery(raw), b.dataset.planStart === 'next'); return; }
			if ((b = get('plan-days'))) { await setWeekdays(tileId, b.dataset.planDays.split(',').map(Number)); return; }
			if ((b = get('plan-dom'))) { await setField(tileId, 'day_of_month', Number(b.dataset.planDom)); return; }
			if ((b = get('plan-tod'))) { const v = b.dataset.planTod; const on = v && v !== tileTimeOfDay(raw); await setField(tileId, 'time_of_day', on ? [v] : []); if (on) window.maybeAskNotif?.('timing'); return; }
			if (get('plan-rem-edit')) { remEditFor = remEditFor === tileId ? null : tileId; render(tileId); return; }
			if (get('plan-rem-toggle')) {
				const when = raw.reminder_at ? null : defaultReminder(raw);
				remEditFor = null;
				await setTileReminder(tileId, when);
				window.track?.('plan_reminder_set', { preset: when ? 'toggle' : 'none' });
				refresh(tileId);
				return;
			}
			if ((b = get('plan-rem'))) {
				const v = b.dataset.planRem;
				const when = v === 'timing' ? reminderForTiming(raw) : computeReminderAt(v);
				if (!when) return;
				remEditFor = null;
				await setTileReminder(tileId, when);
				window.track?.('plan_reminder_set', { preset: v });
				refresh(tileId);
			}
		});
		mount.addEventListener('change', async e => {
			const t = e.target;
			if (t.matches('[data-plan-date-pick]')) { await setField(tileId, 'end_date', t.value || null); return; }
			if (t.matches('[data-plan-rem-custom]') && t.value) {
				const when = new Date(t.value);
				if (!isNaN(when)) { remEditFor = null; await setTileReminder(tileId, when); refresh(tileId); }
			}
		});
	}

	// Called by openTilePopup after it renders.
	window.mountTilePlan = function (tileId) {
		if (tileId !== lastTile) { remEditFor = null; lastTile = tileId; }
		wire(tileId); render(tileId);
	};
})();
