let tiles = [];
let rawTiles = {}; // full tile objects keyed by id (for popup details)
let activeTileId = null; // currently open tile
let activeTagFilter = null; // currently active tag filter
let ALL_TAGS = []; // dynamically built from tile data

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

// Try to get user session and fetch tiles from Supabase
async function fetchTilesFromSupabase() {
	// Get session
	const { data: { session } } = await supa.auth.getSession();
	if (!session || !session.user) {
		renderGallery([]);
		return;
	}
	// Fetch world data for this user
	const { data, error } = await supa
		.from("worlds")
		.select("data")
		.eq("user_id", session.user.id)
		.single();
	if (error || !data || !data.data) {
		renderGallery([]);
		return;
	}
	// Supabase stores tiles as an object, convert to array and add id
	rawTiles = data.data;
	tiles = Object.entries(data.data)
		.filter(([_, t]) => t && t.name && t.name.trim() !== "")
		.map(([id, t]) => ({
			id,
			name: t.name,
			tags: t.tags || [],
			status: t.completed ? "completed" : t.done ? "done" : t.skip ? "skipped" : "noaction",
			emoji: t.emoji || "🟦",
			count: (t.logs && t.logs.length) || 0,
			lastUpdate: t.lastUpdate || null
		}));
	buildTagsFromTiles();
	renderGallery(tiles);
}


function renderGallery(filteredTiles) {
	const gallery = document.getElementById("gallery");
	gallery.innerHTML = "";
	if (!filteredTiles.length) {
		gallery.innerHTML = '<div class="col-span-full text-center text-slate-500 py-8">No tiles found.</div>';
		return;
	}

	// Group tiles by first tag (or 'Untagged')
	const groups = {};
	filteredTiles.forEach(tile => {
		const tag = (tile.tags && tile.tags.length > 0) ? tile.tags[0] : 'Untagged';
		if (!groups[tag]) groups[tag] = [];
		groups[tag].push(tile);
	});

	// Render each group with a heading
	Object.keys(groups).sort().forEach(tag => {
		// Group container
		const groupSection = document.createElement('section');
		groupSection.className = 'mb-4';

		// Group heading
		const heading = document.createElement('div');
		heading.className = 'text-xl font-bold mb-2 mt-8 pl-1';
		heading.textContent = tag;
		groupSection.appendChild(heading);

		// Group grid (left-aligned, no extra margin)
		const groupGrid = document.createElement('div');
		groupGrid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4';
		groups[tag].forEach(tile => {
			const tileDiv = document.createElement("div");
			tileDiv.className = "tile bg-white rounded-xl shadow p-4 flex flex-col items-center justify-between gap-2 hover:shadow-lg transition cursor-pointer";
			tileDiv.dataset.tileId = tile.id;
			const lastUpd = tile.lastUpdate ? new Date(tile.lastUpdate).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '—';
			tileDiv.innerHTML = `
				<div class="text-3xl">${tile.emoji || "🟦"}</div>
				<div class="font-semibold text-center truncate w-full">${tile.name}</div>
				<div class="flex flex-wrap gap-1 justify-center">${(tile.tags||[]).map(tag => `<span class='px-2 py-0.5 rounded bg-slate-100 text-xs'>${tag}</span>`).join('')}</div>
				<div class="flex gap-2 mt-2">
					<span class="text-xs text-slate-500">${tile.status}</span>
					<span class="text-xs text-slate-500">(${tile.count})</span>
				</div>
				<div class="text-xs text-slate-400 mt-1">🕓 ${lastUpd}</div>
			`;
			tileDiv.addEventListener('click', () => openTilePopup(tile.id));
			groupGrid.appendChild(tileDiv);
		});
		groupSection.appendChild(groupGrid);
		gallery.appendChild(groupSection);
	});
}


