// Notifications: the in-app bell (all platforms), device notifications on the
// Android app (Capacitor LocalNotifications, scheduled on-device a week ahead
// and re-armed on every app open), the Notifications section in Settings and
// a short "why" sheet before the Android permission prompt.
// Uses app.js globals: rawTiles, supa, _t, escapeHtml, todayLocal, logDay,
// statusOnDate, tileTimeOfDay, isTaskScheduledOnDate, openTilePopup,
// fetchTilesFromSupabase, formatReminderAt; progress.js: progressStreaks,
// computeWeekReview, openProgress.

// ---- Preferences (per device) ----
const NOTIF_PREFS_KEY = 'lw_notif_prefs';
const SUMMARY_BUCKETS = [
	{ key: 'morning', icon: '🌅', label: 'Morning', time: '08:00' },
	{ key: 'afternoon', icon: '☀️', label: 'Afternoon', time: '13:00' },
	{ key: 'evening', icon: '🌇', label: 'Evening', time: '18:00' },
	{ key: 'night', icon: '🌙', label: 'Night', time: '21:00' }
];
const SUMMARY_DAYS_AHEAD = 7;
const STREAK_TIME = '19:30';
const WEEKLY_TIME = '19:00';
const NOTIF_ACTION_TYPE = 'reminderActions';

function notifDefaults() {
	const buckets = {};
	SUMMARY_BUCKETS.forEach(b => { buckets[b.key] = { on: true, time: b.time }; });
	return { buckets, anytime: true, streak: true, weekly: true, comeback: true, quiet: { on: false, from: '22:30', to: '07:30' } };
}
function notifPrefs() {
	const d = notifDefaults();
	let s = {};
	try { s = JSON.parse(localStorage.getItem(NOTIF_PREFS_KEY) || '{}') || {}; } catch (e) {}
	const buckets = {};
	SUMMARY_BUCKETS.forEach(b => { buckets[b.key] = { ...d.buckets[b.key], ...((s.buckets || {})[b.key] || {}) }; });
	return { ...d, ...s, buckets, quiet: { ...d.quiet, ...(s.quiet || {}) } };
}
function saveNotifPrefs(p) {
	try { localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(p)); } catch (e) {}
}
const hhmm = s => { const [h, m] = String(s || '').split(':').map(Number); return [h || 0, m || 0]; };
const atTime = (date, s) => { const d = new Date(date); const [h, m] = hhmm(s); d.setHours(h, m, 0, 0); return d; };
const notifDayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Hour/minute of a time-of-day bucket; the Plan section uses it for timing reminders.
window.notifBucketTime = key => { const p = notifPrefs().buckets[key]; return p ? hhmm(p.time) : null; };
function inQuietHours(date, prefs) {
	if (!prefs.quiet.on) return false;
	const mins = date.getHours() * 60 + date.getMinutes();
	const [fh, fm] = hhmm(prefs.quiet.from), [th, tm] = hhmm(prefs.quiet.to);
	const from = fh * 60 + fm, to = th * 60 + tm;
	return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
}

const notifIsActive = t => !['completed', 'cancelled', 'failed'].includes((t.status || '').toLowerCase());
const notifIsOnce = t => (t.frequency_mode || 'daily') === 'once';
const openToday = (t, key) => { const st = statusOnDate(t, key); return st !== 'done' && st !== 'skipped'; };

// When a card's own reminder rings on a date. One-time cards ring once at
// reminder_at; repeating cards ring at that clock time on every scheduled day
// from reminder_at's date on.
function reminderMoment(task, date) {
	if (!task.reminder_at) return null;
	const r = new Date(task.reminder_at);
	if (isNaN(r)) return null;
	if (notifIsOnce(task)) return notifDayKey(r) === notifDayKey(date) ? r : null;
	if (notifDayKey(date) < notifDayKey(r) || !isTaskScheduledOnDate(task, date)) return null;
	const m = new Date(date); m.setHours(r.getHours(), r.getMinutes(), 0, 0);
	return m;
}

