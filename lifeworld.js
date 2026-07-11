// Create a tile by name (no prompt)
async function createTileByName(name) {
	if (!name || !name.trim() || !currentUserId) return;
	const { data, error } = await supa
		.from('tasks')
		.insert({
			user_id: currentUserId,
			name: name.trim(),
			frequency_mode: 'daily'
		})
		.select('*, task_logs(*), task_frequency_days(*)')
		.single();
	if (error || !data) return;
	rawTiles[data.id] = data;
	const health = calculateHealth(data);
	const plant = healthToPlant(health);
	tiles.push({
		id: data.id,
		name: data.name,
		tags: data.tag_ids || [],
		status: 'noaction',
		taskStatus: data.status || 'in progress',
		emoji: plant.emoji,
		health,
		healthLabel: plant.label,
		healthColor: plant.color,
		count: 0,
		createdAt: data.created_at || null,
		lastUpdate: null
	});
	applyFilters();
	openTilePopup(data.id);
	scheduleReminders();
}
let tiles = [];
let rawTiles = {}; // full task objects keyed by uuid
let activeTileId = null; // currently open tile
let activeTagFilter = null; // currently active tag filter
let activeTimelineFilter = null; // 'today' or null
let activeStatusFilter = null; // null, 'done', 'skipped', 'noaction'
let activeLifecycleFilter = 'active'; // 'active' (planned+in progress), 'all', 'completed', 'failed', 'cancelled'
let activeMoodFilter = null; // null = all, else a mood label ('Thriving', 'Dying', ...)
let activeFreqFilter = null; // null = all, else 'daily' | 'weekly' | 'monthly' | 'once'
let ALL_TAGS = [];        // [{ key: tagId, label: name }] for legacy call sites
let TAGS = [];            // rows from public.tags: { id, name, parent_id, sort_order }
let TAGS_BY_ID = {};      // id -> tag row
let tagManageMode = false; // tag filter popup: manage (reorder/parent/delete) vs filter
let refreshTagTree = null; // re-renders just the tag tree in place (preserves scroll/search)
let currentUserId = null;
// Trusted premium flag (server-set app_metadata; never user_metadata). Gates
// premium-only features like attachments in the UI — RLS enforces it for real.
let currentUserIsPremium = false;
function isPremiumUser() { return !!currentUserIsPremium; }

// Load the user's tags from the tags table.
async function loadTags() {
	const { data, error } = await supa.from('tags').select('id,name,parent_id,sort_order');
	TAGS = (!error && data) ? data : [];
	rebuildTagIndex();
}

// Rebuild lookup structures from the in-memory TAGS array (after a local change).
function rebuildTagIndex() {
	TAGS_BY_ID = {};
	TAGS.forEach(t => { TAGS_BY_ID[t.id] = t; });
	ALL_TAGS = TAGS.map(t => ({ key: t.id, label: t.name }));
}

// Breadcrumb path for a tag id, e.g. "family › defne › hobby".
function tagPath(id) {
	const parts = [];
	let cur = TAGS_BY_ID[id], guard = 0;
	while (cur && guard++ < 30) { parts.unshift(cur.name); cur = cur.parent_id ? TAGS_BY_ID[cur.parent_id] : null; }
	return parts.join(' › ');
}

// Display name for a tag id (falls back to the id if unknown).
function tagName(id) {
	return TAGS_BY_ID[id] ? TAGS_BY_ID[id].name : id;
}

// ---- Health Score ----
// The day a log applies to (the user-chosen date), NOT when the row was inserted.
// created_at is only a fallback for legacy rows without log_date.
function logDay(log) {
	return log.log_date || (log.created_at ? log.created_at.split('T')[0] : '');
}

function calculateHealth(task) {
	const logs = task.task_logs || [];
	const mode = task.frequency_mode || 'daily';
	const freqDays = (task.task_frequency_days || []).map(d => d.day_of_week);
	const now = new Date();
	const startDate = task.created_at ? new Date(task.created_at) : now;
	const lookbackDays = 30;
	const lookbackStart = new Date(now);
	lookbackStart.setDate(lookbackStart.getDate() - lookbackDays);
	const effectiveStart = startDate > lookbackStart ? startDate : lookbackStart;

	// Build a set of dates with 'done' logs
	const doneDates = new Set();
	const skipDates = new Set();
	logs.forEach(log => {
		const d = logDay(log);
		if (log.status === 'done' || log.status === 'completed') doneDates.add(d);
		if (log.status === 'skipped') skipDates.add(d);
	});

	if (mode === 'once') {
		if (doneDates.size > 0) return 100;
		if (task.end_date && new Date(task.end_date) < now) return 0;
		return 50; // not yet due
	}

	// Count expected vs fulfilled days
	let expected = 0;
	let fulfilled = 0;
	for (let d = new Date(effectiveStart); d <= now; d.setDate(d.getDate() + 1)) {
		const dayOfWeek = d.getDay();
		const dateStr = d.toISOString().split('T')[0];
		let isExpected = false;
		if (mode === 'daily') isExpected = true;
		else if (mode === 'weekly') isExpected = freqDays.includes(dayOfWeek);
		else if (mode === 'monthly') {
			// Expect once per month on the chosen day-of-month (clamped for short months).
			const md = monthlyDateFor(task, d.getFullYear(), d.getMonth());
			isExpected = d.getDate() === md.getDate();
		}
		if (isExpected) {
			expected++;
			if (doneDates.has(dateStr)) fulfilled++;
		}
	}

	if (expected === 0) return 50; // no data yet
	return Math.round((fulfilled / expected) * 100);
}

function healthToPlant(score) {
	if (score >= 80) return { emoji: '⭐', label: 'Thriving', color: 'bg-green-50 border-green-200' };
	if (score >= 60) return { emoji: '☀️', label: 'Healthy', color: 'bg-emerald-50 border-emerald-200' };
	if (score >= 40) return { emoji: '⛅', label: 'Growing', color: 'bg-yellow-50 border-yellow-200' };
	if (score >= 20) return { emoji: '🌧️', label: 'Wilting', color: 'bg-orange-50 border-orange-200' };
	return { emoji: '⚡', label: 'Dying', color: 'bg-red-50 border-red-200' };
}

// Visuals for a tile. Finished lifecycle states get a status icon (🏁 finish
// line) instead of a health/weather emoji — a completed task stops being
// logged, so its health would otherwise decay to "dying" and mislead.
function tilePlant(task, health) {
	const status = (task && task.status || '').toLowerCase();
	if (status === 'completed') return { emoji: '🏁', label: 'Completed', color: 'bg-emerald-50 border-emerald-200', finished: true };
	if (status === 'cancelled') return { emoji: '🚫', label: 'Cancelled', color: 'bg-slate-50 border-slate-200', finished: true };
	if (status === 'failed') return { emoji: '🏴', label: 'Failed', color: 'bg-red-50 border-red-200', finished: true };
	return healthToPlant(health);
}

// Day-of-month a monthly task recurs on (1–31). Falls back to the creation day
// when unset (or if the day_of_month column isn't present in the DB yet).
function monthlyDom(task) {
	const dom = parseInt(task && task.day_of_month, 10);
	if (dom >= 1 && dom <= 31) return dom;
	return (task && task.created_at) ? new Date(task.created_at).getDate() : 1;
}

// The monthly day resolved to a real date in a given year/month, clamped to the
// last day for short months (e.g. 31 → 28/30).
function monthlyDateFor(task, year, month) {
	const last = new Date(year, month + 1, 0).getDate();
	return new Date(year, month, Math.min(monthlyDom(task), last));
}

function ordinal(n) {
	const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Local calendar date as YYYY-MM-DD. Logs are saved with the user's LOCAL
// date (flatpickr 'Y-m-d'), so "today" must also be local. Using UTC
// (toISOString) makes yesterday's logs count as today during the window
// between local midnight and the UTC date rollover (e.g. 00:00–03:00 in TR).
function todayLocal() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- Data Fetching ----
function getTodayStatus(logs) {
	const today = todayLocal();
	const todayLog = (logs || []).find(l => logDay(l) === today && (l.status === 'done' || l.status === 'skipped' || l.status === 'completed'));
	if (!todayLog) return 'noaction';
	if (todayLog.status === 'completed' || todayLog.status === 'done') return 'done';
	if (todayLog.status === 'skipped') return 'skipped';
	return 'noaction';
}

async function fetchTilesFromSupabase() {
	const { data: { session } } = await supa.auth.getSession();
	if (!session || !session.user) {
		renderGallery([]);
		return;
	}
	currentUserId = session.user.id;
	currentUserIsPremium = !!(session.user.app_metadata && session.user.app_metadata.premium);

	// Fetch tasks with related logs and frequency days
	const { data, error } = await supa
		.from("tasks")
		.select("*, task_logs(*), task_frequency_days(*)")
		.eq("user_id", session.user.id);

	if (error || !data) {
		console.error('Fetch error:', error);
		renderGallery([]);
		return;
	}

	rawTiles = {};
	       data.forEach(task => {
		       // Sort logs newest first by log_date (fallback to created_at)
			       if (task.task_logs) {
				       task.task_logs.sort((a, b) => {
					       const dateA = new Date(a.log_date || a.created_at);
					       const dateB = new Date(b.log_date || b.created_at);
					       return dateB - dateA; // newest to oldest
				       });
			       }
		       rawTiles[task.id] = task;
	       });

	       tiles = data.map(task => {
		       const logs = task.task_logs || [];
		       // Find the most recent 'done' log
		       const lastDoneLog = logs.find(l => l.status === 'done');
		       const lastLog = logs[0];
		       const health = calculateHealth(task);
		       const plant = healthToPlant(health);
		       return {
			       id: task.id,
			       name: task.name,
			       tags: task.tag_ids || [],
			       status: getTodayStatus(logs),
			       taskStatus: task.status || 'in progress',
			       emoji: plant.emoji,
			       health,
			       healthLabel: plant.label,
			       healthColor: plant.color,
			       count: logs.length,
			       createdAt: task.created_at || null,
			       lastUpdate: lastDoneLog ? (lastDoneLog.log_date || lastDoneLog.created_at) : (lastLog ? (lastLog.log_date || lastLog.created_at) : null)
		       };
	       });

	await loadTags();
	applyFilters(); // apply the default filters (e.g. 🔥 Active) on first paint
	scheduleReminders();
	if (typeof refreshNotifications === 'function') refreshNotifications(); // update the bell badge
	lastRenderedDay = todayLocal(); // for day-rollover auto-refresh
}

// When the app/tab is reopened on a new calendar day, re-fetch so the
// done/skip flags reset for the new day (they're date-based, but the cached
// `tiles` won't recompute on their own if the app stayed open overnight).
let lastRenderedDay = null;
function maybeRefreshForNewDay() {
	if (lastRenderedDay && todayLocal() !== lastRenderedDay) {
		fetchTilesFromSupabase();
	}
}

// ---- Gallery Rendering ----
function getNextDueLabel(tileId) {
	const raw = rawTiles[tileId];
	if (!raw) return '';
	const mode = raw.frequency_mode || 'daily';
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	if (mode === 'daily') return 'today';

	if (mode === 'once') {
		if (!raw.end_date) return '—';
		const d = new Date(raw.end_date + 'T00:00:00');
		const diff = Math.round((d - today) / 86400000);
		if (diff < 0) return 'overdue';
		if (diff === 0) return 'today';
		if (diff === 1) return 'tomorrow';
		if (diff <= 7) return `in ${diff} days`;
		return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} '${String(d.getFullYear()).slice(-2)}`;
	}

	if (mode === 'weekly') {
		const freqDays = (raw.task_frequency_days || []).map(d => d.day_of_week);
		if (freqDays.length === 0) return '—';
		const todayDay = today.getDay();
		// Find next scheduled day
		for (let offset = 0; offset < 7; offset++) {
			if (freqDays.includes((todayDay + offset) % 7)) {
				if (offset === 0) return 'today';
				if (offset === 1) return 'tomorrow';
				return `in ${offset} days`;
			}
		}
		return '—';
	}

	if (mode === 'monthly') {
		let next = monthlyDateFor(raw, today.getFullYear(), today.getMonth());
		if (next < today) next = monthlyDateFor(raw, today.getFullYear(), today.getMonth() + 1);
		const diff = Math.round((next - today) / 86400000);
		if (diff === 0) return 'today';
		if (diff === 1) return 'tomorrow';
		if (diff <= 7) return `in ${diff} days`;
		return `${next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} '${String(next.getFullYear()).slice(-2)}`;
	}

	return '—';
}

function renderGallery(filteredTiles) {
	const gallery = document.getElementById("gallery");
	gallery.innerHTML = "";
	if (!filteredTiles.length) {
		gallery.innerHTML = '<div class="col-span-full text-center text-slate-500 py-8">No tiles found.</div>';
		return;
	}

	const groups = {};
	filteredTiles.forEach(tile => {
		const tag = (tile.tags && tile.tags.length > 0) ? tile.tags[0] : 'Untagged';
		if (!groups[tag]) groups[tag] = [];
		groups[tag].push(tile);
	});

	const groupLabel = tag => tag === 'Untagged' ? 'Untagged' : tagPath(tag);
	Object.keys(groups).sort((a, b) => groupLabel(a).localeCompare(groupLabel(b))).forEach(tag => {
		// Sort tiles within group by sort_order (then name as fallback)
		groups[tag].sort((a, b) => {
			const aOrder = (rawTiles[a.id] && rawTiles[a.id].sort_order != null) ? rawTiles[a.id].sort_order : 999999;
			const bOrder = (rawTiles[b.id] && rawTiles[b.id].sort_order != null) ? rawTiles[b.id].sort_order : 999999;
			if (aOrder !== bOrder) return aOrder - bOrder;
			return a.name.localeCompare(b.name);
		});

		const groupSection = document.createElement('section');
		groupSection.className = 'mb-4';

		const heading = document.createElement('div');
		heading.className = 'text-xl font-bold mb-2 mt-8 pl-1';
		heading.textContent = groupLabel(tag);
		groupSection.appendChild(heading);

		const groupGrid = document.createElement('div');
		groupGrid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4';
		groupGrid.dataset.tagGroup = tag;
		groups[tag].forEach(tile => {
			const tileDiv = document.createElement("div");
			const tp = tilePlant({ status: tile.taskStatus }, tile.health);
			const tileColor = tp.color || tile.healthColor || 'bg-white';
			// Remove color class from tile, use data attribute for gradient
			tileDiv.className = `tile rounded-xl shadow border p-4 flex flex-col items-center justify-between gap-2 hover:shadow-lg transition cursor-pointer`;
			tileDiv.setAttribute('data-tilecolor', tileColor);
			tileDiv.draggable = true;
			tileDiv.dataset.tileId = tile.id;
			const lastUpd = tile.lastUpdate ? new Date(tile.lastUpdate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
			const createdAt = tile.createdAt ? new Date(tile.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
			const nextDue = getNextDueLabel(tile.id);
			const nextDueClass = nextDue === 'today' ? 'text-blue-500 font-semibold' : nextDue === 'tomorrow' ? 'text-indigo-400' : nextDue === 'overdue' ? 'text-red-500 font-semibold' : 'text-slate-400';
			tileDiv.innerHTML = `
				   <div class="flex w-full justify-between items-start mb-2">
					   <div class="font-semibold text-left truncate w-3/4">${tile.name}</div>
					   <div class="text-base text-right w-1/4">${tp.emoji}</div>
				   </div>
				   <div class="flex gap-2 mt-1">
					   <span class="text-xs ${tile.status === 'noaction' ? 'text-amber-500 font-semibold' : 'text-slate-500'}">${tile.status === 'noaction' ? 'take action now' : tile.status}</span>
					   <span class="text-xs text-slate-500">(${tile.count})</span>
				   </div>
				   ${tp.finished ? `<div class="text-xs font-semibold text-slate-600">${tp.label}</div>` : ''}
				   <div class="flex justify-between items-center w-full mt-1">
					   <span class="text-xs ${nextDueClass}">🔔 ${nextDue}</span>
					   <span class="text-xs text-slate-400">🕓 ${lastUpd}</span>
				   </div>
				   <div class="flex gap-2 mt-2 w-full">
					   <button class="quick-done flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${tile.status === 'done' || tile.status === 'completed' ? 'bg-[#800000] text-white' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}" data-tile-id="${tile.id}">✅ Done</button>
					   <button class="quick-skip flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${tile.status === 'skipped' ? 'bg-[#800000] text-white' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}" data-tile-id="${tile.id}">⏭️ Skip</button>
				   </div>
			   `;

			// Open tile detail on click (except quick buttons)
			tileDiv.addEventListener('click', (e) => {
				if (e.target.closest('.quick-done') || e.target.closest('.quick-skip')) return;
				openTilePopup(tile.id);
			});


			// Drag-and-drop events
			tileDiv.addEventListener('dragstart', (e) => {
				e.dataTransfer.setData('text/plain', tile.id);
				e.dataTransfer.effectAllowed = 'move';
				tileDiv.classList.add('opacity-40', 'scale-95');
				setTimeout(() => tileDiv.classList.add('ring-2', 'ring-blue-400'), 0);
			});
			tileDiv.addEventListener('dragend', () => {
				tileDiv.classList.remove('opacity-40', 'scale-95', 'ring-2', 'ring-blue-400');
				document.querySelectorAll('.drag-over-indicator').forEach(el => el.remove());
			});
			tileDiv.addEventListener('dragover', (e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
				tileDiv.classList.add('ring-2', 'ring-blue-300');
			});
			tileDiv.addEventListener('dragleave', () => {
				tileDiv.classList.remove('ring-2', 'ring-blue-300');
			});
			tileDiv.addEventListener('drop', (e) => {
				e.preventDefault();
				tileDiv.classList.remove('ring-2', 'ring-blue-300');
				const draggedId = e.dataTransfer.getData('text/plain');
				if (draggedId && draggedId !== tile.id) handleTileDrop(draggedId, tile.id, tag);
			});

			tileDiv.querySelector('.quick-done').addEventListener('click', (e) => {
				e.stopPropagation();
				quickLog(tile.id, 'done');
			});
			tileDiv.querySelector('.quick-skip').addEventListener('click', (e) => {
				e.stopPropagation();
				quickLog(tile.id, 'skipped');
			});
			groupGrid.appendChild(tileDiv);
		});
		groupSection.appendChild(groupGrid);
		gallery.appendChild(groupSection);
	});


}



// ---- Drag-and-Drop Reorder ----
async function handleTileDrop(draggedId, targetId, tagGroup) {
	// Get the tiles in this tag group in their current sort order
	const groupTiles = tiles.filter(t => {
		const firstTag = (t.tags && t.tags.length > 0) ? t.tags[0] : 'Untagged';
		return firstTag === tagGroup;
	}).sort((a, b) => {
		const aOrder = (rawTiles[a.id] && rawTiles[a.id].sort_order != null) ? rawTiles[a.id].sort_order : 999999;
		const bOrder = (rawTiles[b.id] && rawTiles[b.id].sort_order != null) ? rawTiles[b.id].sort_order : 999999;
		if (aOrder !== bOrder) return aOrder - bOrder;
		return a.name.localeCompare(b.name);
	});

	const orderedIds = groupTiles.map(t => t.id);
	const fromIdx = orderedIds.indexOf(draggedId);
	const toIdx = orderedIds.indexOf(targetId);
	if (fromIdx < 0 || toIdx < 0) return;

	// Move dragged tile to target position
	orderedIds.splice(fromIdx, 1);
	orderedIds.splice(toIdx, 0, draggedId);

	// Assign new sort_order values
	const updates = [];
	orderedIds.forEach((id, i) => {
		if (rawTiles[id]) rawTiles[id].sort_order = i;
		updates.push({ id, sort_order: i });
	});

	// Re-render immediately
	applyFilters();

	// Persist to DB (batch update)
	for (const u of updates) {
		await supa.from('tasks').update({ sort_order: u.sort_order }).eq('id', u.id);
	}
}

// ---- Tile Detail Popup ----
function initPopup() {
	document.getElementById('closePopup').addEventListener('click', closeTilePopup);
	document.getElementById('tileOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('tileOverlay')) closeTilePopup();
	});
	document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTilePopup(); });
}

