const TILE_COUNT = 128;
let currentUser = null;
let tiles = {};
let activeIndex = null;


function initEmptyTiles() {
	tiles = {};
	for (let i = 0; i < TILE_COUNT; i++) {
		tiles[i] = {
			name: "",
			logs: [],
			lastUpdate: null,
			nextOccurrence: null,
			frequency: {
				mode: "daily",
				days: []
			},
			done: false,
			skip: false
		};


	}
}

/* local storage functions */
function loadWorldFromLocal() {
	const stored = localStorage.getItem("lifeworld");
	if (stored) {
		try {
			tiles = JSON.parse(stored);

			// ensure older users get expanded tiles
			if (Object.keys(tiles).length < TILE_COUNT) {
				for (let i = Object.keys(tiles).length; i < TILE_COUNT; i++) {
					tiles[i] = {
						name: "",
						logs: [],
						lastUpdate: null,
						nextOccurrence: null,
						frequency: {
							mode: "daily",
							days: []
						}
					};
				}
			}

			for (let i = 0; i < TILE_COUNT; i++) normalizeTile(i);



		} catch {
			initEmptyTiles();
		}
	} else {
		initEmptyTiles();
	}
}

function saveWorldToLocal() {
	localStorage.setItem("lifeworld", JSON.stringify(tiles));
}

/* cloud functions */
async function loadWorldFromCloud() {
	if (!currentUser) return;

	const {
		data,
		error
	} = await supa
		.from("worlds")
		.select("data")
		.eq("user_id", currentUser.id)
		.single();

	if (error && error.code !== "PGRST116") {
		console.error("Cloud load error:", error);
		// fallback
		initEmptyTiles();
	} else if (!data) {
		// first time user
		initEmptyTiles();
		await saveWorldToCloud();
	} else {
		tiles = data.data;


		if (Object.keys(tiles).length < TILE_COUNT) {
			for (let i = Object.keys(tiles).length; i < TILE_COUNT; i++) {
				tiles[i] = {
					name: "",
					logs: [],
					lastUpdate: null,
					nextOccurrence: null,
					frequency: {
						mode: "daily",
						days: []
					},
					done: false,
					skip: false
				};

			}


			for (let i = 0; i < TILE_COUNT; i++) normalizeTile(i);


			await saveWorldToCloud();
		}

		// if something off, ensure structure
		if (!tiles || typeof tiles !== "object") {
			initEmptyTiles();
		}
	}
	debugger;
	refreshNextOccurrences();
	renderTiles();
}

async function saveWorldToCloud() {
	if (!currentUser) return;
	const {
		error
	} = await supa
		.from("worlds")
		.upsert({
			user_id: currentUser.id,
			data: tiles
		}, {
			onConflict: "user_id"
		});

	if (error) {
		console.error("Cloud save error:", error);
	}
}


function saveWorld() {
	if (currentUser) {
		saveWorldToCloud();
	} else {
		saveWorldToLocal();
	}
}

// ---- Tile rendering & coloring ----
function updateTileColor(i) {
	let count = tiles[i].logs.length;
	let $tile = $(`.tile[data-index='${i}']`);

	if (count === 0) {
		$tile.css("background", "#F5F5F0"); // same pale gray as default
	} else if (count >= 1 && count <= 3) {
		$tile.css("background", "#F5CBCB"); // pastel pink
	} else if (count >= 4 && count <= 8) {
		$tile.css("background", "#c7f7c0"); // soft green
	} else if (count >= 9 && count <= 15) {
		$tile.css("background", "#b6d9ff"); // soft blue
	} else if (count > 15) {
		$tile.css("background", "linear-gradient(135deg, #ff9a9e, #fad0c4)");
	}
}

function renderTiles() {
	$("#grid").empty();

	for (let i = 0; i < TILE_COUNT; i++) {
		const t = tiles[i];
		normalizeTile(i);

		if (!t.name && t.logs.length === 0) {
			$("#grid").append(`
				<div class="tile empty" data-index="${i}">
					<div class="plusIcon">+</div>
				</div>
			`);
			continue;
		}

		const freqText = formatFrequency(t.frequency);
		const nextText = computeNextOccurrenceDisplay(t);
		const lastUpdateText = convertToShortDate(t.lastUpdate);

		$("#grid").append(`    
		  <div class="tile" data-index="${i}">
			<div class="tileTop">
			  <div class="tileName">${t.name || ""}</div>
			</div>
			<div class="tileCenter">
			  <div class="tileCount">${t.logs.length > 0 ? t.logs.length : "-"}</div>  
			  <div class="tileNext">${nextText}</div>
			</div>
			<div class="tileLast">${freqText}</div>
			<div class="tileLast">${t.done ? "✔️" : ""}</div>
			<div class="tileLast">${lastUpdateText || ""}</div>
		  </div>
		`);

		updateTileColor(i);
	}

	initDragAndDrop();
	applySearchFilter();
}