// ---- In-app bell ----
// LocalNotifications is native-only, so the bell shows due reminders (and the
// rest of today's timed cards) on every platform.
let notifiedReminderIds = new Set(); // browser Notifications already popped this session
const DISMISS_KEY = 'lw_notif_dismissed';
const dismissedToday = () => { try { const m = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); return m; } catch (e) { return {}; } };
function dismissForToday(id) {
	const today = todayLocal();
	const m = dismissedToday();
	Object.keys(m).forEach(k => { if (m[k] !== today) delete m[k]; });
	m[id] = today;
	try { localStorage.setItem(DISMISS_KEY, JSON.stringify(m)); } catch (e) {}
}

function dueReminders() {
	const now = new Date(), today = todayLocal(), dismissed = dismissedToday();
	const out = [];
	Object.values(rawTiles).forEach(t => {
		if (!t.reminder_at || !notifIsActive(t)) return;
		if (notifIsOnce(t)) {
			const when = new Date(t.reminder_at);
			if (!isNaN(when) && when <= now) out.push({ task: t, at: when, key: t.id });
			return;
		}
		const m = reminderMoment(t, now);
		if (m && m <= now && openToday(t, today) && dismissed[t.id] !== today) out.push({ task: t, at: m, key: `${t.id}:${today}`, routine: true });
	});
	return out.sort((a, b) => b.at - a.at);
}

// Today's still-open cards in time-of-day buckets that have already started.
function laterToday() {
	const now = new Date(), today = todayLocal(), prefs = notifPrefs();
	const reminded = new Set(dueReminders().map(r => r.task.id));
	return SUMMARY_BUCKETS.filter(b => atTime(now, prefs.buckets[b.key].time) <= now).map(b => ({
		bucket: b,
		tasks: Object.values(rawTiles).filter(t => notifIsActive(t) && tileTimeOfDay(t) === b.key && isTaskScheduledOnDate(t, now) && openToday(t, today) && !reminded.has(t.id))
	})).filter(g => g.tasks.length);
}

function refreshNotifications() {
	const list = dueReminders();
	const badge = document.getElementById('notifBadge');
	if (badge) {
		if (list.length) { badge.textContent = list.length > 9 ? '9+' : String(list.length); badge.classList.remove('hidden'); }
		else badge.classList.add('hidden');
	}
	// Pop a real browser notification for any newly-due reminder (if allowed).
	if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
		list.forEach(r => {
			if (notifiedReminderIds.has(r.key)) return;
			notifiedReminderIds.add(r.key);
			try { new Notification('🔔 ' + r.task.name, { body: _t('Reminder'), tag: 'lw-' + r.key }); } catch (e) {}
		});
	}
	const menu = document.getElementById('notifMenu');
	if (menu && !menu.classList.contains('hidden')) renderNotifList();
}