function closeTilePopup() {
	document.getElementById('tileOverlay').classList.add('hidden');
}

function openTilePopup(tileId) {
	const raw = rawTiles[tileId];
	if (!raw) return;
	activeTileId = tileId;

	const popupBody = document.getElementById('popupBody');
	const overlay = document.getElementById('tileOverlay');

	const logs = raw.task_logs || [];
	const lastLog = logs[0];
	const health = calculateHealth(raw);
	const plant = healthToPlant(health);
	const statusLabel = lastLog
		? (lastLog.status === 'completed' ? '✅ Completed' : lastLog.status === 'done' ? '💪 Done' : lastLog.status === 'skipped' ? '😢 Skipped' : '💬 No Action')
		: '💬 No Action';
	const lastUpdateStr = lastLog ? 'Last update: ' + new Date(lastLog.log_date || lastLog.created_at).toLocaleDateString() : '';

	const freqMode = raw.frequency_mode || 'daily';
	// Routine (recurring: daily/weekly/monthly) vs One-time (frequency 'once').
	const isRoutine = freqMode !== 'once';
	const currentTags = raw.tag_ids || [];
	const freqDays = (raw.task_frequency_days || []).map(d => String(d.day_of_week));

	// Build logs timeline
	let timelineHtml = '';
	if (logs.length === 0) {
		timelineHtml = '<div class="text-slate-400 text-sm py-4">No logs yet.</div>';
	} else {
		timelineHtml = '<div class="relative pl-6 border-l-2 border-slate-200 mt-2">';
		   logs.forEach(log => {
			   // Use log_date for the log date display
			   const logDate = log.log_date || log.created_at;
			   let d;
			   if (logDate) {
				   d = new Date(logDate);
			   } else {
				   d = new Date();
			   }
			   const dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
			   // Only show time if created_at exists
			   let timeStr = '';
			   if (log.created_at) {
				   const createdAtDate = new Date(log.created_at);
				   timeStr = createdAtDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
			   }
			   const actionColor = log.status === 'done' ? 'bg-green-400' : log.status === 'skipped' ? 'bg-yellow-400' : log.status === 'completed' ? 'bg-blue-400' : 'bg-slate-300';
			   const noteHtml = log.note ? `<div class="text-xs text-slate-500 mt-1 italic">${log.note}</div>` : '';
			   timelineHtml += `
				   <div class="mb-4 relative group rounded-lg p-2 -ml-2 hover:bg-red-50 transition">
					   <div class="absolute -left-[13px] top-3 w-3 h-3 rounded-full ${actionColor} border-2 border-white"></div>
					   <div class="flex items-center justify-between">
						   <div class="text-sm font-semibold">${log.status}</div>
						   <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
							   <button class="edit-log text-blue-300 hover:text-blue-500 text-sm font-bold px-1" data-log-id="${log.id}">✏️</button>
							   <button class="delete-log text-red-300 hover:text-red-500 text-lg font-bold px-1" data-log-id="${log.id}">&times;</button>
						   </div>
					   </div>
					   <div class="text-xs text-slate-400">${dateStr}${timeStr ? ' · ' + timeStr : ''}</div>
					   ${noteHtml}
				   </div>`;
		   });
		timelineHtml += '</div>';
	}

	// Multiselect dropdown for tags
	const tagDropdownHtml = `
	<div class="tagDropdown mb-8" style="min-width:220px;">
		<button id="tagDropdownBtn" type="button" class="w-full flex justify-between items-center border px-3 py-2 rounded-lg bg-white text-sm" tabindex="0">
			<span id="tagDropdownSelected">${currentTags.length ? currentTags.map(tagName).join(', ') : 'Select tags...'}</span>
			<span class="ml-2">▼</span>
		</button>
		<div id="tagDropdownMenu" class="tagDropdownMenu" style="max-height:220px;overflow-y:auto;">
			<input id="tagDropdownSearch" type="text" placeholder="Search tags..." class="w-full px-3 py-1 mb-2 border-b text-xs focus:outline-none" style="border-radius:8px 8px 0 0;" />
			<div id="tagDropdownOptions"></div>
		</div>
	</div>`;

	popupBody.innerHTML = `
		<div class="flex items-center gap-3 mb-4">
			<span class="text-4xl">${tilePlant(raw, health).emoji}</span>
			<div>
				<div class="text-xl font-bold">
					<input id="tileNameInput" type="text" value="${String(raw.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}" class="border-b border-slate-300 focus:border-blue-400 outline-none bg-transparent font-bold text-xl w-full" style="min-width:80px;max-width:100%;" autocomplete="off" />
				</div>

					
				<div class="text-sm text-slate-500">${statusLabel}</div>
				<div class="text-xs text-slate-400">${lastUpdateStr}</div>
			</div>
		</div>
		<hr class="my-5 border-slate-200">
		<div class="mb-3 sm:max-w-xs">
			<div class="mb-1 text-xs font-semibold text-slate-500">Status</div>
			<div id="lifecycleSelectMount"></div>
		</div>
		<div class="mb-3">
			<div class="mb-1 text-xs font-semibold text-slate-500">Type</div>
			<div id="routineToggle" class="inline-flex rounded-lg border border-slate-300 overflow-hidden text-sm">
				<button type="button" class="routine-opt px-3 py-1.5 transition ${isRoutine ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}" data-routine="1">🔁 Routine</button>
				<button type="button" class="routine-opt px-3 py-1.5 transition border-l border-slate-300 ${!isRoutine ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}" data-routine="0">1️⃣ One-time</button>
			</div>
		</div>
		<div class="grid grid-cols-2 gap-3 mb-3">
			<div id="freqCell" style="display:${isRoutine ? 'block' : 'none'}">
				<div class="mb-1 text-xs font-semibold text-slate-500">Frequency</div>
				<div id="freqSelectMount"></div>
			</div>
			<div id="dateCell" style="display:${!isRoutine ? 'block' : 'none'}">
				<div class="mb-1 text-xs font-semibold text-slate-500">Date</div>
				<input type="date" id="onceDateInput" class="w-full rounded-lg border px-2 py-1.5 text-sm" value="${raw.end_date || ''}" />
			</div>
			<div>
				<div class="mb-1 text-xs font-semibold text-slate-500">Reminder</div>
				<div id="reminderSelectMount"></div>
			</div>
		</div>
		<div id="weeklyDays" class="flex flex-wrap gap-1 mb-3" style="display:${freqMode === 'weekly' ? 'flex' : 'none'}">
			${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<button class='day-btn px-2 py-1 rounded-full text-xs border transition ${freqDays.includes(String(i)) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-day='${i}'>${d}</button>`).join('')}
		</div>
		<div id="monthlyDayPicker" class="mb-3" style="display:${freqMode === 'monthly' ? 'block' : 'none'}">
			<label class="text-xs text-slate-500">Day of month</label>
			<select id="monthlyDaySelect" class="ml-2 rounded-lg border px-2 py-1 text-sm">
				${Array.from({ length: 31 }, (_, i) => i + 1).map(d => `<option value="${d}" ${monthlyDom(raw) === d ? 'selected' : ''}>${ordinal(d)}</option>`).join('')}
			</select>
		</div>
		<div id="reminderCustomWrap" class="mb-3" style="display:none">
			<label class="text-xs text-slate-500">Reminder date &amp; time</label>
			<input type="datetime-local" id="reminderCustom" class="ml-2 rounded-lg border px-2 py-1 text-sm" />
		</div>
		<div class="mb-2 text-sm font-semibold">Tags</div>
		${tagDropdownHtml}
		<hr class="my-5 border-slate-200">
		<div class="flex items-center justify-between mb-2">
			<div class="text-sm font-semibold">Attachments</div>
			<button id="addAttachmentBtn" type="button" class="text-blue-500 hover:text-blue-700 text-sm font-semibold transition">📎 Add</button>
		</div>
		<input type="file" id="attachmentInput" class="hidden" multiple accept="image/*,application/pdf" />
		<div id="attachmentList" class="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-2">
			<div class="text-xs text-slate-400 col-span-full">Loading…</div>
		</div>
		<hr class="my-5 border-slate-200">
		<div class="flex items-center justify-between mb-1">
			<div class="text-md font-semibold">Log Timeline</div>
			<button id="addLogBtn" class="text-blue-500 hover:text-blue-700 text-2xl font-bold leading-none transition">+</button>
		</div>
		<div class="max-h-64 overflow-y-auto">${timelineHtml}</div>
		<div class="text-xs text-slate-400 mt-2">Total logs: ${logs.length}</div>
		<hr class="my-5 border-slate-200">
		<button id="deleteTileBtn" class="w-full py-2 rounded-lg bg-red-100 text-red-400 text-sm font-semibold hover:bg-red-200 transition">🗑️ Delete Tile</button>
	`;

	// Tile name editing logic
	const tileNameInput = document.getElementById('tileNameInput');
	if (tileNameInput) {
		tileNameInput.addEventListener('keydown', async e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				tileNameInput.blur();
			}
		});
		tileNameInput.addEventListener('blur', async () => {
			const newName = tileNameInput.value.trim();
			if (newName && newName !== raw.name) {
				raw.name = newName;
				const displayTile = tiles.find(t => t.id === tileId);
				if (displayTile) displayTile.name = newName;
				await supa.from('tasks').update({ name: newName }).eq('id', tileId);
			}
		});
	}


	// Frequency / Reminder / Status — styled dropdowns (icon left, text right).
	lwSelect(document.getElementById('freqSelectMount'), {
		options: [
			{ value: 'daily', icon: '🔁', label: 'Daily' },
			{ value: 'weekly', icon: '📆', label: 'Weekly' },
			{ value: 'monthly', icon: '🗓️', label: 'Monthly' }
			// 'once' is not a routine — it's the One-time toggle state below.
		],
		value: freqMode,
		onSelect: (v) => setFrequency(v) // re-renders the popup, revealing the right sub-picker
	});

	// Routine ⟷ One-time toggle: routine = daily/weekly/monthly, one-time = 'once'.
	document.querySelectorAll('.routine-opt').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const wantRoutine = btn.dataset.routine === '1';
			const cur = (rawTiles[activeTileId] && rawTiles[activeTileId].frequency_mode) || 'daily';
			if (wantRoutine === (cur !== 'once')) return; // already in this mode
			setFrequency(wantRoutine ? 'daily' : 'once'); // persists + re-renders
		});
	});

	lwSelect(document.getElementById('lifecycleSelectMount'), {
		options: [
			{ value: 'active', icon: '🔥', label: 'Active' },
			{ value: 'planned', icon: '📋', label: 'Planned' },
			{ value: 'in progress', icon: '🔄', label: 'In Progress' },
			{ value: 'completed', icon: '✅', label: 'Completed' },
			{ value: 'failed', icon: '❌', label: 'Failed' },
			{ value: 'cancelled', icon: '🚫', label: 'Cancelled' }
		],
		value: (raw.status || 'in progress'),
		onSelect: async (v) => {
			raw.status = v;
			const displayTile = tiles.find(t => t.id === tileId);
			if (displayTile) displayTile.taskStatus = v;
			openTilePopup(tileId);
			await updateTask(tileId, { status: v });
		}
	});

	const remIso = raw.reminder_at;
	lwSelect(document.getElementById('reminderSelectMount'), {
		options: [
			{ value: '', icon: '🔕', label: 'No reminder' },
			{ value: '1h', icon: '⏰', label: 'In 1 hour' },
			{ value: '3h', icon: '⏰', label: 'In 3 hours' },
			{ value: 'eve', icon: '🌇', label: 'This evening (6 PM)' },
			{ value: 'tom9', icon: '🌅', label: 'Tomorrow 9 AM' },
			{ value: 'tomeve', icon: '🌇', label: 'Tomorrow 6 PM' },
			{ value: 'week', icon: '📅', label: 'Next week' },
			{ value: 'custom', icon: '✏️', label: 'Custom date & time…' }
		],
		value: '',
		display: remIso ? { icon: '🔔', label: formatReminderAt(remIso) } : { icon: '🔕', label: 'No reminder' },
		onSelect: async (v) => {
			const wrap = document.getElementById('reminderCustomWrap');
			const ci = document.getElementById('reminderCustom');
			if (v === 'custom') {
				const seed = remIso ? new Date(remIso) : new Date(Date.now() + 3600000);
				if (ci) ci.value = toLocalInputValue(seed);
				if (wrap) wrap.style.display = 'block';
				if (ci) ci.focus();
				return;
			}
			if (wrap) wrap.style.display = 'none';
			if (v === '') { await setTileReminder(activeTileId, null); openTilePopup(activeTileId); return; }
			const when = computeReminderAt(v);
			if (when) { await setTileReminder(activeTileId, when); openTilePopup(activeTileId); }
		}
	});

	const reminderCustom = document.getElementById('reminderCustom');
	if (reminderCustom) {
		reminderCustom.addEventListener('change', async () => {
			if (!reminderCustom.value) return;
			const when = new Date(reminderCustom.value); // datetime-local parsed as local time
			if (isNaN(when.getTime())) return;
			await setTileReminder(activeTileId, when);
			openTilePopup(activeTileId);
		});
	}

	// Multiselect dropdown logic
	const tagDropdownBtn = document.getElementById('tagDropdownBtn');
	const tagDropdownMenu = document.getElementById('tagDropdownMenu');
	const tagDropdownOptions = document.getElementById('tagDropdownOptions');
	const tagDropdownSelected = document.getElementById('tagDropdownSelected');
	const tagDropdownSearch = document.getElementById('tagDropdownSearch');

	function updateTagSummary() {
		const sel = (rawTiles[activeTileId] && rawTiles[activeTileId].tag_ids) || [];
		tagDropdownSelected.textContent = sel.length ? sel.map(tagName).join(', ') : 'Select tags...';
	}

	function renderTagOptions(filter = '') {
		tagDropdownOptions.innerHTML = '';
		const sel = (rawTiles[activeTileId] && rawTiles[activeTileId].tag_ids) || [];
		const q = filter.toLowerCase();
		ALL_TAGS
			.filter(at => at.label.toLowerCase().includes(q) || tagPath(at.key).toLowerCase().includes(q))
			.sort((a, b) => tagPath(a.key).localeCompare(tagPath(b.key)))
			.forEach(at => {
				const checked = sel.includes(at.key);
				const btn = document.createElement('button');
				btn.className = 'tagBtn flex items-center gap-2 w-full px-3 py-1 text-left text-sm' + (checked ? ' active' : '');
				btn.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} class="mr-2">${tagPath(at.key)}`;
				btn.addEventListener('click', async e => {
					e.preventDefault();
					await toggleTag(at.key);
					updateTagSummary();
					renderTagOptions(tagDropdownSearch.value);
				});
				tagDropdownOptions.appendChild(btn);
			});
	}

	tagDropdownBtn.addEventListener('click', e => {
		e.stopPropagation();
		tagDropdownMenu.style.display = tagDropdownMenu.style.display === 'block' ? 'none' : 'block';
		tagDropdownSearch.focus();
	});

	// Close the tag menu on any click outside it. Registered once and keyed off
	// the live DOM (not this render's captured elements), so re-renders — e.g.
	// clicking the Routine/One-time toggle — can't leave a stale handler that
	// mis-toggles the menu. The menu now opens ONLY via its own button.
	if (!window.__tagCloseGlobal) {
		window.__tagCloseGlobal = true;
		document.addEventListener('click', e => {
			const menu = document.getElementById('tagDropdownMenu');
			if (menu && !e.target.closest('.tagDropdown')) menu.style.display = 'none';
		});
	}

	tagDropdownSearch.addEventListener('input', e => {
		renderTagOptions(tagDropdownSearch.value);
	});

	renderTagOptions();

	// Keyboard navigation: close on Escape
	tagDropdownSearch.addEventListener('keydown', e => {
		if (e.key === 'Escape') tagDropdownMenu.style.display = 'none';
	});

	// End multiselect dropdown logic

	// (Frequency & Status are handled by the styled dropdowns above.)

	// Wire up weekly day buttons
	document.querySelectorAll('.day-btn').forEach(btn => {
		btn.addEventListener('click', e => { e.stopPropagation(); toggleWeeklyDay(btn.dataset.day); });
	});

	// Wire up once-date picker
	const onceDateInput = document.getElementById('onceDateInput');
	if (onceDateInput) {
		onceDateInput.addEventListener('change', async e => {
			if (!activeTileId) return;
			const raw = rawTiles[activeTileId];
			if (!raw) return;
			raw.end_date = e.target.value || null;
			applyFilters();
			await updateTask(activeTileId, { end_date: raw.end_date });
		});
	}

	// Wire up monthly day-of-month selector
	const monthlyDaySelect = document.getElementById('monthlyDaySelect');
	if (monthlyDaySelect) {
		monthlyDaySelect.addEventListener('change', async e => {
			if (!activeTileId) return;
			const raw = rawTiles[activeTileId];
			if (!raw) return;
			raw.day_of_month = parseInt(e.target.value, 10);
			applyFilters();
			scheduleReminders();
			await updateTask(activeTileId, { day_of_month: raw.day_of_month });
		});
	}

	// (Time of Day hidden for now.)

	// Wire up delete tile button
	document.getElementById('deleteTileBtn').addEventListener('click', deleteTile);

	// Wire up log edit buttons
	document.querySelectorAll('.edit-log').forEach(btn => {
		btn.addEventListener('click', e => {
			e.stopPropagation();
			const logId = btn.dataset.logId;
			const log = (raw.task_logs || []).find(l => l.id === logId);
			if (log) openAddLogPopup(log);
		});
	});

	// Wire up log delete buttons
	document.querySelectorAll('.delete-log').forEach(btn => {
		btn.addEventListener('click', async e => {
			e.stopPropagation();
			await deleteLog(btn.dataset.logId);
		});
	});

	// Wire up add log button
	document.getElementById('addLogBtn').addEventListener('click', () => openAddLogPopup());

	// Wire up attachments (photos / screenshots / files) — Premium feature.
	const addAttachmentBtn = document.getElementById('addAttachmentBtn');
	const attachmentInput = document.getElementById('attachmentInput');
	if (addAttachmentBtn && attachmentInput) {
		if (isPremiumUser()) {
			addAttachmentBtn.addEventListener('click', () => attachmentInput.click());
			attachmentInput.addEventListener('change', async () => {
				if (attachmentInput.files && attachmentInput.files.length) {
					await uploadAttachments(tileId, Array.from(attachmentInput.files), addAttachmentBtn);
					attachmentInput.value = '';
				}
			});
		} else {
			addAttachmentBtn.textContent = '🔒 Premium';
			addAttachmentBtn.title = 'Attachments are a Premium feature';
			addAttachmentBtn.addEventListener('click', () => openUpgradeCheckout());
		}
	}
	renderAttachments(tileId);

	overlay.classList.remove('hidden');
}