// Update just one tile UI (for future use if needed)
function updateTileUI(i) {
	let t = tiles[i];
	let tile = $(`.tile[data-index='${i}']`);
	tile.find(".tileName").text(t.name || "");
	tile.find(".count").text(t.logs.length);
	tile.find(".timestamp").text(t.lastUpdate || "");
	updateTileColor(i);
}

// ---- Popup / tile click ----
$(document).on("click", ".tile", function () {
	activeIndex = $(this).data("index");

	$("#tileTitle").text(tiles[activeIndex].name || "Tile details");
	$("#entryText").val("");
	$("#doneToggle").prop("checked", tiles[activeIndex].done === true);
	$("#skipToggle").prop("checked", tiles[activeIndex].skip === true);


	// HISTORY
	normalizeTile(activeIndex);
	let logs = [...tiles[activeIndex].logs].sort((a, b) => {
		return new Date(b.date) - new Date(a.date);  // NEW: newest first
	});

	if (logs.length > 0) {
		$("#historyBox").html(
			logs.map((log) => `
			<div class="timelineItem">
				<div class="timelineText">${log.text}</div>
				<div class="timelineDate">${log.date}</div>
			</div>
		`).join("")
		);

	} else {
		$("#historyBox").html("<div style='color:#888;'>No history yet</div>");
	}

	// ==== LOAD FREQUENCY INTO POPUP ====
	let freq = tiles[activeIndex].frequency || {
		mode: "daily",
		days: []
	};

	$(`input[name='freqMode'][value='${freq.mode}']`).prop("checked", true);

	if (freq.mode === "custom") $("#customDays").show();
	else $("#customDays").hide();

	$(".dayBtn").removeClass("active");
	freq.days.forEach(d => {
		$(`.dayBtn[data-day='${d}']`).addClass("active");
	});

	$("#overlay").show();
	$("#popup").show();

	if (!tiles[activeIndex].name) $("#tileNameInput").focus();
	else $("#entryText").focus();
});

// ---- Frequency UI Handlers ----
$(document).on("change", "input[name='freqMode']", function () {
	if (this.value === "custom") $("#customDays").show();
	else $("#customDays").hide();
});

$(document).on("click", ".dayBtn", function () {
	$(this).toggleClass("active");
});

// ---- Save ----
$("#saveBtn").on("click", function () {
	if (activeIndex === null) return;

	let name = $("#tileTitle").text().trim();
	tiles[activeIndex].name = name;

	let txt = $("#entryText").val().trim();
	if (txt.length > 0) {
		tiles[activeIndex].logs.push({
			text: txt,
			date: formatDate(new Date())
		});
	}

	let now = new Date();
	let formattedNow = formatDate(now);

	// Read toggles
	let doneChecked = $("#doneToggle").is(":checked");
	let skipChecked = $("#skipToggle").is(":checked");

	if (skipChecked) doneChecked = false;

	// Build list of log texts to add
	const logsToAdd = [];

	if (txt.length > 0) {
		logsToAdd.push(txt);
	}

	if (doneChecked) {
		logsToAdd.push("done");
	}

	if (skipChecked) {
		logsToAdd.push("skipped");
	}

	// Push logs (if any)
	logsToAdd.forEach(t => {
		tiles[activeIndex].logs.push({
			text: t,
			date: formattedNow
		});
	});

	// Update lastUpdate if we added anything
	if (logsToAdd.length > 0) {
		tiles[activeIndex].lastUpdate = formattedNow;
	}
	tiles[activeIndex].lastUpdate = formatDate(now);

	// ==== SAVE FREQUENCY FIRST ====
	let mode = $("input[name='freqMode']:checked").val();
	let days = [];

	if (mode === "custom") {
		$(".dayBtn.active").each(function () {
			days.push($(this).data("day"));
		});
	}

	tiles[activeIndex].frequency = {
		mode,
		days
	};

	// ==== THEN CALCULATE NEXT OCCURRENCE ====
	tiles[activeIndex].nextOccurrence = formatDate(
		calculateNextOccurrence(tiles[activeIndex].frequency, now)
	);

	tiles[activeIndex].done = $("#doneToggle").is(":checked");
	tiles[activeIndex].skip = $("#skipToggle").is(":checked");



	saveWorld();
	renderTiles();

	$("#popup").hide();
	$("#overlay").hide();
	$("#historyBox").empty();
});