function renderNotifList() {
	const listEl = document.getElementById('notifList');
	if (!listEl) return;
	const list = dueReminders();
	const later = laterToday();
	const clearAll = document.getElementById('notifClearAll');
	if (clearAll) clearAll.classList.toggle('hidden', !list.length);
	if (!list.length && !later.length) {
		listEl.innerHTML = `<div class="text-center text-slate-400 text-sm py-6">${escapeHtml(_t('No reminders right now.'))}</div>`;
		return;
	}
	const row = (id, name, sub, dismiss) => `
		<div class="flex items-start justify-between gap-2 px-2 py-2 rounded-xl hover:bg-slate-50 transition">
			<button type="button" class="notif-open flex-1 text-left min-w-0" data-tile-id="${id}">
				<div translate="no" class="text-sm font-medium text-slate-700 truncate">${escapeHtml(name)}</div>
				${sub ? `<div class="text-xs text-slate-400">${sub}</div>` : ''}
			</button>
			${dismiss ? `<button type="button" class="notif-dismiss text-slate-300 hover:text-red-500 text-lg leading-none px-1" data-tile-id="${id}" title="${escapeHtml(_t('Dismiss'))}" aria-label="${escapeHtml(_t('Dismiss'))}">&times;</button>` : ''}
		</div>`;
	const time = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	listEl.innerHTML = list.map(r => row(r.task.id, r.task.name, `🔔 ${r.routine ? escapeHtml(_t('Today {time}', { time: time(r.at) })) : formatReminderAt(r.task.reminder_at)}`, true)).join('')
		+ later.map(g => `<div data-notif-bucket="${g.bucket.key}" class="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">${g.bucket.icon} ${escapeHtml(_t(g.bucket.label))} · ${escapeHtml(_t('still to do'))}</div>`
			+ g.tasks.slice(0, 8).map(t => row(t.id, t.name, '', false)).join('')).join('');
	listEl.querySelectorAll('.notif-open').forEach(b => b.addEventListener('click', () => {
		closeNotifMenu();
		openTilePopup(b.getAttribute('data-tile-id'));
	}));
	listEl.querySelectorAll('.notif-dismiss').forEach(b => b.addEventListener('click', async e => {
		e.stopPropagation();
		await dismissReminder(b.getAttribute('data-tile-id'));
	}));
}

// Repeating cards keep their reminder: dismissing only hides today's.
async function dismissReminder(id) {
	const t = rawTiles[id];
	if (t && !notifIsOnce(t)) { dismissForToday(id); refreshNotifications(); return; }
	await setTileReminder(id, null);
}

function openNotifMenu(bucket) {
	const menu = document.getElementById('notifMenu');
	const btn = document.getElementById('notifBellBtn');
	if (!menu) return;
	if (typeof Notification !== 'undefined' && Notification.permission === 'default' && !isNativeApp()) {
		try { Notification.requestPermission(); } catch (e) {}
	}
	renderNotifList();
	menu.classList.remove('hidden');
	if (btn) btn.setAttribute('aria-expanded', 'true');
	if (bucket) menu.querySelector(`[data-notif-bucket="${bucket}"]`)?.scrollIntoView({ block: 'start' });
}

function closeNotifMenu() {
	const menu = document.getElementById('notifMenu');
	const btn = document.getElementById('notifBellBtn');
	if (menu) menu.classList.add('hidden');
	if (btn) btn.setAttribute('aria-expanded', 'false');
}

function initNotifications() {
	const btn = document.getElementById('notifBellBtn');
	const menu = document.getElementById('notifMenu');
	const clearAll = document.getElementById('notifClearAll');
	if (!btn || !menu) return;
	const head = menu.querySelector('span');
	if (head) head.textContent = _t('Reminders');
	if (clearAll) clearAll.textContent = _t('Clear all');
	btn.addEventListener('click', e => {
		e.stopPropagation();
		if (menu.classList.contains('hidden')) openNotifMenu(); else closeNotifMenu();
	});
	document.addEventListener('click', e => {
		if (!menu.classList.contains('hidden') && !e.target.closest('#notifWrapper')) closeNotifMenu();
	});
	if (clearAll) clearAll.addEventListener('click', async () => {
		for (const r of dueReminders()) await dismissReminder(r.task.id);
	});
	setInterval(refreshNotifications, 60000); // surface reminders as their time arrives
	refreshNotifications();
	// Listen for notification taps early so a cold start from a tap is handled.
	const LN = nativeLN();
	if (LN && !initNotifications._listening) {
		initNotifications._listening = true;
		try { LN.addListener('localNotificationActionPerformed', onNotificationAction); } catch (e) {}
	}
}

// ---- Device notifications (Android app) ----
function isNativeApp() {
	const cap = window.Capacitor;
	return !!(cap && cap.isNativePlatform && cap.isNativePlatform());
}
function nativeLN() {
	const cap = window.Capacitor;
	const LN = cap && cap.Plugins && cap.Plugins.LocalNotifications;
	return LN && isNativeApp() ? LN : null;
}

