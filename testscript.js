let tiles = [];
let rawTiles = {}; // full task objects keyed by uuid
let activeTileId = null; // currently open tile
let activeTagFilter = null; // currently active tag filter
let activeTimelineFilter = null; // 'today' or null
let activeStatusFilter = null; // null, 'done', 'skipped', 'noaction'
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
		if (log.status === 'skip') skipDates.add(d);
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
		const lastStatus = lastLog ? lastLog.status : null;
		const health = calculateHealth(task);
		const plant = healthToPlant(health);
		return {
			id: task.id,
			name: task.name,
			tags: task.tags || [],
			status: lastStatus === 'completed' ? 'completed' : lastStatus === 'done' ? 'done' : lastStatus === 'skip' ? 'skipped' : 'noaction',
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
		const groupSection = document.createElement('section');
		groupSection.className = 'mb-4';

		const heading = document.createElement('div');
		heading.className = 'text-xl font-bold mb-2 mt-8 pl-1';
		heading.textContent = tag;
		groupSection.appendChild(heading);

		const groupGrid = document.createElement('div');
		groupGrid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4';
		groups[tag].forEach(tile => {
			const tileDiv = document.createElement("div");
			const tileColor = tile.healthColor || 'bg-white';
			tileDiv.className = `tile ${tileColor} rounded-xl shadow border p-4 flex flex-col items-center justify-between gap-2 hover:shadow-lg transition cursor-pointer`;
			tileDiv.dataset.tileId = tile.id;
			const lastUpd = tile.lastUpdate ? new Date(tile.lastUpdate).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
			const createdAt = tile.createdAt ? new Date(tile.createdAt).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
			tileDiv.innerHTML = `
				<div class="text-3xl">${tile.emoji}</div>
				<div class="font-semibold text-center truncate w-full">${tile.name}</div>
				<div class="flex gap-2 mt-1">
					<span class="text-xs ${tile.status === 'noaction' ? 'text-amber-500 font-semibold' : 'text-slate-500'}">${tile.status === 'noaction' ? 'take action now' : tile.status}</span>
					<span class="text-xs text-slate-500">(${tile.count})</span>
				</div>
				<div class="text-xs font-medium ${tile.health >= 60 ? 'text-green-600' : tile.health >= 40 ? 'text-yellow-600' : 'text-red-500'}">${tile.health}% ${tile.healthLabel}</div>
				<div class="flex justify-between w-full mt-1">
					<span class="text-xs text-slate-400">📌 ${createdAt}</span>
					<span class="text-xs text-slate-400">🕓 ${lastUpd}</span>
				</div>
				<div class="flex gap-2 mt-2 w-full">
					<button class="quick-done flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${tile.status === 'done' || tile.status === 'completed' ? 'bg-green-200 text-green-800' : 'bg-green-50 text-green-600 hover:bg-green-200'}" data-tile-id="${tile.id}">✅ Done</button>
					<button class="quick-skip flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${tile.status === 'skipped' ? 'bg-yellow-200 text-yellow-800' : 'bg-yellow-50 text-yellow-600 hover:bg-yellow-200'}" data-tile-id="${tile.id}">⏭️ Skip</button>
				</div>
			`;
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
				quickLog(tile.id, 'skip');
			});
			groupGrid.appendChild(tileDiv);
		});
		groupSection.appendChild(groupGrid);
		gallery.appendChild(groupSection);
	});
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
	const statusLabel = lastLog
		? (lastLog.status === 'completed' ? '✅ Completed' : lastLog.status === 'done' ? '💪 Done' : lastLog.status === 'skip' ? '😢 Skipped' : '💬 No Action')
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
			const actionColor = log.status === 'done' ? 'bg-green-400' : log.status === 'skip' ? 'bg-yellow-400' : log.status === 'completed' ? 'bg-blue-400' : 'bg-slate-300';
			const noteHtml = log.note ? `<div class="text-xs text-slate-500 mt-1 italic">${log.note}</div>` : '';
			timelineHtml += `
				<div class="mb-4 relative group rounded-lg p-2 -ml-2 hover:bg-red-50 transition">
					<div class="absolute -left-[13px] top-3 w-3 h-3 rounded-full ${actionColor} border-2 border-white"></div>
					<div class="flex items-center justify-between">
						<div class="text-sm font-semibold">${log.status}</div>
						<button class="delete-log text-red-300 hover:text-red-500 text-lg font-bold opacity-0 group-hover:opacity-100 transition px-1" data-log-id="${log.id}">&times;</button>
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
			<span class="text-4xl">${raw.emoji || '🟦'}</span>
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
		<div class="text-md font-semibold mb-1">Log Timeline</div>
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
			await updateTask(activeTileId, { end_date: raw.end_date });
		});
	}

	// Wire up time-of-day buttons
	document.querySelectorAll('.tod-btn').forEach(btn => {
		btn.addEventListener('click', e => { e.stopPropagation(); toggleTimeOfDay(btn.dataset.tod); });
	});

	// Wire up delete tile button
	document.getElementById('deleteTileBtn').addEventListener('click', deleteTile);

	// Wire up log delete buttons
	document.querySelectorAll('.delete-log').forEach(btn => {
		btn.addEventListener('click', async e => {
			e.stopPropagation();
			await deleteLog(btn.dataset.logId);
		});
	});

	overlay.classList.remove('hidden');
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
	// Close popup so user can quickly tag the next tile
	document.getElementById('tileOverlay').classList.add('hidden');
	activeTileId = null;
	renderGallery(tiles);
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
		return logDate === today && (l.status === 'done' || l.status === 'skip' || l.status === 'completed');
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
		displayTile.status = status === 'done' ? 'done' : status === 'skip' ? 'skipped' : 'noaction';
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
			frequency_mode: 'daily',
			time_of_day: '',
			tags: [],
			emoji: '🟦'
		})
		.select('*, task_logs(*), task_frequency_days(*)')
		.single();

	if (error || !data) {
		console.error('Add error:', error);
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
		emoji: plant.emoji,
		health,
		healthLabel: plant.label,
		healthColor: plant.color,
		count: 0,
		createdAt: data.created_at || null,
		lastUpdate: null
	});

	buildTagsFromTiles();
	openTilePopup(data.id);
	applyFilters();
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
		const btn = document.createElement('button');
		btn.className = `flex flex-col items-center justify-center gap-0.5 p-2 rounded-lg border-2 transition text-center ${
			activeTagFilter === at.key ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
		btn.innerHTML = `<span class="text-base">🏷️</span><span class="text-xs font-semibold">${at.label}</span><span class="text-[10px] text-slate-400">${count}</span>`;
		btn.addEventListener('click', () => { setTagFilter(at.key); });
		grid.appendChild(btn);
	});

	// Untagged
	const untaggedCount = tiles.filter(t => !t.tags || t.tags.length === 0).length;
	if (untaggedCount > 0) {
		const btn = document.createElement('button');
		btn.className = `flex flex-col items-center justify-center gap-0.5 p-2 rounded-lg border-2 transition text-center ${
			activeTagFilter === '__untagged__' ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
		btn.innerHTML = `<span class="text-base">📦</span><span class="text-xs font-semibold">Untagged</span><span class="text-[10px] text-slate-400">${untaggedCount}</span>`;
		btn.addEventListener('click', () => { setTagFilter('__untagged__'); });
		grid.appendChild(btn);
	}

	// "+ New Tag" button
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

	overlay.classList.remove('hidden');
}

function closeTagFilterPopup() {
	document.getElementById('tagFilterOverlay').classList.add('hidden');
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
			if (logDate === today && (log.status === 'done' || log.status === 'skip' || log.status === 'completed')) {
				logIdsToReset.push(log.id);
			}
		});
	});
	if (logIdsToReset.length === 0) {
		alert('Nothing to reset — no done/skip logs for today.');
		return;
	}
	// Update status to 'reset' in DB
	const { error } = await supa.from('task_logs').update({ status: 'reset' }).in('id', logIdsToReset);
	if (error) { console.error('Reset error:', error); return; }
	// Update local data
	Object.values(rawTiles).forEach(raw => {
		(raw.task_logs || []).forEach(log => {
			if (logIdsToReset.includes(log.id)) {
				log.status = 'reset';
			}
		});
	});
	// Rebuild display tiles
	tiles = Object.values(rawTiles).map(task => {
		const logs = task.task_logs || [];
		const lastLog = logs[0];
		const lastStatus = lastLog ? lastLog.status : null;
		const health = calculateHealth(task);
		const plant = healthToPlant(health);
		return {
			id: task.id,
			name: task.name,
			tags: task.tags || [],
			status: lastStatus === 'completed' ? 'completed' : lastStatus === 'done' ? 'done' : lastStatus === 'skip' ? 'skipped' : 'noaction',
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

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
	initPopup();
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
	document.getElementById('addTileBtn').addEventListener('click', addNewTile);
});