// ---- Add Log Popup ----
let addLogStatus = 'done';
let editingLogId = null; // null = add mode, logId = edit mode
let logDatePicker = null; // flatpickr instance for the date(s) input

function openAddLogPopup(logToEdit) {
	const overlay = document.getElementById('addLogOverlay');
	const submitBtn = document.getElementById('submitLogBtn');
	const dateInput = document.getElementById('logDateInput');
	const today = todayLocal();

	// Tear down any previous picker so add/edit modes don't collide.
	if (logDatePicker) { logDatePicker.destroy(); logDatePicker = null; }

	// Map existing logged dates -> status (newest log per day wins) so the
	// calendar can tint days that already have a done/skip log.
	const raw = rawTiles[activeTileId] || {};
	const loggedByDate = {};
	(raw.task_logs || []).forEach(l => {
		const day = logDay(l);
		if (day && !(day in loggedByDate)) loggedByDate[day] = l.status;
	});
	const markLoggedDay = (dObj, dStr, fp, dayElem) => {
		const st = loggedByDate[fp.formatDate(dayElem.dateObj, 'Y-m-d')];
		if (st === 'done' || st === 'completed') dayElem.classList.add('lw-day-done');
		else if (st === 'skipped') dayElem.classList.add('lw-day-skip');
	};

	if (logToEdit) {
		// Edit mode — single date, status toggle + Update button.
		editingLogId = logToEdit.id;
		const logDate = logDay(logToEdit) || today;
		dateInput.value = logDate;
		document.getElementById('logNoteInput').value = logToEdit.note || '';
		addLogStatus = logToEdit.status || 'done';
		document.querySelector('#addLogOverlay .text-lg.font-bold').textContent = 'Edit Log';
		submitBtn.textContent = '💾 Update Log';
		submitBtn.classList.remove('hidden');
		updateLogStatusBtns();
		if (window.flatpickr) {
			logDatePicker = flatpickr(dateInput, { dateFormat: 'Y-m-d', defaultDate: logDate, disableMobile: true, onDayCreate: markLoggedDay });
		}
	} else {
		// Add mode — pick multiple dates; Done/Skip each submit one log per date.
		editingLogId = null;
		dateInput.value = '';
		document.getElementById('logNoteInput').value = '';
		addLogStatus = 'done';
		document.querySelector('#addLogOverlay .text-lg.font-bold').textContent = 'Add Log';
		submitBtn.classList.add('hidden');
		resetLogStatusBtns();
		if (window.flatpickr) {
			logDatePicker = flatpickr(dateInput, { mode: 'multiple', dateFormat: 'Y-m-d', defaultDate: [today], disableMobile: true, onDayCreate: markLoggedDay });
		} else {
			dateInput.value = today; // graceful fallback if flatpickr fails to load
		}
	}
	overlay.classList.remove('hidden');
}

function closeAddLogPopup() {
	editingLogId = null;
	if (logDatePicker) { logDatePicker.destroy(); logDatePicker = null; }
	document.getElementById('addLogOverlay').classList.add('hidden');
}

// Collect the chosen date(s) as YYYY-MM-DD strings (handles multi-select).
function getSelectedLogDates() {
	if (logDatePicker && logDatePicker.selectedDates && logDatePicker.selectedDates.length) {
		return logDatePicker.selectedDates.map(d => logDatePicker.formatDate(d, 'Y-m-d'));
	}
	const v = document.getElementById('logDateInput').value || '';
	return v.split(',').map(s => s.trim()).filter(Boolean);
}

// Reset the Done/Skip buttons to their base look (used in add mode).
function resetLogStatusBtns() {
	document.querySelectorAll('.log-status-btn').forEach(btn => {
		btn.classList.remove('bg-green-100', 'border-green-400', 'bg-yellow-100', 'border-yellow-400', 'ring-2', 'ring-green-300', 'ring-yellow-300', 'bg-white', 'border-slate-200', 'bg-green-50', 'border-green-300');
		if (btn.dataset.status === 'done') btn.classList.add('bg-green-50', 'border-green-300');
		else btn.classList.add('bg-white', 'border-slate-200');
	});
}

function updateLogStatusBtns() {
	document.querySelectorAll('.log-status-btn').forEach(btn => {
		const s = btn.dataset.status;
		if (s === addLogStatus) {
			btn.classList.remove('bg-white', 'border-slate-200');
			if (s === 'done') {
				btn.classList.add('bg-green-100', 'border-green-400', 'ring-2', 'ring-green-300');
			} else {
				btn.classList.add('bg-yellow-100', 'border-yellow-400', 'ring-2', 'ring-yellow-300');
			}
		} else {
			btn.classList.remove('bg-green-100', 'border-green-400', 'bg-yellow-100', 'border-yellow-400', 'ring-2', 'ring-green-300', 'ring-yellow-300');
			btn.classList.add('bg-white', 'border-slate-200');
		}
	});
}

async function submitLog(statusArg) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;

	const note = document.getElementById('logNoteInput').value.trim();
	const dates = getSelectedLogDates();
	if (!dates.length) { alert('Please select at least one date.'); return; }

	if (editingLogId) {
		// --- Edit mode (single date) ---
		const updateObj = { status: addLogStatus, log_date: dates[0], note: note || null };
		const { data, error } = await supa
			.from('task_logs')
			.update(updateObj)
			.eq('id', editingLogId)
			.select()
			.single();
		if (error) { console.error('Edit log error:', error); alert('Failed to update log: ' + error.message); return; }
		if (data) {
			const idx = (raw.task_logs || []).findIndex(l => l.id === editingLogId);
			if (idx >= 0) raw.task_logs[idx] = data;
			raw.task_logs.sort((a, b) => new Date(b.log_date || b.created_at) - new Date(a.log_date || a.created_at));
		}
		editingLogId = null;
	} else {
		// --- Add mode (one log per selected date; status from the clicked button) ---
		const status = statusArg || addLogStatus;
		const rows = dates.map(d => ({ task_id: activeTileId, status, log_date: d, note: note || null }));

		const { data, error } = await supa
			.from('task_logs')
			.insert(rows)
			.select();

		if (error) { console.error('Add log error:', error); alert('Failed to add logs: ' + error.message); return; }

		if (data) {
			raw.task_logs = (raw.task_logs || []).concat(data);
			raw.task_logs.sort((a, b) => new Date(b.log_date || b.created_at) - new Date(a.log_date || a.created_at));
		}
	}

	// Update display tile
	const displayTile = tiles.find(t => t.id === activeTileId);
	if (displayTile) {
		const logs = raw.task_logs || [];
		const lastLog = logs[0];
		displayTile.status = getTodayStatus(logs);
		displayTile.count = logs.length;
		displayTile.lastUpdate = lastLog ? (lastLog.log_date || lastLog.created_at) : null;
		const health = calculateHealth(raw);
		const plant = healthToPlant(health);
		displayTile.emoji = plant.emoji;
		displayTile.health = health;
		displayTile.healthLabel = plant.label;
		displayTile.healthColor = plant.color;
	}

	closeAddLogPopup();
	openTilePopup(activeTileId);
	applyFilters();
}

function initAddLogPopup() {
	document.getElementById('closeAddLog').addEventListener('click', closeAddLogPopup);
	document.getElementById('addLogOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('addLogOverlay')) closeAddLogPopup();
	});
	document.querySelectorAll('.log-status-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			if (editingLogId) {
				// Edit mode: pick the status; the Update button submits.
				addLogStatus = btn.dataset.status;
				updateLogStatusBtns();
			} else {
				// Add mode: Done/Skip submit one log per selected date.
				submitLog(btn.dataset.status);
			}
		});
	});
	document.getElementById('submitLogBtn').addEventListener('click', () => submitLog());
}

// ---- Task Update Helper ----
async function updateTask(taskId, updates) {
	const { error } = await supa
		.from('tasks')
		.update(updates)
		.eq('id', taskId);
	if (error) console.error('Update error:', error);
}

// ---- Per-tile reminder helpers ----
// Turn a preset key into a concrete future Date (local time).
function computeReminderAt(preset) {
	const d = new Date();
	if (preset === '1h') { d.setHours(d.getHours() + 1); return d; }
	if (preset === '3h') { d.setHours(d.getHours() + 3); return d; }
	if (preset === 'eve') { d.setHours(18, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d; }
	if (preset === 'tom9') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; }
	if (preset === 'tomeve') { d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d; }
	if (preset === 'week') { d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; }
	return null;
}

// Friendly local display of a stored reminder timestamp.
function formatReminderAt(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return '';
	return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Value for a <input type="datetime-local"> (local wall-clock, no timezone).
function toLocalInputValue(d) {
	const p = n => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- Styled dropdown (icon left, text right) ----
// Renders a custom select into `mount`. config = {options:[{value,icon,label}],
// value, display?, placeholder?, onSelect(value)}. `display` overrides the button
// face when the current value isn't one of the options (e.g. the reminder time).
function lwSelect(mount, config) {
	if (!mount) return;
	const opts = config.options || [];
	const sel = opts.find(o => o.value === config.value);
	const disp = config.display || sel || { icon: '', label: config.placeholder || 'Select…' };
	mount.classList.add('relative', 'lw-select');
	mount.innerHTML = `
		<button type="button" class="lw-select-btn w-full flex items-center justify-between gap-2 border border-slate-300 px-3 py-2 rounded-lg bg-white text-sm hover:bg-slate-50 transition">
			<span class="flex items-center gap-2 min-w-0"><span class="text-base leading-none">${disp.icon || ''}</span><span class="truncate">${disp.label || ''}</span></span>
			<span class="text-slate-400 text-xs">▼</span>
		</button>
		<div class="lw-select-menu hidden absolute left-0 right-0 mt-1 rounded-xl bg-white shadow-xl shadow-slate-900/10 border border-slate-200/80 p-1 z-[60] max-h-60 overflow-y-auto">
			${opts.map(o => `
				<button type="button" class="lw-opt w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left hover:bg-slate-100 transition ${o.value === config.value ? 'bg-slate-50 font-semibold' : ''}" data-value="${String(o.value).replace(/"/g, '&quot;')}">
					<span class="text-base w-5 text-center leading-none">${o.icon || ''}</span>
					<span class="flex-1 min-w-0 truncate">${o.label}</span>
					${o.value === config.value ? '<span class="text-emerald-500">✓</span>' : ''}
				</button>`).join('')}
		</div>`;
	const btn = mount.querySelector('.lw-select-btn');
	const menu = mount.querySelector('.lw-select-menu');
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		const wasHidden = menu.classList.contains('hidden');
		document.querySelectorAll('.lw-select-menu').forEach(m => m.classList.add('hidden')); // close others
		menu.classList.toggle('hidden', !wasHidden);
	});
	menu.querySelectorAll('.lw-opt').forEach(o => {
		o.addEventListener('click', (e) => {
			e.stopPropagation();
			menu.classList.add('hidden');
			config.onSelect(o.dataset.value);
		});
	});
	// Close open menus when clicking anywhere outside a dropdown (registered once).
	if (!window.__lwSelectGlobal) {
		window.__lwSelectGlobal = true;
		document.addEventListener('click', (e) => {
			if (!e.target.closest('.lw-select')) {
				document.querySelectorAll('.lw-select-menu').forEach(m => m.classList.add('hidden'));
			}
		});
	}
}

// Multi-select variant of lwSelect (icon left, text right, checkmarks). Toggling
// an option updates in place and keeps the menu open; config.onToggle(value,
// selectedArray) persists. Shares the outside-click closer with lwSelect.
function lwMultiSelect(mount, config) {
	if (!mount) return;
	const opts = config.options || [];
	const selected = new Set(config.values || []);
	mount.classList.add('relative', 'lw-select');
	const faceHtml = () => {
		const chosen = opts.filter(o => selected.has(o.value));
		if (!chosen.length) return `<span class="text-slate-400">${config.placeholder || 'Select…'}</span>`;
		return chosen.map(o => `${o.icon || ''} ${escapeHtml(o.label)}`).join(', ');
	};
	const render = (keepOpen) => {
		mount.innerHTML = `
			<button type="button" class="lw-select-btn w-full flex items-center justify-between gap-2 border border-slate-300 px-3 py-2 rounded-lg bg-white text-sm hover:bg-slate-50 transition">
				<span class="min-w-0 truncate">${faceHtml()}</span>
				<span class="text-slate-400 text-xs">▼</span>
			</button>
			<div class="lw-select-menu ${keepOpen ? '' : 'hidden'} absolute left-0 right-0 mt-1 rounded-xl bg-white shadow-xl shadow-slate-900/10 border border-slate-200/80 p-1 z-[60] max-h-60 overflow-y-auto">
				${opts.map(o => `
					<button type="button" class="lw-opt w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left hover:bg-slate-100 transition ${selected.has(o.value) ? 'bg-slate-50 font-semibold' : ''}" data-value="${String(o.value).replace(/"/g, '&quot;')}">
						<span class="text-base w-5 text-center leading-none">${o.icon || ''}</span>
						<span class="flex-1 min-w-0 truncate">${escapeHtml(o.label)}</span>
						${selected.has(o.value) ? '<span class="text-emerald-500">✓</span>' : ''}
					</button>`).join('')}
			</div>`;
		const btn = mount.querySelector('.lw-select-btn');
		const menu = mount.querySelector('.lw-select-menu');
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const wasHidden = menu.classList.contains('hidden');
			document.querySelectorAll('.lw-select-menu').forEach(m => m.classList.add('hidden'));
			menu.classList.toggle('hidden', !wasHidden);
		});
		menu.querySelectorAll('.lw-opt').forEach(o => {
			o.addEventListener('click', (e) => {
				e.stopPropagation();
				const v = o.dataset.value;
				if (selected.has(v)) selected.delete(v); else selected.add(v);
				if (config.onToggle) config.onToggle(v, Array.from(selected));
				render(true); // re-render but keep the menu open for more picks
			});
		});
	};
	render(false);
	if (!window.__lwSelectGlobal) {
		window.__lwSelectGlobal = true;
		document.addEventListener('click', (e) => {
			if (!e.target.closest('.lw-select')) {
				document.querySelectorAll('.lw-select-menu').forEach(m => m.classList.add('hidden'));
			}
		});
	}
}

// Persist a tile's reminder (Date or null) and re-sync device notifications.
async function setTileReminder(tileId, dateOrNull) {
	const iso = dateOrNull ? dateOrNull.toISOString() : null;
	if (rawTiles[tileId]) rawTiles[tileId].reminder_at = iso;
	await supa.from('tasks').update({ reminder_at: iso }).eq('id', tileId);
	if (typeof notifiedReminderIds !== 'undefined') notifiedReminderIds.delete(tileId); // allow re-notify if re-armed
	scheduleReminders();
	if (typeof refreshNotifications === 'function') refreshNotifications();
}

// ---- In-app notification center (the header bell) ----
// LocalNotifications is native-only, so on the web the reminders surface here:
// any tile whose one-shot reminder time has passed and that's still open.
let notifiedReminderIds = new Set(); // browser Notifications already popped this session

function dueReminders() {
	const now = Date.now();
	return Object.values(rawTiles)
		.filter(t => {
			if (!t.reminder_at) return false;
			const st = (t.status || '').toLowerCase();
			if (st === 'completed' || st === 'cancelled' || st === 'failed') return false;
			const when = new Date(t.reminder_at).getTime();
			return !isNaN(when) && when <= now;
		})
		.sort((a, b) => new Date(b.reminder_at) - new Date(a.reminder_at));
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
		list.forEach(t => {
			if (!notifiedReminderIds.has(t.id)) {
				notifiedReminderIds.add(t.id);
				try { new Notification('🔔 ' + t.name, { body: 'Reminder', tag: 'lw-' + t.id }); } catch (e) {}
			}
		});
	}
	const menu = document.getElementById('notifMenu');
	if (menu && !menu.classList.contains('hidden')) renderNotifList();
}

function renderNotifList() {
	const listEl = document.getElementById('notifList');
	if (!listEl) return;
	const list = dueReminders();
	if (!list.length) {
		listEl.innerHTML = '<div class="text-center text-slate-400 text-sm py-6">No reminders right now.</div>';
		return;
	}
	listEl.innerHTML = list.map(t => `
		<div class="flex items-start justify-between gap-2 px-2 py-2 rounded-xl hover:bg-slate-50 transition">
			<button class="notif-open flex-1 text-left min-w-0" data-tile-id="${t.id}">
				<div class="text-sm font-medium text-slate-700 truncate">${t.name}</div>
				<div class="text-xs text-slate-400">🔔 ${formatReminderAt(t.reminder_at)}</div>
			</button>
			<button class="notif-dismiss text-slate-300 hover:text-red-500 text-lg leading-none px-1" data-tile-id="${t.id}" title="Dismiss">&times;</button>
		</div>`).join('');
	listEl.querySelectorAll('.notif-open').forEach(b => b.addEventListener('click', () => {
		closeNotifMenu();
		openTilePopup(b.getAttribute('data-tile-id'));
	}));
	listEl.querySelectorAll('.notif-dismiss').forEach(b => b.addEventListener('click', async (e) => {
		e.stopPropagation();
		await setTileReminder(b.getAttribute('data-tile-id'), null); // clears the reminder
	}));
}