// ---- Tile Detail Popup ----
function initPopup() {
	const overlay = document.getElementById('tileOverlay');
	const popupBody = document.getElementById('popupBody');
	document.getElementById('closePopup').addEventListener('click', closeTilePopup);
	overlay.addEventListener('click', e => { if (e.target === overlay) closeTilePopup(); });
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

	const statusLabel = raw.completed ? '✅ Completed' : raw.done ? '💪 Done' : raw.skip ? '😢 Skipped' : '💬 No Action';
	const freqMode = raw.frequency ? raw.frequency.mode : 'daily';
	const timeOfDay = (raw.timeOfDay || []).join(', ') || '—';
	const currentTags = raw.tags || [];

	// Build logs timeline (sorted newest first)
	const logs = (raw.logs || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
	let timelineHtml = '';
	if (logs.length === 0) {
		timelineHtml = '<div class="text-slate-400 text-sm py-4">No logs yet.</div>';
	} else {
		timelineHtml = '<div class="relative pl-6 border-l-2 border-slate-200 mt-2">';
		logs.forEach(log => {
			const d = new Date(log.date);
			const dateStr = d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
			const timeStr = d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
			const actionColor = log.text === 'done' ? 'bg-green-400' : log.text === 'skip' ? 'bg-yellow-400' : log.text === 'completed' ? 'bg-blue-400' : 'bg-slate-300';
			const noteHtml = log.note ? `<div class="text-xs text-slate-500 mt-1 italic">${log.note}</div>` : '';
			timelineHtml += `
				<div class="mb-4 relative">
					<div class="absolute -left-[21px] top-1 w-3 h-3 rounded-full ${actionColor} border-2 border-white"></div>
					<div class="text-sm font-semibold">${log.text}</div>
					<div class="text-xs text-slate-400">${dateStr} · ${timeStr}</div>
					${noteHtml}
				</div>`;
		});
		timelineHtml += '</div>';
	}

	// Build tag chips (removable)
	const tagChipsHtml = currentTags.map(t => {
		const info = ALL_TAGS.find(at => at.key === t);
		const label = info ? info.label : t;
		return `<span class='inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-200 text-xs'>${label}<button class='remove-tag ml-1 text-slate-400 hover:text-red-500 font-bold' data-tag='${t}'>&times;</button></span>`;
	}).join(' ');

	// Build preset tag buttons (highlight active ones)
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
				<div class="text-xs text-slate-400">${raw.lastUpdate ? 'Last update: ' + new Date(raw.lastUpdate).toLocaleDateString() : ''}</div>
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
			${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i) => `<button class='day-btn px-2 py-1 rounded-full text-xs border transition ${(raw.frequency && raw.frequency.days && raw.frequency.days.includes(String(i))) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-day='${i}'>${d}</button>`).join('')}
		</div>
		<div id="onceDatePicker" class="mb-8" style="display:${freqMode === 'once' ? 'block' : 'none'}">
			<label class="text-xs text-slate-500">Date</label>
			<input type="date" id="onceDateInput" class="ml-2 rounded-lg border px-2 py-1 text-sm" value="${(raw.frequency && raw.frequency.date) || ''}" />
		</div>
		<div class="mb-2 text-sm font-semibold">Time of Day</div>
		<div id="todBtns" class="flex flex-wrap gap-2 mb-8">
			${[{key:'morning',label:'🌅 Morning'},{key:'afternoon',label:'☀️ Afternoon'},{key:'evening',label:'🌇 Evening'},{key:'night',label:'🌙 Night'}].map(t => `<button class='tod-btn px-3 py-1 rounded-full text-xs border transition ${(raw.timeOfDay || []).includes(t.key) ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}' data-tod='${t.key}'>${t.label}</button>`).join('')}
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
		btn.addEventListener('click', e => {
			e.stopPropagation();
			toggleTag(btn.dataset.tag);
		});
	});
	document.querySelectorAll('.preset-tag').forEach(btn => {
		btn.addEventListener('click', e => {
			e.stopPropagation();
			toggleTag(btn.dataset.tag);
		});
	});

	// Wire up frequency buttons
	document.querySelectorAll('.freq-btn').forEach(btn => {
		btn.addEventListener('click', e => {
			e.stopPropagation();
			setFrequency(btn.dataset.freq);
		});
	});

	// Wire up weekly day buttons
	document.querySelectorAll('.day-btn').forEach(btn => {
		btn.addEventListener('click', e => {
			e.stopPropagation();
			toggleWeeklyDay(btn.dataset.day);
		});
	});

	// Wire up once-date picker
	const onceDateInput = document.getElementById('onceDateInput');
	if (onceDateInput) {
		onceDateInput.addEventListener('change', async e => {
			if (activeTileId === null) return;
			const raw = rawTiles[activeTileId];
			if (!raw) return;
			raw.frequency = raw.frequency || { mode: 'once', days: [], date: null };
			raw.frequency.date = e.target.value || null;
			await saveTileToCloud();
		});
	}

	// Wire up time-of-day buttons
	document.querySelectorAll('.tod-btn').forEach(btn => {
		btn.addEventListener('click', e => {
			e.stopPropagation();
			toggleTimeOfDay(btn.dataset.tod);
		});
	});

	// Wire up delete button
	document.getElementById('deleteTileBtn').addEventListener('click', async () => {
		if (activeTileId === null) return;
		if (!confirm('Are you sure you want to delete this tile? This cannot be undone.')) return;
		delete rawTiles[activeTileId];
		tiles = tiles.filter(t => t.id !== activeTileId);
		await saveTileToCloud();
		closeTilePopup();
		renderGallery(tiles);
	});

	overlay.classList.remove('hidden');
}