// Log a done/skip straight to Supabase from a notification button. Doesn't rely
// on rawTiles being loaded (the app may be cold-starting).
async function logFromNotification(taskId, status) {
	const today = todayLocal();
	const { data: existing } = await supa
		.from('task_logs')
		.select('id')
		.eq('task_id', taskId)
		.eq('log_date', today)
		.in('status', ['done', 'completed', 'skipped'])
		.limit(1);
	if (existing && existing.length) await supa.from('task_logs').update({ status }).eq('id', existing[0].id);
	else await supa.from('task_logs').insert({ task_id: taskId, status, log_date: today });
}

// Wait (briefly) for the cards to load after a cold start.
async function notifWhenLoaded(test) {
	for (let i = 0; i < 40 && !test(); i++) await new Promise(r => setTimeout(r, 250));
	return test();
}

async function onNotificationAction(event) {
	const action = event && event.actionId;
	const extra = (event && event.notification && event.notification.extra) || {};
	window.track?.('notification_opened', { kind: extra.kind || (extra.taskId ? 'reminder' : 'other'), action: action || 'tap' });
	if (extra.taskId && (action === 'done' || action === 'skip')) {
		try {
			const { data: { session } } = await supa.auth.getSession();
			if (!session) return;
			await logFromNotification(extra.taskId, action === 'done' ? 'done' : 'skipped');
			await fetchTilesFromSupabase(); // refresh gallery + reschedule
		} catch (e) { console.error('notification action error:', e); }
		return;
	}
	// Plain tap: take the user to what the notification was about.
	if (extra.taskId) { if (await notifWhenLoaded(() => rawTiles[extra.taskId])) openTilePopup(extra.taskId); return; }
	if (extra.kind === 'weekly') { await notifWhenLoaded(() => Object.keys(rawTiles).length); window.openProgress?.(); return; }
	if (extra.kind === 'summary' || extra.kind === 'streak') { await notifWhenLoaded(() => Object.keys(rawTiles).length); openNotifMenu(extra.summary); }
}

