// "Plan" section of the tile detail: one summary line (frequency · timing ·
// reminder · next occurrence) that opens an editor with a frequency row, date
// chips, weekday presets, a month-day grid, timing icons and reminder options.
// Uses app.js globals: rawTiles, activeTileId, setFrequency, updateTask, supa,
// applyFilters, scheduleReminders, setTileReminder, computeReminderAt,
// nextDueDateStr, tileTimeOfDay, monthlyDom, todayLocal, openTilePopup, i18n, _t, escapeHtml.
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
		if (mode === 'weekly') return `🔁 ${weekdayLabel(weekdays(raw))}`;
		const dom = monthlyDom(raw);
		return `🗓️ ${dom >= 31 ? _t('Last day of the month') : _t('Every month on day {n}', { n: dom })}`;
	}
	function reminderLabel(raw) {
		if (!raw.reminder_at) return '';
		const d = new Date(raw.reminder_at);
		if (isNaN(d)) return '';
		return `${relDay(iso(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// Next occurrence date + the timing's hour, moved forward if already past.
	function reminderForTiming(raw) {
		const t = TIMING.find(x => x[0] === tileTimeOfDay(raw));
		if (!t || t[3] == null) return null;
		let day = nextDueDateStr(raw) || todayLocal();
		let when = parse(day); when.setHours(t[3], 0, 0, 0);
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
	async function setFreq(tileId, mode) {
		const body = document.getElementById('popupBody');
		const top = body ? body.scrollTop : 0;
		await setFrequency(mode); // persists + re-renders
		if (mode === 'weekly' && !weekdays(rawTiles[tileId]).length) await setWeekdays(tileId, [new Date().getDay()]);
		if (body) requestAnimationFrame(() => { body.scrollTop = top; });
		window.track?.('plan_frequency_set', { frequency: mode });
	}

	const seg = (items, current, attr) => `<div class="flex flex-wrap gap-1.5">${items.map(([v, label]) => `<button type="button" data-${attr}="${v}" class="px-3 h-8 rounded-lg text-xs font-semibold border transition ${String(current) === String(v) ? 'bg-blue-50 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}">${label}</button>`).join('')}</div>`;
	const label = text => `<div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(text)}</div>`;

	function editorHtml(raw) {
		const mode = raw.frequency_mode || 'daily';
		const today = new Date();
		const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
		const saturday = (() => { const d = new Date(); const add = (6 - d.getDay() + 7) % 7; d.setDate(d.getDate() + add); return iso(d); })();
		const monday = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return iso(d); })();
		let detail = '';
		if (mode === 'once') {
			const chips = [[plus(0), _t('Today')], [plus(1), _t('Tomorrow')], [saturday, _t('This weekend')], [monday, _t('Next week')]];
			const custom = raw.end_date && !chips.some(c => c[0] === raw.end_date);
			detail = `${label(_t('Date'))}${seg(chips.map(([v, l]) => [v, escapeHtml(l)]), custom ? '__custom' : (raw.end_date || ''), 'plan-date')}
				<div class="mt-2 flex items-center gap-2"><span class="text-xs text-slate-500">${escapeHtml(_t('Pick a date'))}</span><input type="date" data-plan-date-pick value="${raw.end_date || ''}" class="rounded-lg border ${custom ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200'} px-2 py-1 text-sm" /></div>
				<div class="mt-1 text-[11px] text-slate-400">${escapeHtml(_t('Tap the selected one again to clear it.'))}</div>`;
		} else if (mode === 'weekly') {
			const days = weekdays(raw);
			detail = `${label(_t('Days'))}<div class="flex gap-1">${MON_FIRST.map(d => `<button type="button" data-plan-day="${d}" class="flex-1 h-9 rounded-lg text-xs font-semibold border transition ${days.includes(d) ? 'bg-blue-50 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}">${escapeHtml(dayShort(d))}</button>`).join('')}</div>
				<div class="mt-2 flex flex-wrap gap-1.5">${[['1,2,3,4,5', _t('Weekdays')], ['0,6', _t('Weekends')], ['0,1,2,3,4,5,6', _t('Every day')]].map(([v, l]) => `<button type="button" data-plan-days="${v}" class="px-2.5 h-7 rounded-full text-[11px] font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50">${escapeHtml(l)}</button>`).join('')}</div>`;
		} else if (mode === 'monthly') {
			const dom = monthlyDom(raw);
			detail = `${label(_t('Day of month'))}<div class="grid grid-cols-7 gap-1">${Array.from({ length: 30 }, (_, i) => i + 1).map(d => `<button type="button" data-plan-dom="${d}" class="h-8 rounded-lg text-xs tabular-nums border transition ${dom === d ? 'bg-blue-50 text-blue-700 border-blue-300 font-semibold' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}">${d}</button>`).join('')}
				<button type="button" data-plan-dom="31" class="col-span-5 h-8 rounded-lg text-xs font-semibold border transition ${dom >= 31 ? 'bg-blue-50 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}">${escapeHtml(_t('Last day of the month'))}</button></div>`;
		}
		const tod = tileTimeOfDay(raw);
		const timingT = TIMING.find(x => x[0] === tod);
		const remNow = reminderLabel(raw);
		const forTiming = reminderForTiming(raw);
		const remOpts = [
			...(forTiming ? [['timing', `⏰ ${_t('At {time}', { time: `${pad(forTiming.getHours())}:00` })} · ${escapeHtml(relDay(iso(forTiming)))}`]] : []),
			['1h', escapeHtml(_t('In 1 hour'))], ['eve', escapeHtml(_t('This evening 18:00'))], ['tom9', escapeHtml(_t('Tomorrow 09:00'))], ['custom', escapeHtml(_t('Pick a time'))]
		];
		return `<div class="mt-2 space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
			<div>${label(_t('Repeats'))}${seg([['once', escapeHtml(_t('Once'))], ['daily', escapeHtml(_t('Every day'))], ['weekly', escapeHtml(_t('Weekly'))], ['monthly', escapeHtml(_t('Monthly'))]], mode, 'plan-freq')}</div>
			${detail ? `<div>${detail}</div>` : ''}
			<div>${label(_t('Timing'))}<div class="flex flex-wrap gap-1.5">${TIMING.filter(t => t[0]).map(([v, icon, l]) => `<button type="button" data-plan-tod="${v}" class="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold border transition ${tod === v ? 'bg-blue-50 text-blue-700 border-blue-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}"><span class="leading-none">${icon}</span><span>${escapeHtml(_t(l))}</span></button>`).join('')}</div></div>
			<div>${label(_t('Reminder'))}
				${remNow ? `<div class="mb-2 flex items-center gap-2 text-sm"><span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold">🔔 ${escapeHtml(remNow)}</span><button type="button" data-plan-rem="" class="text-xs text-slate-500 hover:text-red-600">${escapeHtml(_t('Remove'))}</button></div>` : ''}
				${seg(remOpts, '', 'plan-rem')}
				<div data-plan-rem-custom class="hidden mt-2"><input type="datetime-local" class="rounded-lg border border-slate-200 px-2 py-1 text-sm" /></div>
			</div>
		</div>`;
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
			<button type="button" data-plan-toggle class="w-full flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left hover:border-slate-300 transition" aria-expanded="${open}">
				<span class="flex-1 min-w-0">
					<span class="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(_t('Plan'))}</span>
					<span class="block text-sm font-medium text-slate-700 truncate">${parts.map(escapeHtml).join(' · ')}</span>
					${showNext ? `<span class="block text-xs text-slate-400">${escapeHtml(_t('Next: {date}', { date: relDay(next) }))}</span>` : ''}
				</span>
				<svg class="w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>
			</button>
			${open ? editorHtml(raw) : ''}`;
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
			let b;
			if ((b = get('plan-freq'))) { if (b.dataset.planFreq !== (raw.frequency_mode || 'daily')) await setFreq(tileId, b.dataset.planFreq); return; }
			if ((b = get('plan-date'))) { const v = b.dataset.planDate; await setField(tileId, 'end_date', v && v !== raw.end_date ? v : null); return; }
			if ((b = get('plan-day'))) { const d = Number(b.dataset.planDay); const cur = weekdays(raw); const next = cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d]; await setWeekdays(tileId, next); return; }
			if ((b = get('plan-days'))) { await setWeekdays(tileId, b.dataset.planDays.split(',').map(Number)); return; }
			if ((b = get('plan-dom'))) { await setField(tileId, 'day_of_month', Number(b.dataset.planDom)); return; }
			if ((b = get('plan-tod'))) { const v = b.dataset.planTod; await setField(tileId, 'time_of_day', v && v !== tileTimeOfDay(raw) ? [v] : []); return; }
			if ((b = get('plan-rem')) !== null && b) {
				const v = b.dataset.planRem;
				if (v === 'custom') {
					const box = mount.querySelector('[data-plan-rem-custom]');
					const input = box.querySelector('input');
					input.value = toLocalInputValue(raw.reminder_at ? new Date(raw.reminder_at) : new Date(Date.now() + 3600000));
					box.classList.remove('hidden'); input.focus();
					return;
				}
				const when = v === '' ? null : v === 'timing' ? reminderForTiming(raw) : computeReminderAt(v);
				if (v !== '' && !when) return;
				await setTileReminder(tileId, when);
				window.track?.('plan_reminder_set', { preset: v || 'none' });
				refresh(tileId);
			}
		});
		mount.addEventListener('change', async e => {
			const t = e.target;
			if (t.matches('[data-plan-date-pick]')) { await setField(tileId, 'end_date', t.value || null); return; }
			if (t.closest('[data-plan-rem-custom]') && t.value) {
				const when = new Date(t.value);
				if (!isNaN(when)) { await setTileReminder(tileId, when); refresh(tileId); }
			}
		});
	}

	// Called by openTilePopup after it renders.
	window.mountTilePlan = function (tileId) { wire(tileId); render(tileId); };
})();