async function toggleTag(tag) {
	if (activeTileId === null) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.tags = raw.tags || [];
	const idx = raw.tags.indexOf(tag);
	if (idx >= 0) {
		raw.tags.splice(idx, 1);
	} else {
		raw.tags.push(tag);
	}
	// Update the display tile array too
	const displayTile = tiles.find(t => t.id === activeTileId);
	if (displayTile) displayTile.tags = [...raw.tags];
	// Rebuild dynamic tags list
	buildTagsFromTiles();
	// Re-render popup to reflect change
	openTilePopup(activeTileId);
	// Re-render gallery so grouping updates immediately
	renderGallery(tiles);
	// Save to Supabase
	await saveTileToCloud();
}

async function setFrequency(mode) {
	if (activeTileId === null) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.frequency = raw.frequency || { mode: 'daily', days: [], date: null };
	raw.frequency.mode = mode;
	if (mode !== 'weekly') raw.frequency.days = [];
	openTilePopup(activeTileId);
	await saveTileToCloud();
}

async function toggleWeeklyDay(day) {
	if (activeTileId === null) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.frequency = raw.frequency || { mode: 'weekly', days: [], date: null };
	raw.frequency.days = raw.frequency.days || [];
	const idx = raw.frequency.days.indexOf(String(day));
	if (idx >= 0) {
		raw.frequency.days.splice(idx, 1);
	} else {
		raw.frequency.days.push(String(day));
	}
	openTilePopup(activeTileId);
	await saveTileToCloud();
}

async function toggleTimeOfDay(tod) {
	if (activeTileId === null) return;
	const raw = rawTiles[activeTileId];
	if (!raw) return;
	raw.timeOfDay = raw.timeOfDay || [];
	const idx = raw.timeOfDay.indexOf(tod);
	if (idx >= 0) {
		raw.timeOfDay.splice(idx, 1);
	} else {
		raw.timeOfDay.push(tod);
	}
	openTilePopup(activeTileId);
	await saveTileToCloud();
}

async function saveTileToCloud() {
	const { data: { session } } = await supa.auth.getSession();
	if (!session || !session.user) return;
	const { error } = await supa
		.from('worlds')
		.upsert({ user_id: session.user.id, data: rawTiles }, { onConflict: 'user_id' });
	if (error) console.error('Save error:', error);
}

