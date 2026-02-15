let tiles = [];
let rawTiles = {}; // full task objects keyed by uuid
let activeTileId = null; // currently open tile
let activeTagFilter = null; // currently active tag filter
let activeTimelineFilter = null; // 'today' or null
let activeStatusFilter = null; // null, 'done', 'skipped', 'noaction'
let activeLifecycleFilter = 'active'; // 'active' (planned+in progress), 'all', 'completed', 'failed', 'cancelled'
let ALL_TAGS = []; // dynamically built from tile data
let currentUserId = null;

function buildTagsFromTiles() {
	const tagSet = new Set();
	Object.values(rawTiles).forEach(t => {
		(t.tags || []).forEach(tag => tagSet.add(tag));
	});
	ALL_TAGS = Array.from(tagSet).sort().map(key => ({
		key,
		label: key.charAt(0).toUpperCase() + key.slice(1)
	}));
}

// ---- Health Score ----
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
		const d = log.created_at ? log.created_at.split('T')[0] : '';
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
	if (score >= 80) return { emoji: '🌳', label: 'Thriving', color: 'bg-green-50 border-green-200' };
	if (score >= 60) return { emoji: '🌿', label: 'Healthy', color: 'bg-emerald-50 border-emerald-200' };
	if (score >= 40) return { emoji: '🌱', label: 'Growing', color: 'bg-yellow-50 border-yellow-200' };
	if (score >= 20) return { emoji: '🥀', label: 'Wilting', color: 'bg-orange-50 border-orange-200' };
	return { emoji: '🍂', label: 'Dying', color: 'bg-red-50 border-red-200' };
}

