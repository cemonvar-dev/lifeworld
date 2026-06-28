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
let ALL_TAGS = [];        // [{ key: tagId, label: name }] for legacy call sites
let TAGS = [];            // rows from public.tags: { id, name, parent_id, sort_order }
let TAGS_BY_ID = {};      // id -> tag row
let tagManageMode = false; // tag filter popup: manage (reorder/parent/delete) vs filter
let refreshTagTree = null; // re-renders just the tag tree in place (preserves scroll/search)
let currentUserId = null;

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
			// Expect once per month — check if it's the 1st or same day-of-month as start
			const startDay = startDate.getDate();
			isExpected = d.getDate() === startDay;
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
	renderGallery(tiles);
	scheduleReminders();
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
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
		const startDate = raw.created_at ? new Date(raw.created_at) : today;
		const targetDay = startDate.getDate();
		let next = new Date(today.getFullYear(), today.getMonth(), targetDay);
		if (next < today) next.setMonth(next.getMonth() + 1);
		const diff = Math.round((next - today) / 86400000);
		if (diff === 0) return 'today';
		if (diff === 1) return 'tomorrow';
		if (diff <= 7) return `in ${diff} days`;
		return next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
			const tileColor = tile.healthColor || 'bg-white';
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
					   <div class="text-3xl text-right w-1/4">${tile.emoji}</div>
				   </div>
				   <div class="flex gap-2 mt-1">
					   <span class="text-xs ${tile.status === 'noaction' ? 'text-amber-500 font-semibold' : 'text-slate-500'}">${tile.status === 'noaction' ? 'take action now' : tile.status}</span>
					   <span class="text-xs text-slate-500">(${tile.count})</span>
				   </div>
				   <div class="text-xs font-medium ${tile.health >= 60 ? 'text-green-600' : tile.health >= 40 ? 'text-yellow-600' : 'text-red-500'}">${tile.health}% ${tile.healthLabel}</div>
				   <div class="flex justify-between items-center w-full mt-1">
					   <span class="text-xs text-slate-400">📌 ${createdAt}</span>
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
	const timeOfDayArr = (typeof raw.time_of_day === 'string' && raw.time_of_day) ? raw.time_of_day.split(',').filter(Boolean) : [];
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
			<span class="text-4xl">${plant.emoji}</span>
			<div>
				<div class="text-xl font-bold">
					<input id="tileNameInput" type="text" value="${String(raw.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}" class="border-b border-slate-300 focus:border-blue-400 outline-none bg-transparent font-bold text-xl w-full" style="min-width:80px;max-width:100%;" autocomplete="off" />
				</div>

					
				<div class="text-sm text-slate-500">${statusLabel}</div>
				<div class="text-xs text-slate-400">${lastUpdateStr}</div>
			</div>
		</div>
		<hr class="my-5 border-slate-200">
		<div class="mb-2 text-sm font-semibold">Tags</div>
		${tagDropdownHtml}
		<div class="mb-2 text-sm font-semibold">Frequency</div>
		<div id="freqBtns" class="flex flex-wrap gap-2 mb-3">
			${['daily', 'weekly', 'once', 'monthly'].map(f => `<button class='freq-btn px-3 py-1 rounded-full text-xs border transition ${freqMode === f ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-freq='${f}'>${f}</button>`).join('')}
		</div>
		<div id="weeklyDays" class="flex flex-wrap gap-1 mb-3" style="display:${freqMode === 'weekly' ? 'flex' : 'none'}">
			${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<button class='day-btn px-2 py-1 rounded-full text-xs border transition ${freqDays.includes(String(i)) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-day='${i}'>${d}</button>`).join('')}
		</div>
		<div id="onceDatePicker" class="mb-8" style="display:${freqMode === 'once' ? 'block' : 'none'}">
			<label class="text-xs text-slate-500">Date</label>
			<input type="date" id="onceDateInput" class="ml-2 rounded-lg border px-2 py-1 text-sm" value="${raw.end_date || ''}" />
		</div>
		<div class="mb-2 text-sm font-semibold">Time of Day</div>
		<div id="todBtns" class="flex flex-wrap gap-2 mb-8">
			${[{ key: 'morning', label: '🌅 Morning' }, { key: 'afternoon', label: '☀️ Afternoon' }, { key: 'evening', label: '🌇 Evening' }, { key: 'night', label: '🌙 Night' }].map(t => `<button class='tod-btn px-3 py-1 rounded-full text-xs border transition ${timeOfDayArr.includes(t.key) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-tod='${t.key}'>${t.label}</button>`).join('')}
		</div>
		<hr class="my-5 border-slate-200">
		<div class="mb-2 text-sm font-semibold">Lifecycle Status</div>
		<div id="lifecycleBtns" class="flex flex-wrap gap-2 mb-8">
			   ${[
				   { key: 'active', label: '🔥 Active', bg: 'bg-orange-100 text-orange-700 border-orange-300' },
				   { key: 'planned', label: '📋 Planned', bg: 'bg-blue-100 text-blue-700 border-blue-300' },
				   { key: 'in progress', label: '🔄 In Progress', bg: 'bg-green-100 text-green-700 border-green-300' },
				   { key: 'completed', label: '✅ Completed', bg: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
				   { key: 'failed', label: '❌ Failed', bg: 'bg-red-100 text-red-700 border-red-300' },
				   { key: 'cancelled', label: '🚫 Cancelled', bg: 'bg-slate-100 text-slate-600 border-slate-300' }
			   ].map(s => `<button class='lifecycle-btn px-3 py-1 rounded-full text-xs border transition ${(raw.status || 'in progress') === s.key ? s.bg + " font-bold ring-2 ring-offset-1 ring-slate-400" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"}' data-lifecycle='${s.key}'>${s.label}</button>`).join('')}
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

	document.addEventListener('click', e => {
		if (!tagDropdownBtn.contains(e.target) && !tagDropdownMenu.contains(e.target)) {
			tagDropdownMenu.style.display = 'none';
		}
	});

	tagDropdownSearch.addEventListener('input', e => {
		renderTagOptions(tagDropdownSearch.value);
	});

	renderTagOptions();

	// Keyboard navigation: close on Escape
	tagDropdownSearch.addEventListener('keydown', e => {
		if (e.key === 'Escape') tagDropdownMenu.style.display = 'none';
	});

	// End multiselect dropdown logic

	// Wire up frequency buttons
	document.querySelectorAll('.freq-btn').forEach(btn => {
		btn.addEventListener('click', e => { e.stopPropagation(); setFrequency(btn.dataset.freq); });
	});

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

	// Wire up time-of-day buttons
	document.querySelectorAll('.tod-btn').forEach(btn => {
		btn.addEventListener('click', e => { e.stopPropagation(); toggleTimeOfDay(btn.dataset.tod); });
	});

	// Wire up delete tile button
	document.getElementById('deleteTileBtn').addEventListener('click', deleteTile);

	// Wire up lifecycle buttons
	document.querySelectorAll('.lifecycle-btn').forEach(btn => {
		btn.addEventListener('click', async e => {
			e.stopPropagation();
			const newStatus = btn.dataset.lifecycle;
			raw.status = newStatus;
			const displayTile = tiles.find(t => t.id === tileId);
			if (displayTile) displayTile.taskStatus = newStatus;
			openTilePopup(tileId);
			await updateTask(tileId, { status: newStatus });
		});
	});

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

// ---- Local notifications / reminders (native app only) ----
const REMINDER_TIMES = {
	morning: { hour: 8, minute: 0 },
	afternoon: { hour: 13, minute: 0 },
	evening: { hour: 18, minute: 0 },
	night: { hour: 21, minute: 0 }
};

// Rebuild all device reminders from the current cards. The OS fires them even
// when the app is closed; we re-sync on app open and after schedule edits.
async function scheduleReminders() {
	const cap = window.Capacitor;
	const LN = cap && cap.Plugins && cap.Plugins.LocalNotifications;
	if (!LN || !(cap.isNativePlatform && cap.isNativePlatform())) return; // native only
	try {
		let perm = await LN.checkPermissions();
		if (perm.display !== 'granted') perm = await LN.requestPermissions();
		if (perm.display !== 'granted') return;

		try { await LN.createChannel({ id: 'reminders', name: 'Reminders', importance: 4, visibility: 1 }); } catch (e) {}

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
			const buckets = (typeof task.time_of_day === 'string' && task.time_of_day)
				? task.time_of_day.split(',').map(s => s.trim()).filter(Boolean)
				: ['morning']; // no time set -> morning
			const base = { title: `⏰ ${task.name}`, body: 'Time to take action.', channelId: 'reminders' };

			buckets.forEach(bucket => {
				const t = REMINDER_TIMES[bucket] || REMINDER_TIMES.morning;
				if (mode === 'daily') {
					notifications.push({ id: id++, ...base, schedule: { on: { hour: t.hour, minute: t.minute }, repeats: true, allowWhileIdle: true } });
				} else if (mode === 'weekly') {
					(task.task_frequency_days || []).forEach(d => {
						notifications.push({ id: id++, ...base, schedule: { on: { weekday: d.day_of_week + 1, hour: t.hour, minute: t.minute }, repeats: true, allowWhileIdle: true } });
					});
				} else if (mode === 'monthly') {
					const dom = task.created_at ? new Date(task.created_at).getDate() : 1;
					notifications.push({ id: id++, ...base, schedule: { on: { day: dom, hour: t.hour, minute: t.minute }, repeats: true, allowWhileIdle: true } });
				} else if (mode === 'once' && task.end_date) {
					const when = new Date(task.end_date + 'T00:00:00');
					when.setHours(t.hour, t.minute, 0, 0);
					if (when > now) notifications.push({ id: id++, ...base, schedule: { at: when, allowWhileIdle: true } });
				}
			});
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

// ---- Time of Day Operations ----
async function toggleTimeOfDay(tod) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	let todArr = raw.time_of_day ? raw.time_of_day.split(',').filter(Boolean) : [];
	const idx = todArr.indexOf(tod);
	if (idx >= 0) {
		todArr.splice(idx, 1);
	} else {
		todArr.push(tod);
	}
	raw.time_of_day = todArr.join(',');
	openTilePopup(activeTileId);
	await updateTask(activeTileId, { time_of_day: raw.time_of_day });
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

// ---- Add New Tile ----
async function addNewTile() {
	const name = prompt('Enter tile name:');
	if (!name || !name.trim()) return;
	if (!currentUserId) return;

	const { data, error } = await supa
		.from('tasks')
		.insert({
			user_id: currentUserId,
			name: name.trim(),
			frequency_mode: 'daily'
		})
		.select('*, task_logs(*), task_frequency_days(*)')
		.single();

	if (error || !data) {
		console.error('Add error:', error);
		alert('Failed to add tile: ' + (error?.message || 'unknown error'));
		return;
	}

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
			`<span class="flex items-center gap-1 shrink-0">${moodChipsHtml(tagMoods[tagObj.key] || {})}</span>` +
			`<span class="text-[11px] font-semibold text-slate-400 tabular-nums w-7 text-right shrink-0">${tagCounts[tagObj.key] || 0}</span>`;
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
	if (activeTimelineFilter === 'today') {
		btn.classList.remove('bg-white');
		btn.classList.add('bg-blue-100', 'border-blue-400', 'text-blue-700');
	} else {
		btn.classList.remove('bg-blue-100', 'border-blue-400', 'text-blue-700');
		btn.classList.add('bg-white');
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
		filtered = filtered.filter(t => (t.tags || []).includes(activeTagFilter));
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

// ---- Reset Today's Logs ----
async function resetTodayLogs() {
	if (!confirm('Reset all done/skip flags for today?')) return;
	const today = todayLocal();
	// Find today's done/skip logs across all tiles
	const logIdsToReset = [];
	Object.values(rawTiles).forEach(raw => {
		(raw.task_logs || []).forEach(log => {
			const logDate = logDay(log);
			if (logDate === today && (log.status === 'done' || log.status === 'skipped' || log.status === 'completed')) {
				logIdsToReset.push(log.id);
			}
		});
	});
	if (logIdsToReset.length === 0) {
		alert('Nothing to reset — no done/skipped logs for today.');
		return;
	}
	// Delete today's logs from DB
	const { error } = await supa.from('task_logs').delete().in('id', logIdsToReset);
	if (error) { console.error('Reset error:', error); return; }
	// Remove from local data
	Object.values(rawTiles).forEach(raw => {
		raw.task_logs = (raw.task_logs || []).filter(log => !logIdsToReset.includes(log.id));
	});
	// Rebuild display tiles
	tiles = Object.values(rawTiles).map(task => {
		const logs = task.task_logs || [];
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
			   lastUpdate: lastLog ? (lastLog.log_date || lastLog.created_at) : null
		};
	});
	applyFilters();
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

		return `• "${task.name}" | tags: [${(task.tag_ids || []).map(tagName).join(', ')}] | freq: ${task.frequency_mode} | lifecycle: ${task.status || 'in progress'} | health: ${health}% (${plant.label}) | total logs: ${logs.length} | today: ${todayLog ? todayLog.status : 'no action'} | recent: ${recentLogs || 'none'}`;
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
		   // Try to parse as a command from the AI
		   let handled = false;
		   try {
			   const cmd = JSON.parse(reply);
			   if (cmd.action === 'create_tile' && cmd.name) {
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
	fetchTilesFromSupabase();

	document.getElementById('searchBox').addEventListener('input', () => applyFilters());
	document.getElementById('tagFilterBtn').addEventListener('click', openTagFilterPopup);
	document.getElementById('closeTagFilter').addEventListener('click', closeTagFilterPopup);
	document.getElementById('tagFilterOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('tagFilterOverlay')) closeTagFilterPopup();
	});
	document.getElementById('clearFilterBtn').addEventListener('click', () => setTagFilter(null));
	document.getElementById('todayFilterBtn').addEventListener('click', toggleTodayFilter);
	document.getElementById('statusFilterBtn').addEventListener('click', toggleStatusFilter);
	document.getElementById('resetBtn').addEventListener('click', resetTodayLogs);
	document.getElementById('lifecycleFilterBtn').addEventListener('click', toggleLifecycleFilter);
	document.getElementById('moodFilterBtn').addEventListener('click', openMoodFilterPopup);
	document.getElementById('closeMoodFilter').addEventListener('click', closeMoodFilterPopup);
	document.getElementById('moodFilterOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('moodFilterOverlay')) closeMoodFilterPopup();
	});
	document.getElementById('addTileBtn').addEventListener('click', addNewTile);

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

	// Calendar button logic
	document.getElementById('calendarBtn').addEventListener('click', openCalendarPopup);
	document.getElementById('closeCalendar').addEventListener('click', closeCalendarPopup);
	document.getElementById('calendarOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('calendarOverlay')) closeCalendarPopup();
	});

	// Set filter and click the Today button on load
	activeTimelineFilter = 'today';
	document.getElementById('todayFilterBtn').click();
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
			       <div class="flex items-center gap-2 w-full sm:w-auto">
				       <input id="calendarFilterInput" type="text" class="rounded-xl border p-2 w-full sm:w-64" style="margin-bottom:24px;" 
				   placeholder="Filter by task, tag, or date..." />
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
	// Render a simple table calendar (list style for now)
	html += '<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead><tr><th class="px-4 py-2 text-left">Date</th><th class="px-4 py-2 text-left">Day</th><th class="px-4 py-2 text-left">Tag</th><th class="px-4 py-2 text-left">Task</th><th class="px-4 py-2 text-left">Actions</th></tr></thead><tbody>';
	allDates.forEach(date => {
		dateMap[date].forEach(t => {
			const tagId = (t.tag_ids && t.tag_ids.length > 0) ? t.tag_ids[0] : '';
			const tagLabel = tagId ? tagName(tagId) : '';
			const desc = escapeHtml(t.name);
			// Add all tags for multi-select filter
			const allTags = (t.tag_ids || []).map(tagName).join(',');
			// Compute weekday name
			const d = new Date(date + 'T00:00:00');
			const dayName = d.toLocaleDateString(undefined, { weekday: 'long' });
			// Format date as DD-MM
			const day = String(d.getDate()).padStart(2, '0');
			const month = String(d.getMonth() + 1).padStart(2, '0');
			const shortDate = `${day}-${month}`;
				   html += `<tr data-date="${date}" data-shortdate="${shortDate}" data-tag="${escapeHtml(tagLabel).toLowerCase()}" data-task="${desc.toLowerCase()}" data-tags="${escapeHtml(allTags)}"><td class="border px-4 py-2 whitespace-nowrap font-semibold">${shortDate}</td><td class="border px-4 py-2 whitespace-nowrap">${dayName}</td><td class="border px-4 py-2">${escapeHtml(tagLabel)}</td><td class="border px-4 py-2"><a href="#" class="calendar-tile-link text-blue-600 underline hover:text-blue-800" data-tile-id="${t.id}">${desc}</a></td><td class="border px-4 py-2 whitespace-nowrap"><button class="cal-complete-btn text-xs px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 transition mr-1" data-tile-id="${t.id}">✅ Completed</button><button class="cal-reschedule-btn text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition" data-tile-id="${t.id}">📅 Reschedule</button></td></tr>`;
		});
	});
	html += '</tbody></table></div>';
	return html;
}