/* frequency calculations */
function formatFrequency(freq) {
	if (!freq) freq = {
		mode: "",
		days: []
	};

	switch (freq.mode) {
		case "daily":
			return "Daily";
		case "weekly":
			return "Weekly";
		case "biweekly":
			return "Every 2 Weeks";
		case "triweekly":
			return "Every 3 Weeks";
		case "monthly":
			return "Monthly";
		case "2months":
			return "Every 2 Months";
		case "3months":
			return "Every 3 Months";
		case "6months":
			return "Every 6 Months";
		case "custom":
			if (!freq.days || freq.days.length === 0) return "Custom";
			return "Every " + freq.days.join(" & ");
	}

	return "";
}

function calculateNextOccurrence(freq, lastUpdateDate) {
	const baseDate = lastUpdateDate ? new Date(lastUpdateDate) : new Date();
	let mode = freq.mode;

	switch (mode) {
		case "daily":
			return addDays(baseDate, 1);

		case "weekly":
			return addDays(baseDate, 7);

		case "biweekly":
			return addDays(baseDate, 14);

		case "triweekly":
			return addDays(baseDate, 21);

		case "monthly":
			return addDays(baseDate, 30);

		case "2months":
			return addDays(baseDate, 60);

		case "3months":
			return addDays(baseDate, 90);

		case "6months":
			return addDays(baseDate, 180);

		case "custom":
			return nextCustomWeekday(freq.days);

		default:
			return null;
	}
}

function nextCustomWeekday(daysArray) {
	if (!daysArray || daysArray.length === 0) return null;

	const map = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6
	};

	const today = new Date();
	const todayIndex = today.getDay();

	let minDiff = 999;

	daysArray.forEach(d => {
		const target = map[d];
		const diff = (target - todayIndex + 7) % 7;
		if (diff < minDiff) minDiff = diff;
	});

	return addDays(today, minDiff);
}

function refreshNextOccurrences() {
	const today = new Date();

	for (let i = 0; i < TILE_COUNT; i++) {
		const t = tiles[i];
		if (!t || !t.frequency) continue;

		const freq = t.frequency;

		// DAILY always due today
		if (freq.mode === "daily") {
			t.nextOccurrence = formatDate(today);
			continue;
		}

		// If no nextOccurrence yet → compute initial one
		if (!t.nextOccurrence) {
			t.nextOccurrence = formatDate(calculateNextOccurrence(freq, t.lastUpdate || today));
			continue;
		}
		else if (t.nextOccurrence == "NaN-NaN-NaN") {
			debugger;
			t.nextOccurrence = null;
			t.lastUpdate = convertToShortDate(t.lastUpdate);
			t.nextOccurrence = formatDate(calculateNextOccurrence(freq, t.lastUpdate || today));
			continue;
		}


		let next = new Date(t.nextOccurrence);



		// If next >= today → okay
		if (next >= today) continue;

		// --- If tile done but its cycle is over, reset the flag ---
		if (t.done === true) {
			t.done = false;
		}


		// Otherwise roll forward until next >= today
		while (next < today) {
			next = calculateNextOccurrence(freq, next);
		}

		t.nextOccurrence = formatDate(next);
	}
}

function computeNextOccurrenceDisplay(tile) {
	if (!tile.nextOccurrence) return "";

	const today = toDateOnly(new Date());
	const next = toDateOnly(new Date(tile.nextOccurrence));

	const diff = Math.round((next - today) / (1000 * 60 * 60 * 24));

	if (diff === 0) return "today";
	if (diff === 1) return "tomorrow";
	if (diff > 1) return `in ${diff} days`;
	if (diff < 0) return `${Math.abs(diff)} days overdue`;
}