// ---- Data Fetching ----
function getTodayStatus(logs) {
	const today = new Date().toISOString().split('T')[0];
	const todayLog = (logs || []).find(l => l.created_at && l.created_at.split('T')[0] === today && (l.status === 'done' || l.status === 'skipped' || l.status === 'completed'));
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
		// Sort logs newest first
		if (task.task_logs) {
			task.task_logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		}
		rawTiles[task.id] = task;
	});

	tiles = data.map(task => {
		const logs = task.task_logs || [];
		const lastLog = logs[0];
		const health = calculateHealth(task);
		const plant = healthToPlant(health);
		return {
			id: task.id,
			name: task.name,
			tags: task.tags || [],
			status: getTodayStatus(logs),
			taskStatus: task.status || 'in progress',
			emoji: plant.emoji,
			health,
			healthLabel: plant.label,
			healthColor: plant.color,
			count: logs.length,
			createdAt: task.created_at || null,
			lastUpdate: lastLog ? lastLog.created_at : null
		};
	});

	buildTagsFromTiles();
	renderGallery(tiles);
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

	Object.keys(groups).sort().forEach(tag => {
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
		heading.textContent = tag;
		groupSection.appendChild(heading);

		const groupGrid = document.createElement('div');
		groupGrid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4';
		groupGrid.dataset.tagGroup = tag;
		groups[tag].forEach(tile => {
			const tileDiv = document.createElement("div");
			const tileColor = tile.healthColor || 'bg-white';
			tileDiv.className = `tile ${tileColor} rounded-xl shadow border p-4 flex flex-col items-center justify-between gap-2 hover:shadow-lg transition cursor-pointer`;
			tileDiv.draggable = true;
			tileDiv.dataset.tileId = tile.id;
			const lastUpd = tile.lastUpdate ? new Date(tile.lastUpdate).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
			const createdAt = tile.createdAt ? new Date(tile.createdAt).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
			const nextDue = getNextDueLabel(tile.id);
			const nextDueClass = nextDue === 'today' ? 'text-blue-500 font-semibold' : nextDue === 'tomorrow' ? 'text-indigo-400' : nextDue === 'overdue' ? 'text-red-500 font-semibold' : 'text-slate-400';
			tileDiv.innerHTML = `
				<div class="text-3xl">${tile.emoji}</div>
				<div class="font-semibold text-center truncate w-full">${tile.name}</div>
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
				if (draggedId && draggedId !== tile.id) {
					handleTileDrop(draggedId, tile.id, tag);
				}
			});

			tileDiv.addEventListener('click', (e) => {
				if (e.target.closest('.quick-done') || e.target.closest('.quick-skip')) return;
				openTilePopup(tile.id);
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
	const lastUpdateStr = lastLog ? 'Last update: ' + new Date(lastLog.created_at).toLocaleDateString() : '';

	const freqMode = raw.frequency_mode || 'daily';
	const timeOfDayArr = (typeof raw.time_of_day === 'string' && raw.time_of_day) ? raw.time_of_day.split(',').filter(Boolean) : [];
	const currentTags = raw.tags || [];
	const freqDays = (raw.task_frequency_days || []).map(d => String(d.day_of_week));

	// Build logs timeline
	let timelineHtml = '';
	if (logs.length === 0) {
		timelineHtml = '<div class="text-slate-400 text-sm py-4">No logs yet.</div>';
	} else {
		timelineHtml = '<div class="relative pl-6 border-l-2 border-slate-200 mt-2">';
		logs.forEach(log => {
			const d = new Date(log.created_at);
			const dateStr = d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
			const timeStr = d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
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
					<div class="text-xs text-slate-400">${dateStr} · ${timeStr}</div>
					${noteHtml}
				</div>`;
		});
		timelineHtml += '</div>';
	}

	// Build tag chips
	const tagChipsHtml = currentTags.map(t => {
		const info = ALL_TAGS.find(at => at.key === t);
		const label = info ? info.label : t;
		return `<span class='inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-200 text-xs'>${label}<button class='remove-tag ml-1 text-slate-400 hover:text-red-500 font-bold' data-tag='${t}'>&times;</button></span>`;
	}).join(' ');

	// Build preset tag buttons
	const presetTagsHtml = ALL_TAGS.map(at => {
		const active = currentTags.includes(at.key);
		return `<button class='preset-tag px-2 py-1 rounded-full text-xs border transition ${active ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-tag='${at.key}'>${at.label}</button>`;
	}).join('');

	popupBody.innerHTML = `
		<div class="flex items-center gap-3 mb-4">
			<span class="text-4xl">${plant.emoji}</span>
			<div>
				<div class="text-xl font-bold">${raw.name}</div>
				<div class="text-sm text-slate-500">${statusLabel}</div>
				<div class="text-xs text-slate-400">${lastUpdateStr}</div>
			</div>
		</div>
		<hr class="my-5 border-slate-200">
		<div class="mb-2 text-sm font-semibold">Tags</div>
		<div id="tagChips" class="flex flex-wrap gap-2 mb-3">${tagChipsHtml || '<span class="text-slate-400 text-xs">No tags</span>'}</div>
		<div id="presetTags" class="flex flex-wrap gap-2 mb-8">${presetTagsHtml}</div>
		<div class="mb-2 text-sm font-semibold">Frequency</div>
		<div id="freqBtns" class="flex flex-wrap gap-2 mb-3">
			${['daily','weekly','once','monthly'].map(f => `<button class='freq-btn px-3 py-1 rounded-full text-xs border transition ${freqMode === f ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-freq='${f}'>${f}</button>`).join('')}
		</div>
		<div id="weeklyDays" class="flex flex-wrap gap-1 mb-3" style="display:${freqMode === 'weekly' ? 'flex' : 'none'}">
			${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i) => `<button class='day-btn px-2 py-1 rounded-full text-xs border transition ${freqDays.includes(String(i)) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-day='${i}'>${d}</button>`).join('')}
		</div>
		<div id="onceDatePicker" class="mb-8" style="display:${freqMode === 'once' ? 'block' : 'none'}">
			<label class="text-xs text-slate-500">Date</label>
			<input type="date" id="onceDateInput" class="ml-2 rounded-lg border px-2 py-1 text-sm" value="${raw.end_date || ''}" />
		</div>
		<div class="mb-2 text-sm font-semibold">Time of Day</div>
		<div id="todBtns" class="flex flex-wrap gap-2 mb-8">
			${[{key:'morning',label:'🌅 Morning'},{key:'afternoon',label:'☀️ Afternoon'},{key:'evening',label:'🌇 Evening'},{key:'night',label:'🌙 Night'}].map(t => `<button class='tod-btn px-3 py-1 rounded-full text-xs border transition ${timeOfDayArr.includes(t.key) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-tod='${t.key}'>${t.label}</button>`).join('')}
		</div>
		<hr class="my-5 border-slate-200">
		<div class="mb-2 text-sm font-semibold">Lifecycle Status</div>
		<div id="lifecycleBtns" class="flex flex-wrap gap-2 mb-8">
			${[{key:'planned',label:'📋 Planned',bg:'bg-blue-100 text-blue-700 border-blue-300'},{key:'in progress',label:'🔄 In Progress',bg:'bg-green-100 text-green-700 border-green-300'},{key:'completed',label:'✅ Completed',bg:'bg-emerald-100 text-emerald-700 border-emerald-300'},{key:'failed',label:'❌ Failed',bg:'bg-red-100 text-red-700 border-red-300'},{key:'cancelled',label:'🚫 Cancelled',bg:'bg-slate-100 text-slate-600 border-slate-300'}].map(s => `<button class='lifecycle-btn px-3 py-1 rounded-full text-xs border transition ${(raw.status || 'in progress') === s.key ? s.bg + " font-bold ring-2 ring-offset-1 ring-slate-400" : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"}' data-lifecycle='${s.key}'>${s.label}</button>`).join('')}
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

	// Wire up tag interactions
	document.querySelectorAll('.remove-tag').forEach(btn => {
		btn.addEventListener('click', e => { e.stopPropagation(); toggleTag(btn.dataset.tag); });
	});
	document.querySelectorAll('.preset-tag').forEach(btn => {
		btn.addEventListener('click', e => { e.stopPropagation(); toggleTag(btn.dataset.tag); });
	});

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