// Build the whole schedule from the current cards and prefs (pure, so it can be tested).
function buildNotifications(tasks, now, prefs) {
	const out = [];
	const active = tasks.filter(notifIsActive);
	const fmtNames = arr => arr.slice(0, 6).join(', ') + (arr.length > 6 ? ', ' + _t('+{n} more', { n: arr.length - 6 }) : '');
	const push = (n, quietable) => { if (n.schedule.at <= now) return; if (quietable && inQuietHours(n.schedule.at, prefs)) return; out.push(n); };

	for (let dayOffset = 0; dayOffset < SUMMARY_DAYS_AHEAD; dayOffset++) {
		const date = new Date(now); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + dayOffset);
		const key = notifDayKey(date);
		const isToday = dayOffset === 0;
		const todo = t => isTaskScheduledOnDate(t, date) && (!isToday || openToday(t, key));

		// Cards' own reminders (repeating ones every scheduled day).
		const reminded = new Set();
		active.forEach(t => {
			const at = reminderMoment(t, date);
			if (!at) return;
			reminded.add(t.id);
			if (!notifIsOnce(t) && !todo(t)) return;
			push({ title: `🔔 ${t.name}`, body: _t('Reminder'), channelId: 'reminders', actionTypeId: NOTIF_ACTION_TYPE, extra: { kind: 'reminder', taskId: t.id }, schedule: { at, allowWhileIdle: true } }, false);
		});

		// Time-of-day summaries; cards with their own reminder that day are left out.
		const due = {};
		SUMMARY_BUCKETS.forEach(b => { due[b.key] = active.filter(t => tileTimeOfDay(t) === b.key && !reminded.has(t.id) && todo(t)); });
		const anytime = prefs.anytime ? active.filter(t => !tileTimeOfDay(t) && !reminded.has(t.id) && todo(t)) : [];
		let carried = [];
		// 'Any time' cards ride along with the first enabled summary still ahead.
		const anyIdx = SUMMARY_BUCKETS.findIndex(x => prefs.buckets[x.key].on && atTime(date, prefs.buckets[x.key].time) > now && !inQuietHours(atTime(date, prefs.buckets[x.key].time), prefs));
		SUMMARY_BUCKETS.forEach((b, idx) => {
			const p = prefs.buckets[b.key];
			const own = due[b.key];
			if (!p.on) { if (isToday) carried = carried.concat(own); return; }
			const at = atTime(date, p.time);
			const pending = isToday ? carried : [];
			const extraAny = idx === anyIdx ? anytime : [];
			if (isToday) carried = carried.concat(own);
			const total = own.length + pending.length + extraAny.length;
			if (!total || at <= now) return;
			const lines = [];
			if (pending.length) lines.push('⏰ ' + _t('Still pending:') + ' ' + fmtNames(pending.map(t => t.name)));
			if (own.length) lines.push((pending.length || extraAny.length ? `${b.icon} ${_t(b.label)}: ` : '') + fmtNames(own.map(t => t.name)));
			if (extraAny.length) lines.push(`🕒 ${_t('Any time')}: ` + fmtNames(extraAny.map(t => t.name)));
			push({ title: `${b.icon} ${_t('{label} — {count} to do', { label: _t(b.label), count: total })}`, body: lines.join('\n'), channelId: 'reminders', extra: { kind: 'summary', summary: b.key, date: key }, schedule: { at, allowWhileIdle: true } }, true);
		});

		// 🔥 Streaks at risk (today only: tomorrow's depends on today).
		if (isToday && prefs.streak && typeof progressStreaks === 'function') {
			const risky = active.filter(t => !notifIsOnce(t) && todo(t)).map(t => {
				const logs = t.task_logs || [];
				const done = new Set(logs.filter(l => l.status === 'done' || l.status === 'completed').map(logDay));
				const skipped = new Set(logs.filter(l => l.status === 'skipped').map(logDay));
				return { t, n: progressStreaks(t, done, skipped, now).current };
			}).filter(x => x.n >= 3).sort((a, b) => b.n - a.n);
			if (risky.length) {
				const top = risky[0];
				push({
					title: risky.length === 1 ? `🔥 ${_t('{name}: {n} in a row', { name: top.t.name, n: top.n })}` : `🔥 ${_t('{n} streaks at risk today', { n: risky.length })}`,
					body: risky.length === 1 ? _t("Don't break it today.") : fmtNames(risky.map(x => `${x.t.name} (${x.n})`)),
					channelId: 'reminders', extra: { kind: 'streak' }, schedule: { at: atTime(date, STREAK_TIME), allowWhileIdle: true }
				}, true);
			}
		}

		// 📊 Weekly review on Sunday evening.
		if (prefs.weekly && date.getDay() === 0) {
			let body = _t('See how your week went and plan the next one with your coach.');
			if (isToday && typeof computeWeekReview === 'function') {
				try {
					const w = computeWeekReview(active, () => ({ key: '', label: '', color: '' }), now);
					body = _t('{done} done · {skipped} skipped this week. Tap to see where your time went.', { done: w.totals.done, skipped: w.totals.skipped });
				} catch (e) {}
			}
			push({ title: `📊 ${_t('Your week in review')}`, body, channelId: 'reminders', extra: { kind: 'weekly' }, schedule: { at: atTime(date, WEEKLY_TIME), allowWhileIdle: true } }, true);
		}
	}

	// 👋 Come back: only fires if the app isn't opened again (every open re-arms).
	if (prefs.comeback && active.length) {
		[8, 15].forEach(days => {
			const d = new Date(now); d.setDate(d.getDate() + days);
			let at = atTime(d, prefs.buckets.morning.time);
			if (inQuietHours(at, prefs)) at = atTime(d, prefs.quiet.to);
			push({ title: `👋 ${_t('Your cards are waiting')}`, body: _t('A two-minute check-in keeps your routines alive.'), channelId: 'reminders', extra: { kind: 'comeback' }, schedule: { at, allowWhileIdle: true } }, false);
		});
	}
	return out.map((n, i) => ({ id: i + 1, ...n }));
}