function nextOccurrenceDays(tile) {
	const freq = tile.frequency;

	// DAILY ALWAYS DUE TODAY
	if (freq && freq.mode === "daily") return 0;

	// If no date → do not show
	if (!tile.nextOccurrence) return 999;

	const today = toDateOnly(new Date());
	const next = toDateOnly(new Date(tile.nextOccurrence));

	return Math.round((next - today) / (1000 * 60 * 60 * 24));
}


/* control handler scripts */

// Click outside popup closes it
$(document).on("mousedown", function (e) {
	const popup = $("#popup");

	// if popup is not visible, do nothing
	if (!popup.is(":visible")) return;

	// if click is inside popup → ignore
	if ($(e.target).closest("#popup").length > 0) return;

	// otherwise → behave as cancel
	$("#cancelBtn").click();
});


// ESC closes popup
$(document).on("keydown", function (e) {
	if (e.key === "Escape") {
		if ($("#popup").is(":visible")) {
			$("#cancelBtn").click();
		}
	}
});

// ---- Cancel ----
$("#cancelBtn").on("click", function () {

	$("#popup").hide();
	$("#overlay").hide();
});

// Close when clicking outside
$(document).on("click", function (e) {
	if (!$(e.target).closest("#profileWrapper").length) {
		$("#profileMenu").hide();
	}
});

// Replace old login/logout buttons
$("#menuLoginBtn").on("click", () => $("#loginBtn").click());
$("#menuLogoutBtn").on("click", () => $("#logoutBtn").click());

/* filtering */
$(document).on("click", ".qfBtn", function () {
	$(".qfBtn").removeClass("active");
	$(this).addClass("active");

	const filter = $(this).data("filter");

	$(".tile").each(function () {
		let index = $(this).data("index");
		let freq = tiles[index].frequency;
		let days = nextOccurrenceDays(tiles[index]);


		if (filter === "all") {
			$(this).show();
		} else if (filter === "today" && days === 0) {
			$(this).show();
		} else if (filter === "tomorrow" && days === 1) {
			$(this).show();
		} else if (filter === 2 && days === 2) {
			$(this).show();
		} else if (filter === "3plus" && days >= 3) {
			$(this).show();
		} else {
			$(this).hide();
		}
	});
});


/* profile menu toggle */
$("#profileIcon").on("click", function () {
	$("#profileMenu").toggle();
});



/* document ready functions */
$(document).ready(function () {
	checkAuth();
	saveWorld();
});

/*tile drag & drop */
function initDragAndDrop() {
	if ('ontouchstart' in window) {
		// Disable drag on mobile
		return;
	}

	$(".tile").draggable({
		revert: "invalid",
		start: function () {
			$(this).css("z-index", 9999);
		},
		stop: function () {
			$(this).css("z-index", "");
		}
	});

	$(".tile").droppable({
		drop: function (event, ui) {
			let from = $(ui.draggable).data("index");
			let to = $(this).data("index");
			if (from === to) return;
			swapTiles(from, to);
			renderTiles();
		}
	});
}

function swapTiles(a, b) {
	let temp = tiles[a];
	tiles[a] = tiles[b];
	tiles[b] = temp;
	saveWorld();
}

function normalizeTile(i) {
	if (!tiles[i].logs) tiles[i].logs = [];

	tiles[i].logs = tiles[i].logs.map(l => {
		if (typeof l === "string") {
			return {
				text: l,
				date: tiles[i].lastUpdate || formatDate(new Date())
			};
		}
		if (typeof l === "object" && (!l.text || !l.date)) {
			return {
				text: l.text || "",
				date: l.date || formatDate(new Date())
			};
		}
		return l;
	});

	if (typeof tiles[i].done === "undefined") tiles[i].done = false;
	if (typeof tiles[i].skip === "undefined") tiles[i].skip = false;
}


// ---- Search ----
function applySearchFilter() {
	let q = $("#searchBox").val().toLowerCase().trim();
	if (q === "") {
		$(".tile").show();
		return;
	}

	for (let i = 0; i < TILE_COUNT; i++) {
		let t = tiles[i];
		let nameMatch = (t.name || "").toLowerCase().includes(q);
		let logsMatch = t.logs.some(log => log.text.toLowerCase().includes(q));

		if (nameMatch || logsMatch) {
			$(`.tile[data-index='${i}']`).show();
		} else {
			$(`.tile[data-index='${i}']`).hide();
		}
	}
}

$("#searchBox").on("keyup", function () {
	applySearchFilter();
});