function openAddLogPopup(logToEdit) {
	const overlay = document.getElementById('addLogOverlay');
	const submitBtn = document.getElementById('submitLogBtn');
	if (logToEdit) {
		// Edit mode
		editingLogId = logToEdit.id;
		const logDate = logToEdit.created_at ? logToEdit.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
		document.getElementById('logDateInput').value = logDate;
		document.getElementById('logNoteInput').value = logToEdit.note || '';
		addLogStatus = logToEdit.status || 'done';
		document.querySelector('#addLogOverlay .text-lg.font-bold').textContent = 'Edit Log';
		submitBtn.textContent = '💾 Update Log';
	} else {
		// Add mode
		editingLogId = null;
		const today = new Date().toISOString().split('T')[0];
		document.getElementById('logDateInput').value = today;
		document.getElementById('logNoteInput').value = '';
		addLogStatus = 'done';
		document.querySelector('#addLogOverlay .text-lg.font-bold').textContent = 'Add Log';
		submitBtn.textContent = '➕ Add Log';
	}
	updateLogStatusBtns();
	overlay.classList.remove('hidden');
}

function closeAddLogPopup() {
	editingLogId = null;
	document.getElementById('addLogOverlay').classList.add('hidden');
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

async function submitLog() {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;

	const logDate = document.getElementById('logDateInput').value;
	const note = document.getElementById('logNoteInput').value.trim();
	if (!logDate) { alert('Please select a date.'); return; }

	if (editingLogId) {
		// --- Edit mode ---
		const updateObj = { status: addLogStatus, log_date: logDate, note: note || null };
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
			raw.task_logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		}
		editingLogId = null;
	} else {
		// --- Add mode ---
		const insertObj = { task_id: activeTileId, status: addLogStatus, log_date: logDate };
		if (note) insertObj.note = note;

		const { data, error } = await supa
			.from('task_logs')
			.insert(insertObj)
			.select()
			.single();

		if (error) { console.error('Add log error:', error); alert('Failed to add log: ' + error.message); return; }

		if (data) {
			raw.task_logs = raw.task_logs || [];
			raw.task_logs.unshift(data);
			raw.task_logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
		}
	}

	// Update display tile
	const displayTile = tiles.find(t => t.id === activeTileId);
	if (displayTile) {
		const logs = raw.task_logs || [];
		const lastLog = logs[0];
		displayTile.status = getTodayStatus(logs);
		displayTile.count = logs.length;
		displayTile.lastUpdate = lastLog ? lastLog.created_at : null;
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
			addLogStatus = btn.dataset.status;
			updateLogStatusBtns();
		});
	});
	document.getElementById('submitLogBtn').addEventListener('click', submitLog);
}

// ---- Task Update Helper ----
async function updateTask(taskId, updates) {
	const { error } = await supa
		.from('tasks')
		.update(updates)
		.eq('id', taskId);
	if (error) console.error('Update error:', error);
}

// ---- Tag Operations ----
async function toggleTag(tag) {
	if (!activeTileId) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.tags = raw.tags || [];
	const idx = raw.tags.indexOf(tag);
	if (idx >= 0) {
		raw.tags.splice(idx, 1);
	} else {
		raw.tags.push(tag);
	}
	const displayTile = tiles.find(t => t.id === activeTileId);
	if (displayTile) displayTile.tags = [...raw.tags];
	buildTagsFromTiles();
	openTilePopup(activeTileId);
	applyFilters();
	await updateTask(raw.id, { tags: raw.tags });
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
}