// ---- Tag Filter ----
function openTagFilterPopup() {
	const overlay = document.getElementById('tagFilterOverlay');
	const grid = document.getElementById('tagFilterGrid');

	// Collect tags actually in use + count
	const tagCounts = {};
	tiles.forEach(tile => {
		(tile.tags || []).forEach(t => {
			tagCounts[t] = (tagCounts[t] || 0) + 1;
		});
	});

	grid.innerHTML = '';

	// "All" tile
	const allBtn = document.createElement('button');
	allBtn.className = `flex flex-col items-center justify-center gap-1 p-4 rounded-xl border-2 transition text-center ${
		activeTagFilter === null ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
	}`;
	allBtn.innerHTML = `<span class="text-2xl">🌐</span><span class="text-sm font-semibold">All</span><span class="text-xs text-slate-400">${tiles.length} tiles</span>`;
	allBtn.addEventListener('click', () => { setTagFilter(null); });
	grid.appendChild(allBtn);

	// Tag tiles
	ALL_TAGS.forEach(at => {
		const count = tagCounts[at.key] || 0;
		if (count === 0) return; // hide unused tags
		const btn = document.createElement('button');
		btn.className = `flex flex-col items-center justify-center gap-1 p-4 rounded-xl border-2 transition text-center ${
			activeTagFilter === at.key ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
		btn.innerHTML = `<span class="text-2xl">\ud83c\udff7\ufe0f</span><span class="text-sm font-semibold">${at.label}</span><span class="text-xs text-slate-400">${count} tiles</span>`;
		btn.addEventListener('click', () => { setTagFilter(at.key); });
		grid.appendChild(btn);
	});

	// Untagged
	const untaggedCount = tiles.filter(t => !t.tags || t.tags.length === 0).length;
	if (untaggedCount > 0) {
		const btn = document.createElement('button');
		btn.className = `flex flex-col items-center justify-center gap-1 p-4 rounded-xl border-2 transition text-center ${
			activeTagFilter === '__untagged__' ? 'border-slate-800 bg-slate-100' : 'border-slate-200 bg-white hover:bg-slate-50'
		}`;
		btn.innerHTML = `<span class="text-2xl">📦</span><span class="text-sm font-semibold">Untagged</span><span class="text-xs text-slate-400">${untaggedCount} tiles</span>`;
		btn.addEventListener('click', () => { setTagFilter('__untagged__'); });
		grid.appendChild(btn);
	}

	// "+ New Tag" button
	const newBtn = document.createElement('button');
	newBtn.className = 'flex flex-col items-center justify-center gap-1 p-4 rounded-xl border-2 border-dashed border-blue-300 text-blue-500 hover:bg-blue-50 transition text-center';
	newBtn.innerHTML = `<span class="text-2xl">➕</span><span class="text-sm font-semibold">New Tag</span>`;
	newBtn.addEventListener('click', () => {
		const newTag = prompt('Enter new tag name:');
		if (!newTag || !newTag.trim()) return;
		const key = newTag.trim().toLowerCase().replace(/\s+/g, '-');
		// Add to ALL_TAGS if not already there
		if (!ALL_TAGS.find(t => t.key === key)) {
			ALL_TAGS.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1) });
			ALL_TAGS.sort((a, b) => a.key.localeCompare(b.key));
		}
		// Re-open the filter popup to show the new tag
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

function applyFilters() {
	let filtered = [...tiles];
	// Tag filter
	if (activeTagFilter === '__untagged__') {
		filtered = filtered.filter(t => !t.tags || t.tags.length === 0);
	} else if (activeTagFilter) {
		filtered = filtered.filter(t => (t.tags || []).includes(activeTagFilter));
	}
	// Search filter
	const q = (document.getElementById('searchBox').value || '').trim().toLowerCase();
	if (q) {
		filtered = filtered.filter(t => t.name.toLowerCase().includes(q));
	}
	renderGallery(filtered);
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
	initPopup();
	fetchTilesFromSupabase();

	// Search filter
	document.getElementById('searchBox').addEventListener('input', () => applyFilters());

	// Tag filter popup
	document.getElementById('tagFilterBtn').addEventListener('click', openTagFilterPopup);
	document.getElementById('closeTagFilter').addEventListener('click', closeTagFilterPopup);
	document.getElementById('tagFilterOverlay').addEventListener('click', e => {
		if (e.target === document.getElementById('tagFilterOverlay')) closeTagFilterPopup();
	});

	// Clear filter
	document.getElementById('clearFilterBtn').addEventListener('click', () => setTagFilter(null));
});