async function notifPermission() {
	const LN = nativeLN();
	if (!LN) return 'unsupported';
	try { return (await LN.checkPermissions()).display; } catch (e) { return 'unsupported'; }
}

async function scheduleReminders() {
	const LN = nativeLN();
	if (!LN) return;
	try {
		// Never prompt here: the permission is asked with context (maybeAskNotif).
		if ((await LN.checkPermissions()).display !== 'granted') return;
		try { await LN.createChannel({ id: 'reminders', name: 'Reminders', importance: 4, visibility: 1 }); } catch (e) {}
		if (!scheduleReminders._init) {
			scheduleReminders._init = true;
			try {
				await LN.registerActionTypes({ types: [{ id: NOTIF_ACTION_TYPE, actions: [{ id: 'done', title: '✅ ' + _t('Done') }, { id: 'skip', title: '⏭️ ' + _t('Skip'), destructive: true }] }] });
			} catch (e) { console.error('registerActionTypes error:', e); }
		}
		const pending = await LN.getPending();
		if (pending && pending.notifications && pending.notifications.length) {
			await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
		}
		const notifications = buildNotifications(Object.values(rawTiles), new Date(), notifPrefs());
		if (notifications.length) await LN.schedule({ notifications });
	} catch (e) {
		console.error('scheduleReminders error:', e);
	}
}

// ---- Asking for permission, with context ----
const ASK_KEY = 'lw_notif_asked';
async function requestNotifPermission() {
	const LN = nativeLN();
	if (!LN) return false;
	let perm = 'denied';
	try { perm = (await LN.requestPermissions()).display; } catch (e) {}
	window.track?.('notification_permission', { result: perm });
	if (perm === 'granted') await scheduleReminders();
	return perm === 'granted';
}
// Show a short explanation before Android's prompt; at most once every 2 weeks.
async function maybeAskNotif(reason) {
	const perm = await notifPermission();
	if (perm !== 'prompt' && perm !== 'prompt-with-rationale') return;
	let last = 0;
	try { last = Number(localStorage.getItem(ASK_KEY) || 0); } catch (e) {}
	if (reason !== 'settings' && Date.now() - last < 14 * 86400000) return;
	try { localStorage.setItem(ASK_KEY, String(Date.now())); } catch (e) {}
	document.getElementById('notifAsk')?.remove();
	const box = document.createElement('div');
	box.id = 'notifAsk';
	box.className = 'fixed inset-0 z-[80] bg-slate-900/20 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-4';
	box.innerHTML = `<div role="dialog" aria-modal="true" class="w-full max-w-sm rounded-3xl bg-white border border-slate-200 shadow-2xl shadow-slate-900/10 p-5">
		<div class="text-3xl mb-2">🔔</div>
		<div class="text-base font-semibold text-slate-800 mb-1">${escapeHtml(_t('Get a nudge at the right time'))}</div>
		<ul class="text-sm text-slate-600 space-y-1 mb-4">
			<li>• ${escapeHtml(_t('Your reminders, on the days they repeat'))}</li>
			<li>• ${escapeHtml(_t('A short list for each part of the day'))}</li>
			<li>• ${escapeHtml(_t('A heads-up when a streak is at risk'))}</li>
		</ul>
		<div class="text-xs text-slate-400 mb-4">${escapeHtml(_t('You can change times or turn any of these off in Settings.'))}</div>
		<div class="flex gap-2">
			<button type="button" data-ask-no class="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold hover:bg-slate-200">${escapeHtml(_t('Not now'))}</button>
			<button type="button" data-ask-yes class="flex-1 py-2.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 text-sm font-semibold hover:bg-blue-100">${escapeHtml(_t('Turn on'))}</button>
		</div></div>`;
	document.body.appendChild(box);
	window.track?.('notification_ask_shown', { reason });
	box.addEventListener('click', async e => {
		if (e.target.closest('[data-ask-yes]')) { box.remove(); await requestNotifPermission(); window.mountNotifSettings?.(); return; }
		if (e.target === box || e.target.closest('[data-ask-no]')) box.remove();
	});
}
window.maybeAskNotif = maybeAskNotif;