function openNotifMenu() {
	const menu = document.getElementById('notifMenu');
	const btn = document.getElementById('notifBellBtn');
	if (!menu) return;
	// First open on web: politely ask to enable browser notifications.
	if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
		try { Notification.requestPermission(); } catch (e) {}
	}
	renderNotifList();
	menu.classList.remove('hidden');
	if (btn) btn.setAttribute('aria-expanded', 'true');
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
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (menu.classList.contains('hidden')) openNotifMenu(); else closeNotifMenu();
	});
	document.addEventListener('click', (e) => {
		if (!menu.classList.contains('hidden') && !e.target.closest('#notifWrapper')) closeNotifMenu();
	});
	if (clearAll) clearAll.addEventListener('click', async () => {
		for (const t of dueReminders()) await setTileReminder(t.id, null);
	});
	setInterval(refreshNotifications, 60000); // surface reminders as their time arrives
	refreshNotifications();
}

// ---- Local notifications / reminders (native app only) ----
// Reminders every 4 hours during waking hours (skips the 00:00 / 04:00 slots).
const REMINDER_TIMES = [
	{ hour: 8, minute: 0 },
	{ hour: 12, minute: 0 },
	{ hour: 16, minute: 0 },
	{ hour: 20, minute: 0 }
];

// Rebuild all device reminders from the current cards. The OS fires them even
// when the app is closed; we re-sync on app open and after schedule edits.
// Action buttons shown under each reminder notification.
const NOTIF_ACTION_TYPE = 'reminderActions';

// Log a done/skip straight to Supabase from a notification tap. Doesn't rely
// on rawTiles being loaded (the app may be cold-starting), so it talks to the
// DB directly, then refreshes the UI if it's up.
async function logFromNotification(taskId, status) {
	const today = todayLocal();
	const { data: existing } = await supa
		.from('task_logs')
		.select('id')
		.eq('task_id', taskId)
		.eq('log_date', today)
		.in('status', ['done', 'completed', 'skipped'])
		.limit(1);
	if (existing && existing.length) {
		await supa.from('task_logs').update({ status }).eq('id', existing[0].id);
	} else {
		await supa.from('task_logs').insert({ task_id: taskId, status, log_date: today });
	}
}

async function onNotificationAction(event) {
	const action = event && event.actionId;
	const taskId = event && event.notification && event.notification.extra && event.notification.extra.taskId;
	if (!taskId || (action !== 'done' && action !== 'skip')) return; // ignore plain taps
	const status = action === 'done' ? 'done' : 'skipped';
	try {
		const { data: { session } } = await supa.auth.getSession();
		if (!session) return; // signed out — nothing we can log
		await logFromNotification(taskId, status);
		await fetchTilesFromSupabase(); // refresh gallery + reschedule
	} catch (e) {
		console.error('notification action error:', e);
	}
}

async function scheduleReminders() {
	const cap = window.Capacitor;
	const LN = cap && cap.Plugins && cap.Plugins.LocalNotifications;
	if (!LN || !(cap.isNativePlatform && cap.isNativePlatform())) return; // native only
	try {
		let perm = await LN.checkPermissions();
		if (perm.display !== 'granted') perm = await LN.requestPermissions();
		if (perm.display !== 'granted') return;

		try { await LN.createChannel({ id: 'reminders', name: 'Reminders', importance: 4, visibility: 1 }); } catch (e) {}

		// One-time: register the Done/Skip buttons and the tap handler.
		if (!scheduleReminders._init) {
			scheduleReminders._init = true;
			try {
				await LN.registerActionTypes({
					types: [{
						id: NOTIF_ACTION_TYPE,
						actions: [
							{ id: 'done', title: '✅ Done' },
							{ id: 'skip', title: '⏭️ Skip', destructive: true }
						]
					}]
				});
			} catch (e) { console.error('registerActionTypes error:', e); }
			LN.addListener('localNotificationActionPerformed', onNotificationAction);
		}

		// Clear what we previously scheduled, then rebuild.
		const pending = await LN.getPending();
		if (pending && pending.notifications && pending.notifications.length) {
			await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
		}

		const now = new Date();
		const notifications = [];
		let id = 1;

		Object.values(rawTiles).forEach(task => {
			const status = (task.status || '').toLowerCase();
			if (status === 'completed' || status === 'cancelled' || status === 'failed') return;
			const mode = task.frequency_mode || 'daily';
			const base = { title: `⏰ ${task.name}`, body: 'Time to take action.', channelId: 'reminders', actionTypeId: NOTIF_ACTION_TYPE, extra: { taskId: task.id } };

			REMINDER_TIMES.forEach(t => {
				if (mode === 'daily') {
					notifications.push({ id: id++, ...base, schedule: { on: { hour: t.hour, minute: t.minute }, repeats: true, allowWhileIdle: true } });
				} else if (mode === 'weekly') {
					(task.task_frequency_days || []).forEach(d => {
						notifications.push({ id: id++, ...base, schedule: { on: { weekday: d.day_of_week + 1, hour: t.hour, minute: t.minute }, repeats: true, allowWhileIdle: true } });
					});
				} else if (mode === 'monthly') {
					const dom = monthlyDom(task);
					notifications.push({ id: id++, ...base, schedule: { on: { day: dom, hour: t.hour, minute: t.minute }, repeats: true, allowWhileIdle: true } });
				} else if (mode === 'once' && task.end_date) {
					const when = new Date(task.end_date + 'T00:00:00');
					when.setHours(t.hour, t.minute, 0, 0);
					if (when > now) notifications.push({ id: id++, ...base, schedule: { at: when, allowWhileIdle: true } });
				}
			});

			// Explicit per-tile reminder set from the tile detail — fires once.
			if (task.reminder_at) {
				const rwhen = new Date(task.reminder_at);
				if (!isNaN(rwhen.getTime()) && rwhen > now) {
					notifications.push({ id: id++, title: `🔔 ${task.name}`, body: 'Reminder', channelId: 'reminders', actionTypeId: NOTIF_ACTION_TYPE, extra: { taskId: task.id }, schedule: { at: rwhen, allowWhileIdle: true } });
				}
			}
		});

		if (notifications.length) await LN.schedule({ notifications });
	} catch (e) {
		console.error('scheduleReminders error:', e);
	}
}

// ---- Tag Operations ----
async function toggleTag(tagId) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.tag_ids = raw.tag_ids || [];
	const idx = raw.tag_ids.indexOf(tagId);
	if (idx >= 0) {
		raw.tag_ids.splice(idx, 1);
	} else {
		raw.tag_ids.push(tagId);
	}
	const displayTile = tiles.find(t => t.id === activeTileId);
	if (displayTile) displayTile.tags = [...raw.tag_ids];
	applyFilters();
	await updateTask(raw.id, { tag_ids: raw.tag_ids });
}

// ---- Frequency Operations ----
async function setFrequency(mode) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.frequency_mode = mode;
	if (mode !== 'weekly') {
		// Clear frequency days from DB and local
		await supa.from('task_frequency_days').delete().eq('task_id', activeTileId);
		raw.task_frequency_days = [];
	}
	openTilePopup(activeTileId);
	applyFilters();
	await updateTask(activeTileId, { frequency_mode: mode });
	scheduleReminders();
}

async function toggleWeeklyDay(day) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.task_frequency_days = raw.task_frequency_days || [];
	const dayInt = parseInt(day);
	const existing = raw.task_frequency_days.find(d => d.day_of_week === dayInt);
	if (existing) {
		// Remove
		await supa.from('task_frequency_days').delete().eq('id', existing.id);
		raw.task_frequency_days = raw.task_frequency_days.filter(d => d.id !== existing.id);
	} else {
		// Add
		const { data, error } = await supa
			.from('task_frequency_days')
			.insert({ task_id: activeTileId, day_of_week: dayInt })
			.select()
			.single();
		if (data) raw.task_frequency_days.push(data);
		if (error) console.error('Freq day error:', error);
	}
	openTilePopup(activeTileId);
	applyFilters();
	scheduleReminders();
}

// ---- Log Operations ----
async function quickLog(tileId, status) {
	const raw = rawTiles[tileId];
	if (!raw) return;

	const today = todayLocal();

	// Check if there's already a log for today — update it instead of creating duplicate
	const existingLog = (raw.task_logs || []).find(l => {
		const logDate = logDay(l);
		return logDate === today && (l.status === 'done' || l.status === 'skipped' || l.status === 'completed');
	});

	if (existingLog) {
		// Update existing log
		existingLog.status = status;
		const { error } = await supa.from('task_logs').update({ status }).eq('id', existingLog.id);
		if (error) console.error('Quick log update error:', error);
	} else {
		// Insert new log
		const { data, error } = await supa
			.from('task_logs')
			.insert({ task_id: tileId, status, log_date: today })
			.select()
			.single();
		if (error) { console.error('Quick log error:', error); return; }
		if (data) {
			raw.task_logs = raw.task_logs || [];
			raw.task_logs.unshift(data);
		}
	}

	// Update display tile
	const displayTile = tiles.find(t => t.id === tileId);
	if (displayTile) {
		displayTile.status = status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : 'noaction';
		displayTile.count = (raw.task_logs || []).length;
		// Use the latest log's log_date if available, else fallback to created_at, else now
		const latestLog = (raw.task_logs || [])[0];
		displayTile.lastUpdate = latestLog ? (latestLog.log_date || latestLog.created_at) : new Date().toISOString();
		const health = calculateHealth(raw);
		const plant = healthToPlant(health);
		displayTile.emoji = plant.emoji;
		displayTile.health = health;
		displayTile.healthLabel = plant.label;
		displayTile.healthColor = plant.color;
	}
	applyFilters();
}

async function deleteLog(logId) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.task_logs = (raw.task_logs || []).filter(l => l.id !== logId);
	const displayTile = tiles.find(t => t.id === activeTileId);
	if (displayTile) displayTile.count = raw.task_logs.length;
	openTilePopup(activeTileId);
	await supa.from('task_logs').delete().eq('id', logId);
}

// ---- Delete Tile ----
async function deleteTile() {
	if (!activeTileId) return;
	// Remove any stored attachment files first (the metadata rows cascade with
	// the task, but the storage objects must be cleared explicitly).
	try {
		const { data: atts } = await supa.from('task_attachments').select('path').eq('task_id', activeTileId);
		if (atts && atts.length) await supa.storage.from('attachments').remove(atts.map(a => a.path));
	} catch (e) { console.error('attachment cleanup error:', e); }
	// Delete related records then task
	await supa.from('task_logs').delete().eq('task_id', activeTileId);
	await supa.from('task_frequency_days').delete().eq('task_id', activeTileId);
	await supa.from('tasks').delete().eq('id', activeTileId);
	delete rawTiles[activeTileId];
	tiles = tiles.filter(t => t.id !== activeTileId);
	closeTilePopup();
	renderGallery(tiles);
	scheduleReminders();
}

// ---- Attachments (photos / screenshots / files) ----
const ATTACH_BUCKET = 'attachments';

function escapeHtml(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Load and render a task's attachments into #attachmentList (uses signed URLs
// because the bucket is private).
async function renderAttachments(taskId) {
	const listEl = document.getElementById('attachmentList');
	if (!listEl) return;
	const { data, error } = await supa
		.from('task_attachments')
		.select('*')
		.eq('task_id', taskId)
		.order('created_at', { ascending: false });
	if (error) {
		listEl.innerHTML = '<div class="text-xs text-red-400 col-span-full">Could not load attachments.</div>';
		return;
	}
	if (!data || !data.length) {
		listEl.innerHTML = isPremiumUser()
			? '<div class="text-xs text-slate-400 col-span-full">No attachments yet.</div>'
			: '<button type="button" id="attachUpsell" class="col-span-full text-left text-xs text-slate-500 bg-purple-50 border border-purple-100 rounded-lg px-3 py-2 hover:bg-purple-100 transition">✨ Attach photos, screenshots & files with <span class="font-semibold text-purple-600">Premium</span> — tap to upgrade.</button>';
		const upsell = document.getElementById('attachUpsell');
		if (upsell) upsell.addEventListener('click', () => openUpgradeCheckout());
		return;
	}
	const items = await Promise.all(data.map(async att => {
		let url = null;
		try {
			const { data: signed } = await supa.storage.from(ATTACH_BUCKET).createSignedUrl(att.path, 3600);
			url = signed ? signed.signedUrl : null;
		} catch (e) { /* leave url null */ }
		return { att, url };
	}));
	listEl.innerHTML = items.map(({ att, url }) => {
		const isImg = (att.mime || '').startsWith('image/');
		const name = escapeHtml(att.name || 'file');
		const inner = (isImg && url)
			? `<img src="${url}" alt="${name}" class="w-full h-20 object-cover rounded-lg border border-slate-200" />`
			: `<div class="w-full h-20 flex flex-col items-center justify-center rounded-lg bg-slate-100 border border-slate-200 text-slate-500"><span class="text-2xl leading-none">📄</span><span class="text-[10px] px-1 mt-1 truncate w-full text-center">${name}</span></div>`;
		return `<div class="relative group">
			<a href="${url || '#'}" target="_blank" rel="noopener" class="block">${inner}</a>
			<button class="att-del absolute top-1 right-1 grid place-items-center bg-black/50 hover:bg-black/70 text-white rounded-full w-5 h-5 text-xs opacity-0 group-hover:opacity-100 transition" data-id="${att.id}" data-path="${escapeHtml(att.path)}" title="Delete">&times;</button>
		</div>`;
	}).join('');
	listEl.querySelectorAll('.att-del').forEach(b => b.addEventListener('click', async (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!confirm('Delete this attachment?')) return;
		await deleteAttachment(b.dataset.id, b.dataset.path, taskId);
	}));
}

const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB, mirrors the bucket cap

// Downscale + re-encode large photos/screenshots before upload to save storage
// and bandwidth. Non-images (and animated GIFs) pass through untouched; if
// compression wouldn't help, the original is kept.
async function compressImage(file, maxDim = 1600, quality = 0.82) {
	if (!file.type || !file.type.startsWith('image/') || file.type === 'image/gif') return file;
	try {
		const dataUrl = await new Promise((resolve, reject) => {
			const fr = new FileReader();
			fr.onload = () => resolve(fr.result);
			fr.onerror = reject;
			fr.readAsDataURL(file);
		});
		const img = await new Promise((resolve, reject) => {
			const im = new Image();
			im.onload = () => resolve(im);
			im.onerror = reject;
			im.src = dataUrl;
		});
		const { width, height } = img;
		// Already modest in both size and dimensions — no point re-encoding.
		if (width <= maxDim && height <= maxDim && file.size < 1024 * 1024) return file;
		const scale = Math.min(1, maxDim / Math.max(width, height));
		const w = Math.round(width * scale), h = Math.round(height * scale);
		const canvas = document.createElement('canvas');
		canvas.width = w; canvas.height = h;
		canvas.getContext('2d').drawImage(img, 0, 0, w, h);
		const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
		if (!blob || blob.size >= file.size) return file; // compression didn't help
		const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
		return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified || undefined });
	} catch (e) {
		console.error('image compress error:', e);
		return file;
	}
}

// Upload one or more files for a task, then re-render the grid.
async function uploadAttachments(taskId, files, btnEl) {
	const { data: { session } } = await supa.auth.getSession();
	if (!session) { alert('Please sign in to add attachments.'); return; }
	// Premium-only. RLS enforces this too, but fail early with a clear prompt.
	if (!(session.user.app_metadata && session.user.app_metadata.premium)) {
		openUpgradeCheckout();
		return;
	}
	const userId = session.user.id;
	const origLabel = btnEl ? btnEl.textContent : '';
	if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Uploading…'; }
	try {
		for (const original of files) {
			const file = await compressImage(original); // shrink big images first
			if (file.size > ATTACH_MAX_BYTES) {
				alert(`"${original.name}" is larger than 10 MB (even after compression) and was skipped.`);
				continue;
			}
			const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
			const path = `${userId}/${taskId}/${crypto.randomUUID()}-${safe}`;
			const { error: upErr } = await supa.storage.from(ATTACH_BUCKET).upload(path, file, {
				contentType: file.type || 'application/octet-stream',
				upsert: false
			});
			if (upErr) { console.error('upload error:', upErr); alert('Upload failed: ' + (upErr.message || 'unknown error')); continue; }
			const { error: insErr } = await supa.from('task_attachments').insert({
				task_id: taskId, user_id: userId, path, name: file.name, mime: file.type || null, size: file.size || null
			});
			if (insErr) {
				console.error('metadata insert error:', insErr);
				await supa.storage.from(ATTACH_BUCKET).remove([path]); // roll back the orphaned file
			}
		}
	} finally {
		if (btnEl) { btnEl.disabled = false; btnEl.textContent = origLabel; }
	}
	await renderAttachments(taskId);
}

async function deleteAttachment(id, path, taskId) {
	try { await supa.storage.from(ATTACH_BUCKET).remove([path]); } catch (e) { console.error('storage remove error:', e); }
	await supa.from('task_attachments').delete().eq('id', id);
	await renderAttachments(taskId);
}

// ---- Add New Tile ----
// ---- New Tile (type or dictate the title) ----
// Remembered voice-recognition language (BCP-47 tag).
function getVoiceLang() {
	try { return localStorage.getItem('lw_voice_lang') || 'en-US'; } catch (e) { return 'en-US'; }
}
function setVoiceLang(lang) {
	try { localStorage.setItem('lw_voice_lang', lang); } catch (e) {}
}

// ---- Settings ----
function openSettings() {
	const sel = document.getElementById('settingsVoiceLang');
	if (sel) sel.value = getVoiceLang();
	document.getElementById('settingsOverlay').classList.remove('hidden');
}
function closeSettings() {
	document.getElementById('settingsOverlay').classList.add('hidden');
}

function addNewTile() {
	if (!currentUserId) return;
	stopTileDictation();
	const input = document.getElementById('newTileInput');
	const status = document.getElementById('newTileMicStatus');
	if (input) input.value = '';
	if (status) { status.classList.add('hidden'); status.textContent = ''; }
	document.getElementById('newTileOverlay').classList.remove('hidden');
	setTimeout(() => { if (input) input.focus(); }, 50);
}

function closeNewTileModal() {
	stopTileDictation();
	document.getElementById('newTileOverlay').classList.add('hidden');
}

async function submitNewTile() {
	const input = document.getElementById('newTileInput');
	const name = (input && input.value || '').trim();
	if (!name) { if (input) input.focus(); return; }
	closeNewTileModal();
	await createTileByName(name); // handles insert + render + reminders
}

// --- Speech-to-text for the title ---
// Native Android uses the Capacitor speech-recognition plugin (the Web Speech
// API isn't available in the Android WebView); browsers fall back to it.
let webSpeechRecognizer = null;