// ---- Log Operations ----
async function quickLog(tileId, status) {
	const raw = rawTiles[tileId];
	if (!raw) return;

	const today = new Date().toISOString().split('T')[0];

	// Check if there's already a log for today — update it instead of creating duplicate
	const existingLog = (raw.task_logs || []).find(l => {
		const logDate = l.created_at ? l.created_at.split('T')[0] : '';
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
		displayTile.lastUpdate = new Date().toISOString();
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
		tags: data.tags || [],
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

	buildTagsFromTiles();
	applyFilters();
	openTilePopup(data.id);
}

// ---- Tag Filter ----
function openTagFilterPopup() {
	const overlay = document.getElementById('tagFilterOverlay');
	const grid = document.getElementById('tagFilterGrid');

	const tagCounts = {};
	tiles.forEach(tile => {
		(tile.tags || []).forEach(t => {
			tagCounts[t] = (tagCounts[t] || 0) + 1;
		});
	});

	grid.innerHTML = '';

	// "+ New Tag" button FIRST
	const newBtn = document.createElement('button');
	newBtn.className = 'flex flex-col items-center justify-center gap-0.5 p-2 rounded-lg border-2 border-dashed border-blue-300 text-blue-500 hover:bg-blue-50 transition text-center';
	newBtn.innerHTML = `<span class="text-base">➕</span><span class="text-xs font-semibold">New Tag</span>`;
	newBtn.addEventListener('click', () => {
		const newTag = prompt('Enter new tag name:');
		if (!newTag || !newTag.trim()) return;
		const key = newTag.trim().toLowerCase().replace(/\s+/g, '-');
		if (!ALL_TAGS.find(t => t.key === key)) {
			ALL_TAGS.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1) });
			ALL_TAGS.sort((a, b) => a.key.localeCompare(b.key));
		}
		openTagFilterPopup();
	});
	grid.appendChild(newBtn);

	// "All" tile
	const allBtn = document.createElement('button');
	allBtn.className = `flex flex-col items-center justify-center gap-0.5 p-2 rounded-lg border-2 transition text-center ${
		activeTagFilter === null ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
	}`;
	allBtn.innerHTML = `<span class="text-base">🌐</span><span class="text-xs font-semibold">All</span><span class="text-[10px] text-slate-400">${tiles.length}</span>`;
	allBtn.addEventListener('click', () => { setTagFilter(null); });
	grid.appendChild(allBtn);

	// Tag tiles
	ALL_TAGS.forEach(at => {
		const count = tagCounts[at.key] || 0;
		if (count === 0) return;
		const wrapper = document.createElement('div');
		wrapper.className = 'relative group';
		const btn = document.createElement('button');
		btn.className = `w-full flex flex-col items-center justify-center gap-0.5 p-2 rounded-lg border-2 transition text-center ${
			activeTagFilter === at.key ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
		btn.innerHTML = `<span class="text-base">🏷️</span><span class="text-lg font-bold">${at.label}</span><span class="text-[10px] text-slate-400">${count}</span>`;
		btn.addEventListener('click', () => { setTagFilter(at.key); });
		wrapper.appendChild(btn);

		const editBtn = document.createElement('button');
		editBtn.className = 'absolute top-1 right-1 text-[10px] text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition';
		editBtn.textContent = '✏️';
		editBtn.title = 'Rename tag';
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			renameTag(at.key);
		});
		wrapper.appendChild(editBtn);

		grid.appendChild(wrapper);
	});

	// Untagged
	const untaggedCount = tiles.filter(t => !t.tags || t.tags.length === 0).length;
	if (untaggedCount > 0) {
		const btn = document.createElement('button');
		btn.className = `flex flex-col items-center justify-center gap-0.5 p-2 rounded-lg border-2 transition text-center ${
			activeTagFilter === '__untagged__' ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
		btn.innerHTML = `<span class="text-base">📦</span><span class="text-lg font-bold">Untagged</span><span class="text-[10px] text-slate-400">${untaggedCount}</span>`;
		btn.addEventListener('click', () => { setTagFilter('__untagged__'); });
		grid.appendChild(btn);
	}

	overlay.classList.remove('hidden');
}

function closeTagFilterPopup() {
	document.getElementById('tagFilterOverlay').classList.add('hidden');
}

async function renameTag(oldKey) {
	const newName = prompt('Rename tag "' + oldKey + '" to:', oldKey);
	if (!newName || !newName.trim() || newName.trim().toLowerCase().replace(/\s+/g, '-') === oldKey) return;
	const newKey = newName.trim().toLowerCase().replace(/\s+/g, '-');

	// Update all tasks that have this tag
	const tasksToUpdate = Object.values(rawTiles).filter(t => (t.tags || []).includes(oldKey));
	for (const task of tasksToUpdate) {
		const idx = task.tags.indexOf(oldKey);
		if (idx >= 0) task.tags[idx] = newKey;
		await supa.from('tasks').update({ tags: task.tags }).eq('id', task.id);
	}

	// Update display tiles
	tiles.forEach(t => {
		const idx = (t.tags || []).indexOf(oldKey);
		if (idx >= 0) t.tags[idx] = newKey;
	});

	// Update active filter if it was the renamed tag
	if (activeTagFilter === oldKey) activeTagFilter = newKey;

	buildTagsFromTiles();
	applyFilters();
	openTagFilterPopup();
}

function setTagFilter(tag) {
	activeTagFilter = tag;
	closeTagFilterPopup();
	applyFilters();
	updateFilterBar();
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
			const info = ALL_TAGS.find(t => t.key === activeTagFilter);
			label.textContent = info ? info.label : activeTagFilter;
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
		const today = new Date().toISOString().split('T')[0];
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
	{ key: 'active', label: '📊 Active', bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700' },
	{ key: 'all', label: '📊 All', bg: 'bg-white', border: '', text: '' },
	{ key: 'completed', label: '✅ Completed', bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-700' },
	{ key: 'failed', label: '❌ Failed', bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-700' },
	{ key: 'cancelled', label: '🚫 Cancelled', bg: 'bg-slate-100', border: 'border-slate-400', text: 'text-slate-600' },
	{ key: 'planned', label: '📋 Planned', bg: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-700' }
];

function toggleLifecycleFilter() {
	const idx = LIFECYCLE_CYCLE.findIndex(s => s.key === activeLifecycleFilter);
	const next = LIFECYCLE_CYCLE[(idx + 1) % LIFECYCLE_CYCLE.length];
	activeLifecycleFilter = next.key;
	const btn = document.getElementById('lifecycleFilterBtn');
	btn.className = `flex items-center gap-1 px-3 py-2 rounded-xl border transition text-sm font-medium whitespace-nowrap ${next.bg} ${next.border} ${next.text}`;
	btn.textContent = next.label;
	applyFilters();
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
	if (activeLifecycleFilter === 'active') {
		filtered = filtered.filter(t => t.taskStatus === 'planned' || t.taskStatus === 'in progress');
	} else if (activeLifecycleFilter && activeLifecycleFilter !== 'all') {
		filtered = filtered.filter(t => t.taskStatus === activeLifecycleFilter);
	}
	const q = (document.getElementById('searchBox').value || '').trim().toLowerCase();
	if (q) {
		filtered = filtered.filter(t => t.name.toLowerCase().includes(q));
	}
	renderGallery(filtered);
}

// ---- Reset Today's Logs ----
async function resetTodayLogs() {
	if (!confirm('Reset all done/skip flags for today?')) return;
	const today = new Date().toISOString().split('T')[0];
	// Find today's done/skip logs across all tiles
	const logIdsToReset = [];
	Object.values(rawTiles).forEach(raw => {
		(raw.task_logs || []).forEach(log => {
			const logDate = log.created_at ? log.created_at.split('T')[0] : '';
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
			tags: task.tags || [],
			status: getTodayStatus(logs),
			taskStatus: task.status || 'in progress',
			emoji: plant.emoji,
			health,
			healthLabel: plant.label,
			healthColor: plant.color,
			count: logs.length,
			createdAt: task.created_at || null,
			lastUpdate: lastLog ? lastLog.created_at : null
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
		const todayStr = new Date().toISOString().split('T')[0];
		const todayLog = logs.find(l => l.created_at && l.created_at.split('T')[0] === todayStr);
		const recentLogs = logs.slice(0, 7).map(l => `${l.created_at?.split('T')[0]}: ${l.status}${l.note ? ' — ' + l.note : ''}`).join('; ');

		return `• "${task.name}" | tags: [${(task.tags || []).join(', ')}] | freq: ${task.frequency_mode} | lifecycle: ${task.status || 'in progress'} | health: ${health}% (${plant.label}) | total logs: ${logs.length} | today: ${todayLog ? todayLog.status : 'no action'} | recent: ${recentLogs || 'none'}`;
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
		const response = await fetch('/api/ai', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
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
			const errMsg = err.error || 'Something went wrong. Please try again.';
			appendAiMessage('assistant', '⚠️ ' + errMsg);
			return;
		}

		const data = await response.json();
		const reply = data.reply || 'No response.';
		aiChatHistory.push({ role: 'assistant', content: reply });
		appendAiMessage('assistant', reply);
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
	document.getElementById('addTileBtn').addEventListener('click', addNewTile);
});