// ---- Settings → Notifications ----
window.mountNotifSettings = async function () {
	const mount = document.getElementById('notifSettingsMount');
	if (!mount) return;
	const prefs = notifPrefs();
	const native = isNativeApp();
	const perm = await notifPermission();
	let exact = null;
	const LN = nativeLN();
	if (LN && perm === 'granted' && typeof LN.checkExactNotificationSetting === 'function') {
		try { exact = (await LN.checkExactNotificationSetting()).exact_alarm; } catch (e) {}
	}
	const toggle = (attr, on, label, sub) => `<label class="flex items-center justify-between gap-3 py-1.5 cursor-pointer">
		<span class="min-w-0"><span class="block text-sm text-slate-700">${label}</span>${sub ? `<span class="block text-[11px] text-slate-400">${escapeHtml(sub)}</span>` : ''}</span>
		<input type="checkbox" ${attr} ${on ? 'checked' : ''} class="peer sr-only" />
		<span class="relative shrink-0 w-9 h-5 rounded-full transition ${on ? 'bg-blue-300' : 'bg-slate-200'}"><span class="absolute top-0.5 ${on ? 'left-[18px]' : 'left-0.5'} w-4 h-4 rounded-full bg-white shadow transition-all"></span></span>
	</label>`;
	const timeInput = (attr, v, disabled) => `<input type="time" ${attr} value="${v}" ${disabled ? 'disabled' : ''} class="w-[92px] rounded-lg border border-slate-200 px-2 py-1 text-sm tabular-nums disabled:opacity-40" />`;
	let status;
	if (!native) status = `<div class="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">${escapeHtml(_t('Phone notifications work in the Android app. Here, reminders show in the 🔔 bell.'))}</div>`;
	else if (perm === 'granted') status = `<div class="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">✓ ${escapeHtml(_t('Notifications are on'))}</div>`;
	else if (perm === 'denied') status = `<div class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">${escapeHtml(_t('Notifications are blocked. Turn them on in Android Settings → Apps → Fiblia → Notifications.'))}</div>`;
	else status = `<button type="button" data-notif-enable class="w-full py-2 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 text-sm font-semibold hover:bg-blue-100">🔔 ${escapeHtml(_t('Turn on notifications'))}</button>`;
	if (exact === 'denied') status += `<button type="button" data-notif-exact class="mt-2 w-full py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold hover:bg-amber-100">⏱️ ${escapeHtml(_t('Allow exact timing (otherwise they may arrive a few minutes late)'))}</button>`;
	mount.innerHTML = `
		<div class="text-sm font-semibold mb-1">🔔 ${escapeHtml(_t('Notifications'))}</div>
		${status}
		<div class="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(_t('Daily summaries'))}</div>
		${SUMMARY_BUCKETS.map(b => { const p = prefs.buckets[b.key]; return `<div class="flex items-center gap-2 py-1">
			<span class="flex-1 text-sm text-slate-700">${b.icon} ${escapeHtml(_t(b.label))}</span>
			${timeInput(`data-notif-time="${b.key}"`, p.time, !p.on)}
			<input type="checkbox" data-notif-bucket-on="${b.key}" ${p.on ? 'checked' : ''} class="w-4 h-4 accent-blue-500" aria-label="${escapeHtml(_t(b.label))}" />
		</div>`; }).join('')}
		<div class="text-[11px] text-slate-400 mb-1">${escapeHtml(_t('Each lists the cards with that timing that are still open. These times are also used for timing reminders.'))}</div>
		${toggle('data-notif-flag="anytime"', prefs.anytime, `🕒 ${escapeHtml(_t('Add “Any time” cards to the first summary'))}`)}
		${toggle('data-notif-flag="streak"', prefs.streak, `🔥 ${escapeHtml(_t('Streak at risk'))}`, _t('At {time}, if a streak of 3+ is still open', { time: STREAK_TIME }))}
		${toggle('data-notif-flag="weekly"', prefs.weekly, `📊 ${escapeHtml(_t('Weekly review'))}`, _t('Sunday {time}', { time: WEEKLY_TIME }))}
		${toggle('data-notif-flag="comeback"', prefs.comeback, `👋 ${escapeHtml(_t('Nudge me if I’m away for a week'))}`)}
		${toggle('data-notif-quiet', prefs.quiet.on, `🌙 ${escapeHtml(_t('Quiet hours'))}`, _t('Summaries and nudges wait; your own reminders still ring.'))}
		${prefs.quiet.on ? `<div class="flex items-center gap-2 pb-1 pl-1 text-sm text-slate-600">${timeInput('data-notif-quiet-from', prefs.quiet.from)}<span>–</span>${timeInput('data-notif-quiet-to', prefs.quiet.to)}</div>` : ''}
		${native && perm === 'granted' ? `<button type="button" data-notif-test class="mt-2 w-full py-2 rounded-xl bg-slate-100 text-slate-700 text-sm font-semibold hover:bg-slate-200">${escapeHtml(_t('Send a test notification'))}</button>` : ''}`;
	if (mount.dataset.wired) return;
	mount.dataset.wired = '1';
	const save = p => { saveNotifPrefs(p); scheduleReminders(); window.mountNotifSettings(); };
	mount.addEventListener('change', e => {
		const t = e.target, p = notifPrefs();
		if (t.matches('[data-notif-time]')) { if (t.value) { p.buckets[t.dataset.notifTime].time = t.value; save(p); } return; }
		if (t.matches('[data-notif-bucket-on]')) { p.buckets[t.dataset.notifBucketOn].on = t.checked; save(p); return; }
		if (t.matches('[data-notif-flag]')) { p[t.dataset.notifFlag] = t.checked; save(p); return; }
		if (t.matches('[data-notif-quiet]')) { p.quiet.on = t.checked; save(p); return; }
		if (t.matches('[data-notif-quiet-from]') && t.value) { p.quiet.from = t.value; save(p); return; }
		if (t.matches('[data-notif-quiet-to]') && t.value) { p.quiet.to = t.value; save(p); }
	});
	mount.addEventListener('click', async e => {
		const LN2 = nativeLN();
		if (e.target.closest('[data-notif-enable]')) {
			const perm2 = await notifPermission();
			if (perm2 === 'prompt' || perm2 === 'prompt-with-rationale') await requestNotifPermission();
			window.mountNotifSettings();
			return;
		}
		if (e.target.closest('[data-notif-exact]') && LN2 && LN2.changeExactNotificationSetting) { try { await LN2.changeExactNotificationSetting(); } catch (err) {} window.mountNotifSettings(); return; }
		if (e.target.closest('[data-notif-test]') && LN2) {
			try {
				await LN2.schedule({ notifications: [{ id: 999999, title: '🔔 Fiblia', body: _t('Notifications work. You’ll get this in 5 seconds.'), channelId: 'reminders', schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true } }] });
				e.target.closest('[data-notif-test]').textContent = '✓ ' + _t('Sent, check in 5 seconds');
			} catch (err) { console.error('test notification error:', err); }
		}
	});
};