function setMicStatus(msg, tone) {
	const el = document.getElementById('newTileMicStatus');
	if (!el) return;
	el.textContent = msg || '';
	el.className = `text-xs mb-3 ${tone === 'error' ? 'text-red-500' : tone === 'live' ? 'text-blue-600' : 'text-slate-500'}${msg ? '' : ' hidden'}`;
}

function setMicActive(active) {
	const btn = document.getElementById('newTileMicBtn');
	if (!btn) return;
	btn.classList.toggle('bg-red-100', active);
	btn.classList.toggle('border-red-300', active);
	btn.classList.toggle('animate-pulse', active);
}

async function startTileDictation() {
	const cap = window.Capacitor;
	const SR = cap && cap.Plugins && cap.Plugins.SpeechRecognition;
	const input = document.getElementById('newTileInput');

	// Native plugin path
	if (SR && cap.isNativePlatform && cap.isNativePlatform()) {
		try {
			const avail = await SR.available();
			if (!(avail && (avail.available === true || avail === true))) {
				setMicStatus('Speech recognition not available on this device.', 'error');
				return;
			}
			const perm = await SR.requestPermissions().catch(() => null);
			if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') {
				setMicStatus('Microphone permission denied.', 'error');
				return;
			}
			setMicActive(true);
			setMicStatus('🎙️ Listening… speak the title', 'live');
			const res = await SR.start({ language: getVoiceLang(), maxResults: 1, partialResults: false, popup: false });
			const text = res && res.matches && res.matches[0];
			if (text && input) input.value = text;
			setMicActive(false);
			setMicStatus(text ? '' : 'Didn\'t catch that — try again.', text ? '' : 'error');
			if (input) input.focus();
		} catch (e) {
			console.error('native dictation error:', e);
			setMicActive(false);
			setMicStatus('Could not start voice input.', 'error');
		}
		return;
	}

	// Web fallback (Chrome / PWA)
	const WebSR = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!WebSR) {
		setMicStatus('Voice input isn\'t supported here — please type the title.', 'error');
		return;
	}
	try {
		webSpeechRecognizer = new WebSR();
		webSpeechRecognizer.lang = getVoiceLang();
		webSpeechRecognizer.interimResults = false;
		webSpeechRecognizer.maxAlternatives = 1;
		setMicActive(true);
		setMicStatus('🎙️ Listening… speak the title', 'live');
		webSpeechRecognizer.onresult = (ev) => {
			const text = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript;
			if (text && input) input.value = text.trim();
			if (input) input.focus();
		};
		webSpeechRecognizer.onerror = (ev) => {
			setMicActive(false);
			setMicStatus(ev.error === 'not-allowed' ? 'Microphone permission denied.' : 'Voice input error — please type.', 'error');
		};
		webSpeechRecognizer.onend = () => { setMicActive(false); setMicStatus(''); };
		webSpeechRecognizer.start();
	} catch (e) {
		console.error('web dictation error:', e);
		setMicActive(false);
		setMicStatus('Could not start voice input.', 'error');
	}
}

function stopTileDictation() {
	setMicActive(false);
	try {
		const cap = window.Capacitor;
		const SR = cap && cap.Plugins && cap.Plugins.SpeechRecognition;
		if (SR && cap.isNativePlatform && cap.isNativePlatform()) SR.stop().catch(() => {});
	} catch (e) {}
	if (webSpeechRecognizer) { try { webSpeechRecognizer.abort(); } catch (e) {} webSpeechRecognizer = null; }
}

// ---- Tag Filter ----
function buildTagTree(tags) {
	// tags: array of { key: tagId, label }. Build a nested tree from parent_id.
	const nodeFor = {};
	tags.forEach(t => { nodeFor[t.key] = { tag: t, children: {} }; });
	const root = {};
	tags.forEach(t => {
		const full = TAGS_BY_ID[t.key];
		const parentId = full ? full.parent_id : null;
		if (parentId && nodeFor[parentId]) {
			nodeFor[parentId].children[t.key] = nodeFor[t.key];
		} else {
			root[t.key] = nodeFor[t.key]; // root, or parent filtered out by search
		}
	});
	return root;
}

function renderTagTree(node, tagCounts, level = 0, tagMoods = {}) {
	const fragment = document.createDocumentFragment();
	// Sort siblings by their stored sort_order, then name.
	const sortedKeys = Object.keys(node).sort((a, b) => {
		const ta = TAGS_BY_ID[a], tb = TAGS_BY_ID[b];
		const soA = ta ? ta.sort_order : 0, soB = tb ? tb.sort_order : 0;
		if (soA !== soB) return soA - soB;
		return (ta ? ta.name : a).localeCompare(tb ? tb.name : b);
	});
	for (const key of sortedKeys) {
		const { tag, children } = node[key];
		// Use tag if present, otherwise synthesize a tag object from the key
		const tagObj = tag || { key: key, label: key };
		const wrapper = document.createElement('div');
		wrapper.style.marginLeft = (level * 22) + 'px';
		wrapper.className = 'relative group flex items-center py-0.5';
		// Expand/collapse if has children
		let expanded = true;
		let toggleBtn = null;
		let childContainer = null; // assigned below; referenced by the toggle handler
		if (Object.keys(children).length > 0) {
			toggleBtn = document.createElement('button');
			toggleBtn.textContent = expanded ? '▼' : '►';
			toggleBtn.className = 'mr-1 text-xs text-slate-400 hover:text-slate-700 focus:outline-none';
			toggleBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				expanded = !expanded;
				toggleBtn.textContent = expanded ? '▼' : '►';
				childContainer.style.display = expanded ? '' : 'none';
			});
			wrapper.appendChild(toggleBtn);
		} else {
			const spacer = document.createElement('span');
			spacer.style.display = 'inline-block';
			spacer.style.width = '18px';
			wrapper.appendChild(spacer);
		}
		const btn = document.createElement('button');
		btn.className = `flex-1 flex items-center gap-2 px-2 py-1 rounded transition text-left ${activeTagFilter === tagObj.key ? 'bg-blue-100 text-blue-900 font-bold' : 'hover:bg-slate-100'
			}`;
		btn.innerHTML =
			`<span class="text-base shrink-0">🏷️</span>` +
			`<span class="flex-1 truncate">${tagObj.label}</span>` +
			`<span class="flex items-center gap-1 shrink-0">${moodChipsHtml(tagMoods[tagObj.key] || {})}</span>`;
		btn.addEventListener('click', () => { if (!tagManageMode) setTagFilter(tagObj.key); });
		wrapper.appendChild(btn);
		// Rename button (always visible in manage mode, hover-only otherwise)
		const editBtn = document.createElement('button');
		editBtn.className = tagManageMode
			? 'ml-1 text-xs text-slate-400 hover:text-blue-500 transition'
			: 'ml-1 text-[10px] text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition';
		editBtn.textContent = '✏️';
		editBtn.title = 'Rename tag';
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			renameTag(tagObj.key);
		});
		wrapper.appendChild(editBtn);
		// Manage controls: reorder, change parent, delete
		if (tagManageMode) {
			const ctrls = document.createElement('div');
			ctrls.className = 'flex items-center gap-1 ml-1 shrink-0';
			ctrls.appendChild(mkIconBtn('⬆', 'Move up', () => moveTag(tagObj.key, -1)));
			ctrls.appendChild(mkIconBtn('⬇', 'Move down', () => moveTag(tagObj.key, 1)));
			ctrls.appendChild(buildParentSelect(tagObj.key));
			ctrls.appendChild(mkIconBtn('🗑️', 'Delete', () => deleteTagFull(tagObj.key)));
			wrapper.appendChild(ctrls);
		}
		fragment.appendChild(wrapper);
		// Children
		if (Object.keys(children).length > 0) {
			childContainer = document.createElement('div');
			childContainer.style.marginLeft = '0px';
			childContainer.appendChild(renderTagTree(children, tagCounts, level + 1, tagMoods));
			fragment.appendChild(childContainer);
		}
	}
	return fragment;
}

// ---- Tag Manager (reorder / re-parent / delete) ----
function mkIconBtn(txt, title, fn) {
	const b = document.createElement('button');
	b.textContent = txt;
	b.title = title;
	b.className = 'text-xs px-1 rounded hover:bg-slate-200 transition';
	b.addEventListener('click', e => { e.stopPropagation(); fn(); });
	return b;
}

function getDescendantIds(id) {
	const out = new Set();
	(function rec(pid) {
		TAGS.filter(t => t.parent_id === pid).forEach(c => { out.add(c.id); rec(c.id); });
	})(id);
	return out;
}

// Dropdown to pick a tag's parent (excludes itself + its descendants to avoid cycles).
function buildParentSelect(id) {
	const cur = TAGS_BY_ID[id] || {};
	const sel = document.createElement('select');
	sel.className = 'text-[11px] border border-slate-200 rounded px-1 py-0.5 bg-white max-w-[110px]';
	sel.title = 'Parent';
	const desc = getDescendantIds(id);
	const root = document.createElement('option');
	root.value = ''; root.textContent = '(root)';
	sel.appendChild(root);
	TAGS.filter(t => t.id !== id && !desc.has(t.id))
		.map(t => ({ id: t.id, path: tagPath(t.id) }))
		.sort((a, b) => a.path.localeCompare(b.path))
		.forEach(o => {
			const op = document.createElement('option');
			op.value = o.id; op.textContent = o.path;
			sel.appendChild(op);
		});
	sel.value = cur.parent_id || '';
	sel.addEventListener('change', e => { e.stopPropagation(); setTagParent(id, sel.value || null); });
	sel.addEventListener('click', e => e.stopPropagation());
	return sel;
}

// Swap a tag with its previous/next sibling (normalizes sort_order to 0..n-1).
async function moveTag(id, dir) {
	const cur = TAGS_BY_ID[id];
	if (!cur) return;
	const siblings = TAGS.filter(t => t.parent_id === cur.parent_id)
		.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
	const i = siblings.findIndex(t => t.id === id);
	const j = i + dir;
	if (j < 0 || j >= siblings.length) return;
	[siblings[i], siblings[j]] = [siblings[j], siblings[i]];
	for (let k = 0; k < siblings.length; k++) {
		if (siblings[k].sort_order !== k) {
			await supa.from('tags').update({ sort_order: k }).eq('id', siblings[k].id);
			siblings[k].sort_order = k;
		}
	}
	rebuildTagIndex();
	if (refreshTagTree) refreshTagTree(); else openTagFilterPopup();
}

async function setTagParent(id, newParentId) {
	const cur = TAGS_BY_ID[id];
	if (!cur || newParentId === id) return;
	if (newParentId && getDescendantIds(id).has(newParentId)) {
		alert("Can't move a tag under one of its own children.");
		openTagFilterPopup();
		return;
	}
	const sibs = TAGS.filter(t => t.parent_id === newParentId && t.id !== id);
	const nextOrder = sibs.length ? Math.max(...sibs.map(s => s.sort_order)) + 1 : 0;
	const { error } = await supa.from('tags').update({ parent_id: newParentId, sort_order: nextOrder }).eq('id', id);
	if (error) { alert('Move failed: ' + error.message); return; }
	cur.parent_id = newParentId;
	cur.sort_order = nextOrder;
	rebuildTagIndex();
	if (refreshTagTree) refreshTagTree(); else openTagFilterPopup();
}

async function deleteTagFull(id) {
	const cur = TAGS_BY_ID[id];
	if (!cur) return;
	if (!confirm(`Delete tag "${cur.name}"?\nIts sub-tags become top-level, and it's removed from any cards.`)) return;
	// Remove the tag id from any task that uses it.
	const affected = Object.values(rawTiles).filter(t => (t.tag_ids || []).includes(id));
	for (const task of affected) {
		task.tag_ids = (task.tag_ids || []).filter(x => x !== id);
		await supa.from('tasks').update({ tag_ids: task.tag_ids }).eq('id', task.id);
		const dt = tiles.find(t => t.id === task.id);
		if (dt) dt.tags = [...task.tag_ids];
	}
	const { error } = await supa.from('tags').delete().eq('id', id); // children.parent_id -> null via FK
	if (error) { alert('Delete failed: ' + error.message); return; }
	if (activeTagFilter === id) activeTagFilter = null;
	await loadTags();
	applyFilters();
	updateFilterBar();
	openTagFilterPopup();
}

function toggleTagManage() {
	tagManageMode = !tagManageMode;
	openTagFilterPopup();
}

function openTagFilterPopup() {
	const overlay = document.getElementById('tagFilterOverlay');
	const grid = document.getElementById('tagFilterGrid');

	// Exclude completed cards from all tag tallies (their health is irrelevant).
	const tagTiles = tiles.filter(t => !['completed', 'cancelled', 'failed'].includes(t.taskStatus));
	const tagCounts = {};
	const tagMoods = {}; // tagKey -> { Thriving: n, Dying: n, ... }
	tagTiles.forEach(tile => {
		(tile.tags || []).forEach(t => {
			tagCounts[t] = (tagCounts[t] || 0) + 1;
			if (!tagMoods[t]) tagMoods[t] = {};
			if (tile.healthLabel) tagMoods[t][tile.healthLabel] = (tagMoods[t][tile.healthLabel] || 0) + 1;
		});
	});

	// Add search box at the top
	grid.innerHTML = '';
	const searchDiv = document.createElement('div');
	searchDiv.className = 'mb-3';
	const searchInput = document.createElement('input');
	searchInput.type = 'text';
	searchInput.placeholder = 'Search tags...';
	searchInput.className = 'w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 shadow-sm';
	searchDiv.appendChild(searchInput);
	grid.appendChild(searchDiv);

	// Controls row (New Tag + All)
	const controlsRow = document.createElement('div');
	controlsRow.className = 'flex flex-row gap-2 mb-4 items-center bg-slate-50 px-2 py-2 rounded-lg border border-slate-100';

	// "+ New Tag" button
	const newBtn = document.createElement('button');
	newBtn.className = 'flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-lg border-2 border-dashed border-blue-300 text-blue-500 hover:bg-blue-50 transition text-center min-w-[70px]';
	newBtn.innerHTML = `<span class="text-base">➕</span><span class="text-xs font-semibold">New Tag</span>`;
	newBtn.addEventListener('click', async () => {
		const name = prompt('New tag name:');
		if (!name || !name.trim()) return;
		const { data, error } = await supa.from('tags')
			.insert({ user_id: currentUserId, name: name.trim() })
			.select().single();
		if (error) { alert('Create tag failed: ' + error.message); return; }
		if (data) { TAGS.push(data); rebuildTagIndex(); }
		openTagFilterPopup();
	});
	controlsRow.appendChild(newBtn);

	// "All" tile
	const allBtn = document.createElement('button');
	allBtn.className = `flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-lg border-2 transition text-center min-w-[70px] ${activeTagFilter === null ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
	allBtn.innerHTML = `<span class="text-base">🌐</span><span class="text-xs font-semibold">All</span><span class="text-[10px] text-slate-400">${tagTiles.length}</span>`;
	allBtn.addEventListener('click', () => { setTagFilter(null); });
	controlsRow.appendChild(allBtn);

	// "Manage" toggle (reorder / re-parent / delete)
	const manageBtn = document.createElement('button');
	manageBtn.className = `flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-lg border-2 transition text-center min-w-[70px] ${tagManageMode ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'}`;
	manageBtn.innerHTML = `<span class="text-base">🛠️</span><span class="text-xs font-semibold">${tagManageMode ? 'Done' : 'Manage'}</span>`;
	manageBtn.addEventListener('click', toggleTagManage);
	controlsRow.appendChild(manageBtn);

	grid.appendChild(controlsRow);

	// Container for tag tree
	const tagTreeContainer = document.createElement('div');
	grid.appendChild(tagTreeContainer);

	function filterTags(tags, query) {
		if (!query) return tags;
		const q = query.toLowerCase();
		return tags.filter(t => t.key.toLowerCase().includes(q) || t.label.toLowerCase().includes(q));
	}

	function renderFilteredTree() {
		tagTreeContainer.innerHTML = '';

		// Treeview for tags (filtered)
		const filteredTags = filterTags(ALL_TAGS, searchInput.value);
		const tagTree = buildTagTree(filteredTags);
		tagTreeContainer.appendChild(renderTagTree(tagTree, tagCounts, 0, tagMoods));

		// Untagged
		const untaggedCount = tagTiles.filter(t => !t.tags || t.tags.length === 0).length;
		if (untaggedCount > 0) {
			const btn = document.createElement('button');
			btn.className = `flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-lg border-2 transition text-center min-w-[70px] ${activeTagFilter === '__untagged__' ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
				}`;
			btn.innerHTML = `<span class="text-base">📦</span><span class="text-xs font-semibold">Untagged</span><span class="text-[10px] text-slate-400">${untaggedCount}</span>`;
			btn.addEventListener('click', () => { setTagFilter('__untagged__'); });
			tagTreeContainer.appendChild(btn);
		}
	}

	renderFilteredTree();
	refreshTagTree = renderFilteredTree; // lets manage actions re-render in place

	searchInput.addEventListener('input', renderFilteredTree);

	overlay.classList.remove('hidden');
}

function closeTagFilterPopup() {
	document.getElementById('tagFilterOverlay').classList.add('hidden');
}

async function renameTag(id) {
	const cur = TAGS_BY_ID[id];
	if (!cur) return;
	const newName = prompt('Rename tag:', cur.name);
	if (!newName || !newName.trim() || newName.trim() === cur.name) return;
	const name = newName.trim();
	const { error } = await supa.from('tags').update({ name }).eq('id', id);
	if (error) { alert('Rename failed: ' + error.message); return; }
	cur.name = name;            // task assignments are unaffected (they use the id)
	rebuildTagIndex();
	if (refreshTagTree) refreshTagTree(); else openTagFilterPopup();
}

function setTagFilter(tag) {
	activeTagFilter = tag;
	applyFilters();        // filter the gallery in the background
	updateFilterBar();
	// Keep the popup open and re-highlight the active tag (if it's showing).
	const overlay = document.getElementById('tagFilterOverlay');
	if (refreshTagTree && overlay && !overlay.classList.contains('hidden')) refreshTagTree();
}

function updateFilterBar() {
	const bar = document.getElementById('activeFilterBar');
	const label = document.getElementById('activeFilterLabel');
	if (activeTagFilter === null) {
		bar.classList.add('hidden');
	} else {
		bar.classList.remove('hidden');
		if (activeTagFilter === '__untagged__') {
			label.textContent = '📦 Untagged';
		} else {
			label.textContent = '🏷️ ' + tagPath(activeTagFilter);
		}
	}
}

function isTileScheduledToday(tileId) {
	const raw = rawTiles[tileId];
	if (!raw) return false;
	const mode = raw.frequency_mode || 'daily';
	if (mode === 'daily' || mode === 'monthly') return true;
	if (mode === 'weekly') {
		const todayDay = new Date().getDay(); // 0=Sun..6=Sat
		const freqDays = (raw.task_frequency_days || []).map(d => d.day_of_week);
		return freqDays.includes(todayDay);
	}
	if (mode === 'once') {
		if (!raw.end_date) return false;
		const today = todayLocal();
		return raw.end_date === today;
	}
	return true;
}

function toggleTodayFilter() {
	activeTimelineFilter = activeTimelineFilter === 'today' ? null : 'today';
	const btn = document.getElementById('todayFilterBtn');
	if (btn) {
		if (activeTimelineFilter === 'today') {
			btn.classList.remove('bg-white');
			btn.classList.add('bg-blue-100', 'border-blue-400', 'text-blue-700');
		} else {
			btn.classList.remove('bg-blue-100', 'border-blue-400', 'text-blue-700');
			btn.classList.add('bg-white');
		}
	}
	applyFilters();
}

const STATUS_CYCLE = [
	{ key: null, label: '⭐ All', bg: 'bg-white' },
	{ key: 'done', label: '💪 Done', bg: 'bg-green-100' },
	{ key: 'skipped', label: '😢 Skip', bg: 'bg-yellow-100' },
	{ key: 'noaction', label: '💬 No Action', bg: 'bg-slate-100' }
];

// ---- Today Summary (done/skipped & remaining due) ----
// Bucket tiles by today's LOCAL log_date: done, skipped, and still
// scheduled-due-but-untouched. Read straight from the logs so it can't
// drift from a tile's cached status.
function getTodaySummary() {
	const today = todayLocal();
	const done = [], skipped = [], remaining = [];
	(tiles || []).forEach(t => {
		const logs = (rawTiles[t.id] && rawTiles[t.id].task_logs) || [];
		const todayLog = logs.find(l => logDay(l) === today &&
			(l.status === 'done' || l.status === 'completed' || l.status === 'skipped'));
		if (todayLog) {
			(todayLog.status === 'skipped' ? skipped : done).push(t);
		} else if (isTileScheduledToday(t.id)) {
			remaining.push(t); // scheduled today, no action yet
		}
	});
	return { done, skipped, remaining };
}

function refreshTodaySummaryCounts() {
	const { done, skipped, remaining } = getTodaySummary();
	const dc = document.getElementById('todayDoneCount');
	const rc = document.getElementById('todayRemainingCount');
	if (dc) dc.textContent = String(done.length + skipped.length);
	if (rc) rc.textContent = String(remaining.length);
}

function toggleTodaySummaryMenu(forceOpen) {
	const menu = document.getElementById('todaySummaryMenu');
	const btn = document.getElementById('todaySummaryBtn');
	if (!menu || !btn) return;
	const open = forceOpen !== undefined ? forceOpen : menu.classList.contains('hidden');
	menu.classList.toggle('hidden', !open);
	btn.setAttribute('aria-expanded', open ? 'true' : 'false');
	if (open) refreshTodaySummaryCounts();
}

// A row button that links to a tile's detail popup.
function todaySummaryRow(t, hover) {
	return `<button class="today-summary-row w-full flex items-center gap-2 px-2.5 py-2 rounded-lg ${hover} text-left transition" data-tile-id="${t.id}">
		<span class="text-lg shrink-0">${t.emoji}</span>
		<span class="flex-1 text-sm font-medium text-slate-700 truncate">${escapeHtml(t.name)}</span>
	</button>`;
}

function openTodaySummary(type) {
	const overlay = document.getElementById('todaySummaryOverlay');
	const titleEl = document.getElementById('todaySummaryTitle');
	const iconEl = document.getElementById('todaySummaryIcon');
	const body = document.getElementById('todaySummaryBody');
	const { done, skipped, remaining } = getTodaySummary();

	if (type === 'done') {
		titleEl.textContent = "Today's Log";
		iconEl.textContent = '✅';
		// Two-column table: Done on the left, Skip on the right.
		const column = (items, head, headClass, hover) => {
			const rows = items.length
				? items.map(t => todaySummaryRow(t, hover)).join('')
				: '<div class="text-center text-slate-300 text-xs py-6">—</div>';
			return `<div class="flex flex-col gap-0.5">
				<div class="sticky top-0 ${headClass} text-sm font-bold px-2 py-1.5 rounded-lg mb-1 text-center">${head} (${items.length})</div>
				${rows}
			</div>`;
		};
		body.innerHTML = (!done.length && !skipped.length)
			? '<div class="text-center text-slate-400 py-12 text-sm">Nothing logged yet today.</div>'
			: `<div class="grid grid-cols-2 gap-3 items-start">
				${column(done, '✅ Done', 'bg-green-100 text-green-700', 'hover:bg-green-50')}
				${column(skipped, '⏭️ Skip', 'bg-yellow-100 text-yellow-700', 'hover:bg-yellow-50')}
			</div>`;
	} else {
		titleEl.textContent = 'Remaining Today';
		iconEl.textContent = '📋';
		body.innerHTML = remaining.length
			? remaining.map(t => todaySummaryRow(t, 'hover:bg-slate-50')).join('')
			: '<div class="text-center text-slate-400 py-12 text-sm">🎉 All done — nothing left for today!</div>';
	}

	body.querySelectorAll('.today-summary-row').forEach(row => {
		row.addEventListener('click', () => {
			closeTodaySummary();
			openTilePopup(row.getAttribute('data-tile-id'));
		});
	});

	toggleTodaySummaryMenu(false);
	overlay.classList.remove('hidden');
}

function closeTodaySummary() {
	document.getElementById('todaySummaryOverlay').classList.add('hidden');
}

// Combined today view: Remaining list + Done/Skip table in one popup.
function openTodaySummaryCombined() {
	const overlay = document.getElementById('todaySummaryOverlay');
	const titleEl = document.getElementById('todaySummaryTitle');
	const iconEl = document.getElementById('todaySummaryIcon');
	const body = document.getElementById('todaySummaryBody');
	const { done, skipped, remaining } = getTodaySummary();
	titleEl.textContent = "Today's Summary";
	iconEl.textContent = '📋';

	const listOr = (items, hover) => items.length
		? items.map(t => todaySummaryRow(t, hover)).join('')
		: '<div class="text-center text-slate-300 text-xs py-3">—</div>';
	const col = (items, head, headClass, hover) =>
		`<div class="flex flex-col gap-0.5"><div class="${headClass} text-sm font-bold px-2 py-1.5 rounded-lg mb-1 text-center">${head} (${items.length})</div>${listOr(items, hover)}</div>`;

	body.innerHTML = `
		<div class="mb-4">
			<div class="bg-blue-100 text-blue-700 text-sm font-bold px-2 py-1.5 rounded-lg mb-1 text-center">📋 Remaining (${remaining.length})</div>
			${listOr(remaining, 'hover:bg-slate-50')}
		</div>
		<div class="grid grid-cols-2 gap-3 items-start">
			${col(done, '✅ Done', 'bg-green-100 text-green-700', 'hover:bg-green-50')}
			${col(skipped, '⏭️ Skip', 'bg-yellow-100 text-yellow-700', 'hover:bg-yellow-50')}
		</div>`;
	body.querySelectorAll('.today-summary-row').forEach(row => {
		row.addEventListener('click', () => { closeTodaySummary(); openTilePopup(row.getAttribute('data-tile-id')); });
	});
	overlay.classList.remove('hidden');
}

// ---- Calendar & Filter menus ----
function openCalendarMenu() {
	// Reflect whether the Today filter is currently on.
	const t = document.getElementById('todayItemsBtn');
	if (t) {
		const on = activeTimelineFilter === 'today';
		t.classList.toggle('bg-blue-50', on);
		t.classList.toggle('border-blue-300', on);
		t.classList.toggle('text-blue-700', on);
		t.textContent = on ? '📅 Today\'s items ✓' : '📅 Today\'s items';
	}
	document.getElementById('calendarMenuOverlay').classList.remove('hidden');
}
function closeCalendarMenu() { document.getElementById('calendarMenuOverlay').classList.add('hidden'); }
function openFilterMenu() { document.getElementById('filterMenuOverlay').classList.remove('hidden'); }
function closeFilterMenu() { document.getElementById('filterMenuOverlay').classList.add('hidden'); }

function toggleStatusFilter() {
	const idx = STATUS_CYCLE.findIndex(s => s.key === activeStatusFilter);
	const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
	activeStatusFilter = next.key;
	const btn = document.getElementById('statusFilterBtn');
	btn.classList.remove('bg-white', 'bg-green-100', 'bg-yellow-100', 'bg-slate-100', 'border-slate-800', 'text-slate-800');
	btn.classList.add(next.bg);
	if (next.key) {
		btn.classList.add('border-slate-800', 'text-slate-800');
	}
	btn.textContent = next.label;
	applyFilters();
}

const LIFECYCLE_CYCLE = [
		{ key: 'active', label: '🔥 Active', bg: 'bg-orange-100 text-orange-700 border-orange-300' },
		{ key: 'all', label: '📊 All', bg: 'bg-white text-slate-700 border-slate-300' },
		{ key: 'planned', label: '📋 Planned', bg: 'bg-blue-100 text-blue-700 border-blue-300' },
		{ key: 'in progress', label: '🔄 In Progress', bg: 'bg-green-100 text-green-700 border-green-300' },
		{ key: 'completed', label: '✅ Completed', bg: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
		{ key: 'failed', label: '❌ Failed', bg: 'bg-red-100 text-red-700 border-red-300' },
		{ key: 'cancelled', label: '🚫 Cancelled', bg: 'bg-slate-100 text-slate-600 border-slate-300' }
	];

function toggleLifecycleFilter() {
	const idx = LIFECYCLE_CYCLE.findIndex(s => s.key === activeLifecycleFilter);
	const next = LIFECYCLE_CYCLE[(idx + 1) % LIFECYCLE_CYCLE.length];
	activeLifecycleFilter = next.key;
	const btn = document.getElementById('lifecycleFilterBtn');
	btn.className = `inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border text-sm font-medium whitespace-nowrap shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 ${next.bg}`;
	btn.textContent = next.label;
	applyFilters();
}

// ---- Frequency filter ----
const FREQ_CYCLE = [
	{ key: null, label: '🔁 All Freq', bg: 'bg-white text-slate-700 border-slate-300' },
	{ key: 'daily', label: '📆 Daily', bg: 'bg-indigo-100 text-indigo-700 border-indigo-300' },
	{ key: 'weekly', label: '🗓️ Weekly', bg: 'bg-violet-100 text-violet-700 border-violet-300' },
	{ key: 'monthly', label: '📅 Monthly', bg: 'bg-teal-100 text-teal-700 border-teal-300' },
	{ key: 'once', label: '📍 Once', bg: 'bg-amber-100 text-amber-700 border-amber-300' }
];

function toggleFreqFilter() {
	const idx = FREQ_CYCLE.findIndex(s => s.key === activeFreqFilter);
	const next = FREQ_CYCLE[(idx + 1) % FREQ_CYCLE.length];
	activeFreqFilter = next.key;
	const btn = document.getElementById('freqFilterBtn');
	btn.className = `inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border text-sm font-medium whitespace-nowrap shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 ${next.bg}`;
	btn.textContent = next.label;
	applyFilters();
}

// ---- Mood (health state) filter ----
// Order/emoji mirror healthToPlant().
const MOODS = [
	{ label: 'Thriving', emoji: '⭐' },
	{ label: 'Healthy', emoji: '☀️' },
	{ label: 'Growing', emoji: '⛅' },
	{ label: 'Wilting', emoji: '🌧️' },
	{ label: 'Dying', emoji: '⚡' }
];

// Subtle tinted pill styles per mood, for the breakdown chips.
const MOOD_CHIP = {
	Thriving: 'bg-green-100 text-green-700',
	Healthy: 'bg-emerald-100 text-emerald-700',
	Growing: 'bg-amber-100 text-amber-700',
	Wilting: 'bg-orange-100 text-orange-700',
	Dying: 'bg-red-100 text-red-700'
};

// Compact colored chips for a mood-count map, e.g. { Thriving: 2, Dying: 1 }.
function moodChipsHtml(counts) {
	return MOODS
		.filter(m => (counts[m.label] || 0) > 0)
		.map(m => `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${MOOD_CHIP[m.label]}" title="${m.label}">${m.emoji}<span class="tabular-nums">${counts[m.label]}</span></span>`)
		.join('');
}

function openMoodFilterPopup() {
	const grid = document.getElementById('moodFilterGrid');
	grid.innerHTML = '';

	// Count tiles per mood — exclude completed cards (their health is irrelevant).
	const countable = tiles.filter(t => !['completed', 'cancelled', 'failed'].includes(t.taskStatus));
	const counts = {};
	MOODS.forEach(m => { counts[m.label] = 0; });
	countable.forEach(t => { if (counts[t.healthLabel] != null) counts[t.healthLabel]++; });

	const rowClass = active => `flex items-center justify-between gap-2 w-full px-4 py-2.5 rounded-xl border transition text-left ${active ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'}`;

	// "All moods" row
	const allBtn = document.createElement('button');
	allBtn.className = rowClass(activeMoodFilter === null);
	allBtn.innerHTML = `<span class="font-semibold">🌈 All moods</span><span class="text-xs font-semibold text-slate-400">${countable.length}</span>`;
	allBtn.addEventListener('click', () => setMoodFilter(null));
	grid.appendChild(allBtn);

	MOODS.forEach(m => {
		const btn = document.createElement('button');
		btn.className = rowClass(activeMoodFilter === m.label);
		btn.innerHTML = `<span class="font-medium"><span class="text-lg mr-1.5">${m.emoji}</span>${m.label}</span><span class="text-xs font-semibold text-slate-500">${counts[m.label]}</span>`;
		btn.addEventListener('click', () => setMoodFilter(m.label));
		grid.appendChild(btn);
	});

	document.getElementById('moodFilterOverlay').classList.remove('hidden');
}

function closeMoodFilterPopup() {
	document.getElementById('moodFilterOverlay').classList.add('hidden');
}

function setMoodFilter(label) {
	activeMoodFilter = label;
	closeMoodFilterPopup();
	updateMoodFilterBtn();
	applyFilters();
}

function updateMoodFilterBtn() {
	const btn = document.getElementById('moodFilterBtn');
	if (!btn) return;
	if (activeMoodFilter) {
		const m = MOODS.find(x => x.label === activeMoodFilter);
		btn.textContent = `${m ? m.emoji : '🌦️'} ${activeMoodFilter}`;
		btn.classList.remove('bg-white');
		btn.classList.add('bg-sky-100', 'border-sky-300', 'text-sky-700');
	} else {
		btn.textContent = '🌦️ Mood';
		btn.classList.remove('bg-sky-100', 'border-sky-300', 'text-sky-700');
		btn.classList.add('bg-white');
	}
}

function applyFilters() {
	let filtered = [...tiles];
	if (activeTagFilter === '__untagged__') {
		filtered = filtered.filter(t => !t.tags || t.tags.length === 0);
	} else if (activeTagFilter) {
		// Include the selected tag AND all of its child tags (e.g. work → work-idari…).
		const wanted = getDescendantIds(activeTagFilter);
		wanted.add(activeTagFilter);
		filtered = filtered.filter(t => (t.tags || []).some(tag => wanted.has(tag)));
	}
	if (activeTimelineFilter === 'today') {
		filtered = filtered.filter(t => isTileScheduledToday(t.id));
	}
	if (activeStatusFilter) {
		filtered = filtered.filter(t => t.status === activeStatusFilter);
	}
	   // Lifecycle filter
	   if (activeLifecycleFilter && activeLifecycleFilter !== 'all') {
		   if (activeLifecycleFilter === 'active') {
			   filtered = filtered.filter(t => t.taskStatus === 'planned' || t.taskStatus === 'in progress');
		   } else {
			   filtered = filtered.filter(t => t.taskStatus === activeLifecycleFilter);
		   }
	   }
		       if (activeMoodFilter) {
			filtered = filtered.filter(t => t.healthLabel === activeMoodFilter);
		}
		if (activeFreqFilter) {
			filtered = filtered.filter(t => ((rawTiles[t.id] && rawTiles[t.id].frequency_mode) || 'daily') === activeFreqFilter);
		}
		const q = (document.getElementById('searchBox').value || '').trim().toLowerCase();
		       if (q) {
			       if (q === 'overdue') {
				       filtered = filtered.filter(t => getNextDueLabel(t.id) === 'overdue');
			       } else if (["january","february","march","april","may","june","july","august","september","october","november","december"].includes(q)) {
				       // Filter by month name on lastUpdate
				       filtered = filtered.filter(t => {
					       if (!t.lastUpdate) return false;
					       const d = new Date(t.lastUpdate);
					       const month = d.toLocaleString('default', { month: 'long' }).toLowerCase();
					       return month === q;
				       });
			       } else {
				       // Search by name or tag (partial, case-insensitive)
				       filtered = filtered.filter(t => {
					       const nameMatch = t.name.toLowerCase().includes(q);
					       const tagMatch = (t.tags || []).some(id => tagName(id).toLowerCase().includes(q));
					       return nameMatch || tagMatch;
				       });
			       }
		       }
	renderGallery(filtered);
}

// ---- AI Chat ----
let aiChatHistory = []; // { role: 'user'|'assistant', content: string }

function buildTaskContext() {
	const taskSummaries = Object.values(rawTiles).map(task => {
		const logs = task.task_logs || [];
		const health = calculateHealth(task);
		const plant = healthToPlant(health);
		const lastLog = logs[0];
		const todayStr = todayLocal();
		const todayLog = logs.find(l => logDay(l) === todayStr);
		const recentLogs = logs.slice(0, 7).map(l => `${logDay(l)}: ${l.status}${l.note ? ' — ' + l.note : ''}`).join('; ');

		return `• id=${task.id} "${task.name}" | tags: [${(task.tag_ids || []).map(tagName).join(', ')}] | freq: ${task.frequency_mode}${task.end_date ? ' | date: ' + task.end_date : ''}${task.day_of_month ? ' | dom: ' + task.day_of_month : ''} | lifecycle: ${task.status || 'in progress'} | health: ${health}% (${plant.label}) | total logs: ${logs.length} | today: ${todayLog ? todayLog.status : 'no action'} | recent: ${recentLogs || 'none'}`;
	});

	const overallHealth = tiles.length > 0 ? Math.round(tiles.reduce((s, t) => s + (t.health || 0), 0) / tiles.length) : 0;
	const doneToday = tiles.filter(t => t.status === 'done' || t.status === 'completed').length;
	const skippedToday = tiles.filter(t => t.status === 'skipped').length;
	const noActionToday = tiles.filter(t => t.status === 'noaction').length;

	return `Date: ${new Date().toLocaleDateString()}
Total tasks: ${tiles.length}
Overall avg health: ${overallHealth}%
Today's progress: ${doneToday} done, ${skippedToday} skipped, ${noActionToday} pending

TASKS:
${taskSummaries.join('\n')}`;
}

function openAiChat() {
	document.getElementById('aiChatOverlay').classList.remove('hidden');
	document.getElementById('aiChatInput').focus();
	if (aiChatHistory.length === 0) {
		appendAiMessage('assistant', "Hi! I'm your LifeWorld AI coach 🤖\n\nI can see all your tasks and their health scores. Ask me anything — or tap a quick prompt below to get started!");
	}
}

function closeAiChat() {
	document.getElementById('aiChatOverlay').classList.add('hidden');
}

function clearAiChat() {
	aiChatHistory = [];
	document.getElementById('aiChatMessages').innerHTML = '';
	appendAiMessage('assistant', "Chat cleared! Ask me anything about your tasks 🤖");
}

function appendAiMessage(role, content) {
	const container = document.getElementById('aiChatMessages');
	const bubble = document.createElement('div');
	if (role === 'user') {
		bubble.className = 'flex justify-end';
		bubble.innerHTML = `<div class="bg-purple-500 text-white rounded-2xl rounded-br-sm px-4 py-2 max-w-[80%] text-sm whitespace-pre-wrap">${escapeHtml(content)}</div>`;
	} else if (role === 'assistant') {
		bubble.className = 'flex justify-start';
		bubble.innerHTML = `<div class="bg-slate-100 text-slate-800 rounded-2xl rounded-bl-sm px-4 py-2 max-w-[80%] text-sm whitespace-pre-wrap">${formatAiResponse(content)}</div>`;
	} else if (role === 'loading') {
		bubble.className = 'flex justify-start';
		bubble.id = 'aiLoadingBubble';
		bubble.innerHTML = `<div class="bg-slate-100 text-slate-400 rounded-2xl rounded-bl-sm px-4 py-2 text-sm animate-pulse">Thinking...</div>`;
	}
	container.appendChild(bubble);
	container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

function formatAiResponse(text) {
	// Basic markdown-like formatting
	return escapeHtml(text)
		.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.*?)\*/g, '<em>$1</em>')
		.replace(/`(.*?)`/g, '<code class="bg-slate-200 px-1 rounded text-xs">$1</code>');
}

// Backend base URL. Same-origin on the web; absolute when the app runs from a
// bundled/native context (capacitor://, file://, or localhost) so /api calls
// still reach the deployed backend.
const API_BASE = (/^(capacitor|ionic|file):/i.test(location.protocol) || location.hostname === 'localhost')
	? 'https://lifeworld.vercel.app'
	: '';

// Lemon Squeezy hosted checkout for the premium subscription.
const LEMONSQUEEZY_CHECKOUT_URL = 'https://lifeworld.lemonsqueezy.com/checkout/buy/e914f905-4cbb-44f6-b905-74e5478dd592';

// Open LS checkout, passing the Supabase user id so the webhook can grant premium.
async function openUpgradeCheckout() {
	if (LEMONSQUEEZY_CHECKOUT_URL.includes('STORE') || LEMONSQUEEZY_CHECKOUT_URL.includes('VARIANT_ID')) {
		appendAiMessage('assistant', '⚠️ Upgrades are not configured yet. Please check back soon.');
		return;
	}
	const { data: { session } } = await supa.auth.getSession();
	if (!session) {
		appendAiMessage('assistant', '⚠️ Please sign in to upgrade.');
		return;
	}
	const params = `checkout[custom][user_id]=${encodeURIComponent(session.user.id)}`
		+ (session.user.email ? `&checkout[email]=${encodeURIComponent(session.user.email)}` : '');
	const sep = LEMONSQUEEZY_CHECKOUT_URL.includes('?') ? '&' : '?';
	window.open(`${LEMONSQUEEZY_CHECKOUT_URL}${sep}${params}`, '_blank');
}

// Render an "Upgrade to Premium" button as a chat bubble.
function appendUpgradeButton() {
	const container = document.getElementById('aiChatMessages');
	const wrap = document.createElement('div');
	wrap.className = 'flex justify-start';
	wrap.innerHTML = `<button class="px-4 py-2 rounded-full text-sm font-semibold text-white bg-gradient-to-r from-purple-500 to-fuchsia-500 shadow-md shadow-purple-500/30 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200">✨ Upgrade to Premium</button>`;
	wrap.querySelector('button').addEventListener('click', openUpgradeCheckout);
	container.appendChild(wrap);
	container.scrollTop = container.scrollHeight;
}

// ---- AI task actions (create / update / delete) ----
// The assistant may return {"actions":[...], "message":"..."}; we execute the
// actions against Supabase as the signed-in user, then refresh from the DB.
function resolveTagIds(names) {
	const ids = [];
	(names || []).forEach(n => {
		const t = (TAGS || []).find(x => x.name.toLowerCase() === String(n).trim().toLowerCase());
		if (t) ids.push(t.id);
	});
	return ids;
}

// Map an AI action's fields to a tasks-row patch (shared by create/update).
function aiTaskPatch(a) {
	const patch = {};
	if (a.name != null) patch.name = String(a.name).trim();
	if (a.frequency) patch.frequency_mode = a.frequency;
	if (a.status) patch.status = a.status;
	if (a.end_date !== undefined) patch.end_date = a.end_date || null;
	if (a.day_of_month !== undefined) patch.day_of_month = a.day_of_month ? parseInt(a.day_of_month, 10) : null;
	if (Array.isArray(a.tags)) patch.tag_ids = resolveTagIds(a.tags);
	return patch;
}

// Replace a task's weekly weekdays (0=Sun..6=Sat) when provided.
async function aiSetWeekdays(taskId, weekdays) {
	if (!Array.isArray(weekdays)) return;
	await supa.from('task_frequency_days').delete().eq('task_id', taskId);
	const rows = weekdays.map(d => ({ task_id: taskId, day_of_week: parseInt(d, 10) })).filter(r => r.day_of_week >= 0 && r.day_of_week <= 6);
	if (rows.length) await supa.from('task_frequency_days').insert(rows);
}

async function aiCreateTask(a) {
	const patch = aiTaskPatch(a);
	if (!patch.name) throw new Error('missing name');
	if (!patch.frequency_mode) patch.frequency_mode = 'daily';
	patch.user_id = currentUserId;
	const { data, error } = await supa.from('tasks').insert(patch).select('id').single();
	if (error || !data) throw error || new Error('insert failed');
	if (patch.frequency_mode === 'weekly') await aiSetWeekdays(data.id, a.weekdays);
	return `✅ Created “${patch.name}”`;
}

async function aiUpdateTask(a) {
	if (!a.id || !rawTiles[a.id]) throw new Error('unknown task id');
	const patch = aiTaskPatch(a);
	delete patch.user_id;
	const name = patch.name || rawTiles[a.id].name;
	if (Object.keys(patch).length) {
		const { error } = await supa.from('tasks').update(patch).eq('id', a.id);
		if (error) throw error;
	}
	if ((patch.frequency_mode || rawTiles[a.id].frequency_mode) === 'weekly' && Array.isArray(a.weekdays)) {
		await aiSetWeekdays(a.id, a.weekdays);
	}
	return `✏️ Updated “${name}”`;
}

async function aiDeleteTask(a) {
	if (!a.id || !rawTiles[a.id]) throw new Error('unknown task id');
	const name = rawTiles[a.id].name;
	await supa.from('task_logs').delete().eq('task_id', a.id);
	await supa.from('task_frequency_days').delete().eq('task_id', a.id);
	const { error } = await supa.from('tasks').delete().eq('id', a.id);
	if (error) throw error;
	return `🗑️ Deleted “${name}”`;
}

async function executeAiActions(actions) {
	// Confirm destructive deletes before running anything.
	const deletes = actions.filter(a => a && a.type === 'delete' && a.id && rawTiles[a.id]);
	if (deletes.length) {
		const names = deletes.map(d => `“${rawTiles[d.id].name}”`).join(', ');
		if (!confirm(`The AI wants to DELETE ${deletes.length} task(s): ${names}.\n\nThis can't be undone. Proceed?`)) {
			actions = actions.filter(a => !(a.type === 'delete'));
			if (!actions.length) return '❌ Cancelled — nothing changed.';
		}
	}
	const results = [];
	for (const a of actions) {
		try {
			if (a.type === 'create') results.push(await aiCreateTask(a));
			else if (a.type === 'update') results.push(await aiUpdateTask(a));
			else if (a.type === 'delete') results.push(await aiDeleteTask(a));
		} catch (e) {
			console.error('AI action failed:', a, e);
			results.push(`⚠️ Could not ${a.type} ${a.name ? '“' + a.name + '”' : (a.id || '')}`);
		}
	}
	await fetchTilesFromSupabase(); // reload everything so the UI is consistent
	return results.join('\n');
}

async function sendAiMessage(text) {
	if (!text || !text.trim()) return;
	const msg = text.trim();

	// Add user message
	aiChatHistory.push({ role: 'user', content: msg });
	appendAiMessage('user', msg);
	document.getElementById('aiChatInput').value = '';

	// Show loading
	appendAiMessage('loading', '');

	try {
		const taskContext = buildTaskContext();
		const { data: { session } } = await supa.auth.getSession();
		if (!session) {
			const loading = document.getElementById('aiLoadingBubble');
			if (loading) loading.remove();
			appendAiMessage('assistant', '⚠️ Please sign in to use the AI assistant.');
			return;
		}
		const response = await fetch(`${API_BASE}/api/ai`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${session.access_token}`
			},
			body: JSON.stringify({
				messages: aiChatHistory,
				taskContext
			})
		});

		// Remove loading bubble
		const loading = document.getElementById('aiLoadingBubble');
		if (loading) loading.remove();

		if (!response.ok) {
			const err = await response.json().catch(() => ({}));
			if (response.status === 429 || err.code === 'quota_exceeded') {
				appendAiMessage('assistant', '🔒 ' + (err.error || "You've hit today's free AI limit. Upgrade to Premium for unlimited coaching."));
				appendUpgradeButton();
				return;
			}
			const errMsg = err.error || 'Something went wrong. Please try again.';
			appendAiMessage('assistant', '⚠️ ' + errMsg);
			return;
		}

		   const data = await response.json();
		   const reply = data.reply || 'No response.';
		   // The AI may return an action command (create/update/delete tasks).
		   let handled = false;
		   try {
			   const cmd = JSON.parse(stripFences(reply));
			   if (cmd && Array.isArray(cmd.actions) && cmd.actions.length) {
				   const summary = await executeAiActions(cmd.actions);
				   const msg = [cmd.message, summary].filter(Boolean).join('\n\n') || 'Done.';
				   aiChatHistory.push({ role: 'assistant', content: msg });
				   appendAiMessage('assistant', msg);
				   handled = true;
			   } else if (cmd && cmd.action === 'create_tile' && cmd.name) {
				   await createTileByName(cmd.name);
				   handled = true;
			   }
		   } catch (e) {}
		   if (!handled) {
			   aiChatHistory.push({ role: 'assistant', content: reply });
			   appendAiMessage('assistant', reply);
		   }
	} catch (err) {
		const loading = document.getElementById('aiLoadingBubble');
		if (loading) loading.remove();
		console.error('AI chat error:', err);
		appendAiMessage('assistant', '⚠️ Network error. Please check your connection and try again.');
	}
}

function initAiChat() {
	document.getElementById('aiChatBtn').addEventListener('click', openAiChat);
	document.getElementById('closeAiChat').addEventListener('click', closeAiChat);
	document.getElementById('clearChatBtn').addEventListener('click', clearAiChat);
	document.getElementById('aiChatOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('aiChatOverlay')) closeAiChat();
	});
	document.getElementById('aiSendBtn').addEventListener('click', () => {
		sendAiMessage(document.getElementById('aiChatInput').value);
	});
	document.getElementById('aiChatInput').addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendAiMessage(document.getElementById('aiChatInput').value);
		}
	});
	document.querySelectorAll('.ai-quick-prompt').forEach(btn => {
		btn.addEventListener('click', () => {
			sendAiMessage(btn.dataset.prompt);
		});
	});
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
	initPopup();
	initAddLogPopup();
	initAiChat();
	initNotifications();
	fetchTilesFromSupabase();

	document.getElementById('searchBox').addEventListener('input', () => applyFilters());
	document.getElementById('tagFilterBtn').addEventListener('click', openTagFilterPopup);
	document.getElementById('closeTagFilter').addEventListener('click', closeTagFilterPopup);
	document.getElementById('tagFilterOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('tagFilterOverlay')) closeTagFilterPopup();
	});
	document.getElementById('clearFilterBtn').addEventListener('click', () => setTagFilter(null));
	document.getElementById('statusFilterBtn').addEventListener('click', toggleStatusFilter);
	document.getElementById('freqFilterBtn').addEventListener('click', toggleFreqFilter);

	// Auto-refresh the done/skip flags when reopened on a new day.
	document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeRefreshForNewDay(); });
	window.addEventListener('focus', maybeRefreshForNewDay);
	const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
	if (capApp) capApp.addListener('resume', maybeRefreshForNewDay);
	document.getElementById('lifecycleFilterBtn').addEventListener('click', toggleLifecycleFilter);
	document.getElementById('moodFilterBtn').addEventListener('click', openMoodFilterPopup);
	document.getElementById('closeMoodFilter').addEventListener('click', closeMoodFilterPopup);
	document.getElementById('moodFilterOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('moodFilterOverlay')) closeMoodFilterPopup();
	});
	document.getElementById('addTileBtn').addEventListener('click', addNewTile);

	// New-tile modal (type or dictate the title)
	document.getElementById('closeNewTile').addEventListener('click', closeNewTileModal);
	document.getElementById('createNewTileBtn').addEventListener('click', submitNewTile);
	document.getElementById('newTileMicBtn').addEventListener('click', startTileDictation);

	// Settings popup (voice language, …)
	document.getElementById('settingsBtn').addEventListener('click', openSettings);
	document.getElementById('closeSettings').addEventListener('click', closeSettings);
	document.getElementById('settingsOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('settingsOverlay')) closeSettings();
	});
	document.getElementById('settingsVoiceLang').addEventListener('change', e => setVoiceLang(e.target.value));
	document.getElementById('newTileOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('newTileOverlay')) closeNewTileModal();
	});
	document.getElementById('newTileInput').addEventListener('keydown', e => {
		if (e.key === 'Enter') { e.preventDefault(); submitNewTile(); }
	});

	// Mobile hamburger menu toggle
	const navToggle = document.getElementById('navToggle');
	const navMenu = document.getElementById('navMenu');
	if (navToggle && navMenu) {
		const setNavOpen = (open) => {
			navMenu.classList.toggle('hidden', !open);
			navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
			navToggle.textContent = open ? '✕' : '☰';
		};
		navToggle.addEventListener('click', () => {
			setNavOpen(navMenu.classList.contains('hidden'));
		});
		// Collapse the menu after tapping an action button (mobile only).
		// Skip buttons flagged data-keep-menu (e.g. the Today-summary sub-dropdown toggle).
		navMenu.querySelectorAll('button:not([data-keep-menu])').forEach(btn => {
			btn.addEventListener('click', () => {
				if (window.matchMedia('(max-width: 639px)').matches) setNavOpen(false);
			});
		});
	}

	// Today summary dropdown (❓): two options open a popup
	const todaySummaryBtn = document.getElementById('todaySummaryBtn');
	if (todaySummaryBtn) {
		todaySummaryBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleTodaySummaryMenu();
		});
		document.getElementById('todayRemainingBtn').addEventListener('click', () => openTodaySummary('remaining'));
		document.getElementById('todayDoneBtn').addEventListener('click', () => openTodaySummary('done'));
		document.getElementById('closeTodaySummary').addEventListener('click', closeTodaySummary);
		document.getElementById('todaySummaryOverlay').addEventListener('click', e => {
			if (e.target === document.getElementById('todaySummaryOverlay')) closeTodaySummary();
		});
		// Close the dropdown when clicking anywhere outside it
		document.addEventListener('click', (e) => {
			const wrapper = document.getElementById('todaySummaryWrapper');
			if (wrapper && !wrapper.contains(e.target)) toggleTodaySummaryMenu(false);
		});
	}

	// Calendar menu (📆): long-term plan / today's items / today's summary
	document.getElementById('calendarMenuBtn').addEventListener('click', openCalendarMenu);
	document.getElementById('closeCalendarMenu').addEventListener('click', closeCalendarMenu);
	document.getElementById('calendarMenuOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('calendarMenuOverlay')) closeCalendarMenu();
	});
	document.getElementById('longTermPlanBtn').addEventListener('click', () => { closeCalendarMenu(); openCalendarPopup(); });
	document.getElementById('todayItemsBtn').addEventListener('click', () => { closeCalendarMenu(); toggleTodayFilter(); });
	document.getElementById('todaySummaryOpenBtn').addEventListener('click', () => { closeCalendarMenu(); openTodaySummaryCombined(); });

	// Planned-tasks calendar (opened from the calendar menu)
	document.getElementById('closeCalendar').addEventListener('click', closeCalendarPopup);
	document.getElementById('calendarOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('calendarOverlay')) closeCalendarPopup();
	});

	// Filter menu (🔽): relocate the filter pills into the modal
	document.getElementById('filterMenuBtn').addEventListener('click', openFilterMenu);
	document.getElementById('closeFilterMenu').addEventListener('click', closeFilterMenu);
	document.getElementById('filterMenuOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('filterMenuOverlay')) closeFilterMenu();
	});
	const filterMenuList = document.getElementById('filterMenuList');
	['statusFilterBtn', 'tagFilterBtn', 'freqFilterBtn', 'lifecycleFilterBtn', 'moodFilterBtn'].forEach(id => {
		const el = document.getElementById(id);
		if (el && filterMenuList) filterMenuList.appendChild(el);
	});
	// Tag/Mood open their own popups — close the filter menu so they aren't hidden behind it.
	document.getElementById('tagFilterBtn').addEventListener('click', closeFilterMenu);
	document.getElementById('moodFilterBtn').addEventListener('click', closeFilterMenu);
});

// ---- Calendar Popup ----
function openCalendarPopup() {
	const overlay = document.getElementById('calendarOverlay');
	const container = document.getElementById('calendarContainer');
	container.innerHTML = renderOnceTasksCalendar();
	overlay.classList.remove('hidden');

	// Attach click handlers for calendar tile links
	setTimeout(() => {
		container.querySelectorAll('.calendar-tile-link').forEach(link => {
			link.addEventListener('click', function(e) {
				e.preventDefault();
				const tileId = this.getAttribute('data-tile-id');
				openTilePopup(tileId);
			});
		});
		container.querySelectorAll('.cal-complete-btn').forEach(btn => {
			btn.addEventListener('click', () => completeTaskFromCalendar(btn.getAttribute('data-tile-id')));
		});
		container.querySelectorAll('.cal-reschedule-btn').forEach(btn => {
			btn.addEventListener('click', () => rescheduleTaskFromCalendar(btn.getAttribute('data-tile-id'), btn));
		});
		const autoBtn = document.getElementById('autoRescheduleBtn');
		if (autoBtn) autoBtn.addEventListener('click', autoRescheduleCalendar);

		// Row selection: per-row checkboxes + select-all, with a live button label.
		const updateAutoLabel = () => {
			const n = container.querySelectorAll('.cal-select:checked').length;
			const ab = document.getElementById('autoRescheduleBtn');
			if (ab) ab.innerHTML = n ? `🤖 Reschedule ${n} selected` : '🤖 Auto Reschedule';
		};
		container.querySelectorAll('.cal-select').forEach(cb => cb.addEventListener('change', updateAutoLabel));
		const selectAll = document.getElementById('calSelectAll');
		if (selectAll) selectAll.addEventListener('change', () => {
			container.querySelectorAll('.cal-select').forEach(cb => {
				const row = cb.closest('tr');
				if (row && row.style.display !== 'none') cb.checked = selectAll.checked;
			});
			updateAutoLabel();
		});
	}, 0);

		       // Tag filter removed; only text filter and chips remain
		       let selectedTags = []; // Keep for compatibility in filterCalendarRows, but will always be empty

	       // Multi-term filter logic (chips)
	       const filterInput = document.getElementById('calendarFilterInput');
	       const filterChipsContainer = document.getElementById('calendarFilterChips');
	       let filterTerms = [];

	       function renderFilterChips() {
		       filterChipsContainer.innerHTML = '';
		       filterTerms.forEach((term, idx) => {
			       const chip = document.createElement('button');
			       chip.className = 'bg-blue-100 text-blue-700 rounded-full px-3 py-1 text-xs font-semibold mr-1 mb-1 flex items-center';
			       chip.innerHTML = `${term} <span class="ml-1 text-blue-500 cursor-pointer">&times;</span>`;
			       chip.addEventListener('click', () => {
				       filterTerms.splice(idx, 1);
				       renderFilterChips();
				       filterCalendarRows();
			       });
			       filterChipsContainer.appendChild(chip);
		       });
	       }

	       if (filterInput) {
		       filterInput.addEventListener('keydown', function(e) {
			       if (e.key === 'Enter' && filterInput.value.trim()) {
				       const val = filterInput.value.trim().toLowerCase();
				       if (!filterTerms.includes(val)) {
					       filterTerms.push(val);
					       renderFilterChips();
					       filterCalendarRows();
				       }
				       filterInput.value = '';
				       e.preventDefault();
			       }
		       });
	       }

	       function filterCalendarRows() {
		       const rows = container.querySelectorAll('tbody tr');
			       rows.forEach(row => {
				       if (row.classList.contains('cal-month-row')) { row.style.display = filterTerms.length ? 'none' : ''; return; }
				       const date = row.getAttribute('data-date') || '';
				       const shortDate = row.getAttribute('data-shortdate') || '';
				       const tag = row.getAttribute('data-tag') || '';
				       const task = row.getAttribute('data-task') || '';
				       const rowTags = (row.getAttribute('data-tags') || '').split(',');
				       // Tag filter: if 'all' is selected or nothing is selected, show all
				       const tagMatch = (!selectedTags.length || selectedTags.includes('__all__')) || selectedTags.some(t => rowTags.includes(t));
				       // Multi-term AND logic: all filterTerms must match date, shortDate, tag, or task
				       const textMatch = filterTerms.length === 0 || filterTerms.every(term =>
					       date.toLowerCase().includes(term) ||
					       shortDate.includes(term) ||
					       tag.includes(term) ||
					       task.includes(term)
				       );
				       if (tagMatch && textMatch) {
					       row.style.display = '';
				       } else {
					       row.style.display = 'none';
				       }
			       });
	       }

	       // Initial render of chips (empty)
	       renderFilterChips();
}

function closeCalendarPopup() {
	document.getElementById('calendarOverlay').classList.add('hidden');
}

// Mark a planned (once) task as completed straight from the calendar.
async function completeTaskFromCalendar(tileId) {
	const raw = rawTiles[tileId];
	if (!raw) return;
	raw.status = 'completed';
	const dt = tiles.find(t => t.id === tileId);
	if (dt) dt.taskStatus = 'completed';
	await updateTask(tileId, { status: 'completed' });
	applyFilters();
	scheduleReminders();
	openCalendarPopup(); // re-render; completed tasks drop out of the calendar
}

// Reschedule a planned task: pick a new date, update its end_date.
function rescheduleTaskFromCalendar(tileId, btnEl) {
	const raw = rawTiles[tileId];
	if (!raw) return;
	if (!window.flatpickr) {
		const v = prompt('New date (YYYY-MM-DD):', raw.end_date || '');
		if (v && v.trim()) applyReschedule(tileId, v.trim());
		return;
	}
	const input = document.createElement('input');
	input.type = 'text';
	input.style.position = 'fixed';
	input.style.left = '-9999px';
	document.body.appendChild(input);
	let done = false;
	const fp = flatpickr(input, {
		defaultDate: raw.end_date || undefined,
		dateFormat: 'Y-m-d',
		disableMobile: true,
		positionElement: btnEl || undefined,
		onChange: (dates, dateStr) => {
			if (dateStr && !done) {
				done = true;
				applyReschedule(tileId, dateStr);
				try { fp.destroy(); } catch (e) {}
				input.remove();
			}
		},
		onClose: () => {
			setTimeout(() => { if (!done) { try { fp.destroy(); } catch (e) {} input.remove(); } }, 50);
		}
	});
	fp.open();
}

async function applyReschedule(tileId, dateStr) {
	const raw = rawTiles[tileId];
	if (!raw) return;
	raw.end_date = dateStr;
	await updateTask(tileId, { end_date: dateStr });
	applyFilters();
	scheduleReminders();
	openCalendarPopup(); // re-render at the new date
}

// ---- AI Auto-Reschedule ----
// Send the planned (once) tasks to the AI and ask it to spread same-category
// events out over time, then preview the proposal before applying.
let pendingReschedule = [];

function stripFences(s) {
	return String(s || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

function plannedOnceTasks() {
	return Object.values(rawTiles).filter(t => {
		if (t.frequency_mode !== 'once' || !t.end_date) return false;
		const s = (t.status || '').toLowerCase();
		return s !== 'completed' && s !== 'failed' && s !== 'cancelled';
	});
}

async function autoRescheduleCalendar() {
	const onceTasks = plannedOnceTasks();
	// If rows are checked, reschedule only those; otherwise the whole list.
	const selectedIds = Array.from(document.querySelectorAll('.cal-select:checked')).map(c => c.getAttribute('data-tile-id'));
	const hasSelection = selectedIds.length > 0;
	const targetTasks = hasSelection ? onceTasks.filter(t => selectedIds.includes(t.id)) : onceTasks;

	if (!hasSelection && onceTasks.length < 2) {
		alert('Need at least 2 planned tasks to auto-distribute (or tick specific rows to reschedule just those).');
		return;
	}
	if (hasSelection && !targetTasks.length) { alert('No valid tasks selected.'); return; }

	const btn = document.getElementById('autoRescheduleBtn');
	const orig = btn ? btn.innerHTML : '';
	if (btn) { btn.disabled = true; btn.innerHTML = '🤖 Thinking…'; }

	try {
		const { data: { session } } = await supa.auth.getSession();
		if (!session) { alert('Please sign in to use AI auto-reschedule.'); return; }

		const today = todayLocal();
		// Send the full list (so the AI sees existing dates to avoid clustering),
		// flagging which ones to actually move. Overdue/oldest first.
		const list = onceTasks
			.map(t => ({
				id: t.id,
				name: t.name,
				tag: (t.tag_ids && t.tag_ids[0]) ? tagName(t.tag_ids[0]) : '',
				date: t.end_date,
				overdue: t.end_date < today,
				reschedule: hasSelection ? selectedIds.includes(t.id) : true
			}))
			.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

		const scopeRule = hasSelection
			? `Only reschedule events marked "reschedule": true. Leave every other event on its current date — treat those as fixed and use them so the moved events don't land in the same week as a same-tag event.`
			: `Reschedule every event ("reschedule" is true for all of them).`;

		const instruction = `You are a scheduling assistant. Today is ${today}. Below is a JSON list of one-time planned events, each with an id, name, tag (category), current date, an "overdue" flag, and a "reschedule" flag.

${scopeRule}

CRITICAL: Any event you reschedule that is marked "overdue": true has a date in the PAST and MUST be moved to a future date (on or after ${today}). These overdue events are the top priority — none may keep a past date.

When choosing new dates, spread events of the same category/tag out over time instead of clustering them in the same week or month. For example, dining out or social events should land roughly once or twice a month, not all at once. Keep every rescheduled event on or after ${today}, do not invent or drop events, and don't put two same-tag events on the same day. Spread them across enough months that the spacing feels natural and relaxed.

Events:
${JSON.stringify(list)}

Respond with ONLY a JSON object in exactly this shape, listing only the events you moved, no prose:
{"schedule":[{"id":"<id>","date":"YYYY-MM-DD","reason":"<short reason>"}]}`;

		const response = await fetch(`${API_BASE}/api/ai`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${session.access_token}`
			},
			body: JSON.stringify({
				messages: [{ role: 'user', content: instruction }],
				taskContext: '',
				responseFormat: { type: 'json_object' }
			})
		});

		if (!response.ok) {
			const err = await response.json().catch(() => ({}));
			alert(err.error || 'AI request failed. Please try again.');
			return;
		}

		const data = await response.json();
		let parsed;
		try { parsed = JSON.parse(stripFences(data.reply)); }
		catch (e) { alert('The AI returned an unexpected format. Please try again.'); return; }

		const byId = {};
		onceTasks.forEach(t => { byId[t.id] = t; });
		const proposals = (parsed && Array.isArray(parsed.schedule) ? parsed.schedule : [])
			.filter(s => s && byId[s.id] && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date >= today)
			.filter(s => !hasSelection || selectedIds.includes(s.id)) // never touch unselected rows
			.map(s => ({ id: s.id, name: byId[s.id].name, from: byId[s.id].end_date, to: s.date, reason: s.reason || '', overdue: byId[s.id].end_date < today }))
			.filter(p => p.from !== p.to);

		if (!proposals.length) { alert('The AI did not suggest any changes — your schedule already looks well spread out.'); return; }

		// Overdue tasks (within the rescheduled set) the AI failed to move forward.
		const movedIds = new Set(proposals.map(p => p.id));
		const missedOverdue = targetTasks.filter(t => t.end_date < today && !movedIds.has(t.id)).length;
		renderReschedulePreview(proposals, missedOverdue);
	} catch (e) {
		console.error('auto reschedule error:', e);
		alert('Something went wrong with auto-reschedule.');
	} finally {
		if (btn) { btn.disabled = false; btn.innerHTML = orig; }
	}
}

function renderReschedulePreview(proposals, missedOverdue) {
	// Order the preview by the new date so it reads as a timeline (old → new).
	// 'YYYY-MM-DD' strings sort chronologically as plain text.
	proposals = proposals.slice().sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
	pendingReschedule = proposals;
	const container = document.getElementById('calendarContainer');
	// e.g. "28 Jun '26 Tue"
	const fmt = ds => {
		const d = new Date(ds + 'T00:00:00');
		const yy = String(d.getFullYear()).slice(-2);
		return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: 'short' })} '${yy} ${d.toLocaleDateString(undefined, { weekday: 'short' })}`;
	};
	const overdueCount = proposals.filter(p => p.overdue).length;
	const rows = proposals.map(p => `<tr>
		<td class="border px-3 py-2">${p.overdue ? '<span class="text-xs font-semibold text-red-500 mr-1">⚠️</span>' : ''}${escapeHtml(p.name)}</td>
		<td class="border px-3 py-2 whitespace-nowrap line-through ${p.overdue ? 'text-red-400' : 'text-slate-400'}">${fmt(p.from)}</td>
		<td class="border px-3 py-2 whitespace-nowrap font-semibold text-blue-700">${fmt(p.to)}</td>
		<td class="border px-3 py-2 text-xs text-slate-500">${escapeHtml(p.reason)}</td>
	</tr>`).join('');
	const warn = missedOverdue ? `<div class="mb-2 text-xs text-red-500">⚠️ ${missedOverdue} overdue task(s) were not moved — try again to reschedule them.</div>` : '';
	container.innerHTML = `
		<div class="mb-1 text-sm text-slate-600">🤖 Proposed new dates for <b>${proposals.length}</b> task(s)${overdueCount ? ` — including <b class="text-red-500">${overdueCount} overdue</b>` : ''}. Review, then apply.</div>
		${warn}
		<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead><tr>
			<th class="px-3 py-2 text-left">Task</th>
			<th class="px-3 py-2 text-left">From</th>
			<th class="px-3 py-2 text-left">To</th>
			<th class="px-3 py-2 text-left">Why</th>
		</tr></thead><tbody>${rows}</tbody></table></div>
		<div class="flex gap-2 justify-end mt-4">
			<button id="cancelRescheduleBtn" class="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm font-semibold transition">Cancel</button>
			<button id="applyRescheduleBtn" class="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 text-white text-sm font-semibold shadow-md hover:-translate-y-0.5 transition-all">✅ Apply all</button>
		</div>`;
	document.getElementById('cancelRescheduleBtn').addEventListener('click', () => { pendingReschedule = []; openCalendarPopup(); });
	document.getElementById('applyRescheduleBtn').addEventListener('click', applyAllReschedules);
}

async function applyAllReschedules() {
	const btn = document.getElementById('applyRescheduleBtn');
	if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
	for (const p of pendingReschedule) {
		const raw = rawTiles[p.id];
		if (!raw) continue;
		raw.end_date = p.to;
		await updateTask(p.id, { end_date: p.to });
	}
	pendingReschedule = [];
	applyFilters();
	scheduleReminders();
	openCalendarPopup();
}

function renderOnceTasksCalendar() {
	// Gather all once-frequency tasks with end_date, EXCLUDING those with status completed, failed, or cancelled
	const onceTasks = Object.values(rawTiles).filter(t => {
		if (t.frequency_mode !== 'once' || !t.end_date) return false;
		const status = (t.status || '').toLowerCase();
		return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
	});
	if (onceTasks.length === 0) {
		return '<div class="text-center text-slate-400 py-8">No once-frequency tasks found.</div>';
	}


	// Gather all unique tags from once-tasks
	const tagSet = new Set();
	onceTasks.forEach(t => (t.tag_ids || []).forEach(id => tagSet.add(tagName(id))));
	const tagList = Array.from(tagSet).sort();

	// Filtering UI: tag multi-select and text input
			let html = `<div class="mb-4 flex flex-wrap items-center gap-2">
			       <div id="calendarFilterChips" class="flex flex-wrap gap-1 w-full"></div>
			       <div class="flex items-center gap-2 w-full justify-between flex-wrap">
				       <input id="calendarFilterInput" type="text" class="rounded-xl border p-2 w-full sm:w-64"
				   placeholder="Filter by task, tag, or date..." />
				       <button id="autoRescheduleBtn" title="Let AI spread your planned tasks out sensibly" class="px-3.5 py-2 rounded-full text-sm font-semibold text-white bg-gradient-to-r from-purple-500 to-fuchsia-500 shadow-md shadow-purple-500/30 hover:-translate-y-0.5 hover:shadow-lg transition-all whitespace-nowrap">🤖 Auto Reschedule</button>
			       </div>
			</div>`;

	// Build a map: date string -> array of tasks
	const dateMap = {};
	onceTasks.forEach(task => {
		if (!dateMap[task.end_date]) dateMap[task.end_date] = [];
		dateMap[task.end_date].push(task);
	});
	// Get all unique dates, sorted
	const allDates = Object.keys(dateMap).sort();
	// Render a table calendar grouped by month, with a select checkbox per row.
	html += '<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead><tr>'
		+ '<th class="px-3 py-2 text-left"><input type="checkbox" id="calSelectAll" title="Select all" /></th>'
		+ '<th class="px-3 py-2 text-left">Date</th><th class="px-4 py-2 text-left">Task</th><th class="px-3 py-2 text-left">Actions</th>'
		+ '</tr></thead><tbody>';
	let currentMonthKey = '';
	allDates.forEach(date => {
		const dObj = new Date(date + 'T00:00:00');
		const monthKey = `${dObj.getFullYear()}-${dObj.getMonth()}`;
		if (monthKey !== currentMonthKey) {
			currentMonthKey = monthKey;
			const monthLabel = dObj.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
			html += `<tr class="cal-month-row"><td colspan="4" class="bg-slate-100 font-bold text-slate-700 px-4 py-2">${monthLabel}</td></tr>`;
		}
		dateMap[date].forEach(t => {
			const tagId = (t.tag_ids && t.tag_ids.length > 0) ? t.tag_ids[0] : '';
			const tagLabel = tagId ? tagName(tagId) : '';
			const desc = escapeHtml(t.name);
			// Add all tags for multi-select filter
			const allTags = (t.tag_ids || []).map(tagName).join(',');
			// Compute weekday name
			const d = new Date(date + 'T00:00:00');
			const dayName = d.toLocaleDateString(undefined, { weekday: 'short' });
			// Format date as DD-MM
			const day = String(d.getDate()).padStart(2, '0');
			const month = String(d.getMonth() + 1).padStart(2, '0');
			const shortDate = `${day}-${month}`;
				   html += `<tr data-date="${date}" data-shortdate="${shortDate}" data-tag="${escapeHtml(tagLabel).toLowerCase()}" data-task="${desc.toLowerCase()}" data-tags="${escapeHtml(allTags)}"><td class="border px-3 py-2 text-center"><input type="checkbox" class="cal-select" data-tile-id="${t.id}" /></td><td class="border px-3 py-2 whitespace-nowrap"><div class="font-semibold">${shortDate}</div><div class="text-[11px] text-slate-400">${dayName}</div></td><td class="border px-4 py-2"><a href="#" class="calendar-tile-link text-blue-600 underline hover:text-blue-800" data-tile-id="${t.id}">${desc}</a></td><td class="border px-4 py-2 whitespace-nowrap"><button class="cal-complete-btn text-base px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 transition mr-1" data-tile-id="${t.id}" title="Mark completed" aria-label="Mark completed">✅</button><button class="cal-reschedule-btn text-base px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition" data-tile-id="${t.id}" title="Reschedule" aria-label="Reschedule">📅</button></td></tr>`;
		});
	});
	html += '</tbody></table></div>';
	return html;
}
