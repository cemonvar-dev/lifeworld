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
				days: [],
				date: null
			},
			done: false,
			skip: false,
			tags: []
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
							days: [],
							date: null
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
		//await saveWorldToCloud();
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
						days: [],
						date: null
					},
					done: false,
					skip: false,
					tags: []
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
		let lastUpdateText = "";
		if (t.logs && t.logs.length > 0) {
			// newest = log with max date
			let newest = t.logs.reduce((a, b) =>
				new Date(a.date) > new Date(b.date) ? a : b
			);
			lastUpdateText = convertToShortDate(newest.date);
		}


		$("#grid").append(`    
		  <div class="tile" data-index="${i}">
			<div class="tileTop">
			  <div class="tileName">${t.name || ""}</div>
			</div>
			<div class="tileCenter">
			  <div class="tileCount">${t.logs.filter(l => l.text === "done").length || "-"}</div>  
			  <div class="tileNext">${nextText}</div>
			</div>
			<div class="tileLast">${freqText}</div>
			<div class="tileLast">
   				 ${t.skip ? "😢 skipped" : ""}
			</div>
			<div class="tileLast">${t.done ? "💪 done" : ""}</div>
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

	$("#tileTitle").text(tiles[activeIndex].name || "");

	$("#doneToggle").prop("checked", tiles[activeIndex].done === true);
	$("#skipToggle").prop("checked", tiles[activeIndex].skip === true);


	// HISTORY
	normalizeTile(activeIndex);
	let logs = [...tiles[activeIndex].logs].sort((a, b) => {
		return new Date(b.date) - new Date(a.date);  // NEW: newest first
	});

	if (logs.length > 0) {
		$("#historyBox").html(
    logs.map((log, index) => {
        let emoji = log.text === "done" ? "💪" :
                    log.text === "skipped" ? "😢" : "💬";

        return `
        <div class="historyCard" data-logindex="${index}">
            <div class="logAction">${emoji} ${log.text}</div>
            <div class="logDate">${log.date}</div>
            ${log.note ? `<div class="logNote">${log.note}</div>` : ""}
            <div class="editLogBtn">✏️</div>
        </div>`;
    }).join("")
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
	if (freq.mode === "pickdate") {
		$("#pickDateContainer").show();
		$("#pickDateInput").val(freq.date || "");
	} else {
		$("#pickDateContainer").hide();
	}


	if (freq.mode === "custom") $("#customDays").show();
	else $("#customDays").hide();

	$(".dayBtn").removeClass("active");
	freq.days.forEach(d => {
		$(`.dayBtn[data-day='${d}']`).addClass("active");
	});

	const allTags = [
		"health", "work", "learning", "habit", "home",
		"spirituality", "hobby", "games", "outdoor",
		"family", "friends", "arts", "cooking"
	].sort();

	let selected = tiles[activeIndex].tags || [];

	$("#tagSelectorButtons").html(
		allTags.map(t => `
        <div class="tagOption ${selected.includes(t) ? "active" : ""}" data-tag="${t}">
            ${t}
        </div>
    `).join("")
	);


	$("#overlay").show();
	$("#popup").show();

	if (!tiles[activeIndex].name) $("#tileNameInput").focus();

});

// ---- Frequency UI Handlers ----
$(document).on("change", "input[name='freqMode']", function () {
	const mode = this.value;

	if (mode === "daily") {
		$("#customDays").hide();
		$("#pickDateContainer").hide();
	}
	else if (mode === "custom") {
		$("#customDays").show();
		$("#pickDateContainer").hide();
	}
	else if (mode === "pickdate") {
		$("#customDays").hide();
		$("#pickDateContainer").show();
	}
});


$(document).on("click", ".dayBtn", function () {
	$(this).toggleClass("active");
});

$(document).on("click", ".tagOption", function () {
	$(this).toggleClass("active");
});


// TOGGLE SETTINGS MENU
$("#settingsIcon").on("click", function () {
    $("#settingsMenu").toggle();
    $("#profileMenu").hide(); // hide profile menu if open
});

// Close settings menu when clicking outside
$(document).on("click", function (e) {
    if (!$(e.target).closest("#profileWrapper").length) {
        $("#settingsMenu").hide();
    }
});


$("#openThemeSelector").on("click", function () {
    $("#themePopup").show();
    $("#settingsMenu").hide();
});

$("#closeThemePopup").on("click", function () {
    $("#themePopup").hide();
});


// Apply theme immediately
function applyTheme(theme) {
    $("body").attr("data-theme", theme);
}

// Load theme from localStorage
let savedTheme = localStorage.getItem("lwp_theme") || "light";
applyTheme(savedTheme);

// When selecting a theme
$(document).on("click", ".themeOption", function () {
    let selected = $(this).data("theme");

    localStorage.setItem("lwp_theme", selected);
    applyTheme(selected);

    $("#themePopup").hide();
});



// ---- Save ----
$("#saveBtn").on("click", function () {
	if (activeIndex === null) return;

	let name = $("#tileTitle").text().trim();
	tiles[activeIndex].name = name;

	let now = new Date();
	let formattedNow = formatDateTime(now);

	const logsToAdd = [];

	// Read toggles
	let doneChecked = $("#doneToggle").is(":checked");
	let skipChecked = $("#skipToggle").is(":checked");

	// skip cancels done
	if (skipChecked) doneChecked = false;

	const todayStr = formatDate(new Date());

	// detect done today
	let alreadyDoneToday = tiles[activeIndex].logs.some(log =>
		log.text === "done" &&
		convertToShortDate(log.date) === todayStr
	);

	// detect skipped today
	let alreadySkippedToday = tiles[activeIndex].logs.some(log =>
		log.text === "skipped" &&
		convertToShortDate(log.date) === todayStr
	);

	// prevent duplicate done
	if (doneChecked && alreadyDoneToday) {
		doneChecked = false;
	}

	// prevent duplicate skipped
	if (skipChecked && alreadySkippedToday) {
		skipChecked = false;
	}

	// set done state
	tiles[activeIndex].done = alreadyDoneToday || doneChecked;

	// set skip state
	tiles[activeIndex].skip = alreadySkippedToday || skipChecked;

	// done overrides skip
	if (tiles[activeIndex].done) {
		tiles[activeIndex].skip = false;
	}

	// push logs
	if (doneChecked) logsToAdd.push("done");
	if (skipChecked) logsToAdd.push("skipped");

	logsToAdd.forEach(t => {
		tiles[activeIndex].logs.push({
			text: t,
			date: formattedNow
		});
	});

// Update lastUpdate ONLY when done is added
if (doneChecked) {
    tiles[activeIndex].lastUpdate = formatDate(now);
}

	//*******************************
	// ==== SAVE FREQUENCY FIRST ====
	//*******************************
	let mode = $("input[name='freqMode']:checked").val();
	let days = [];
	let selectedDate = null;

	if (mode === "custom") {
		$(".dayBtn.active").each(function () {
			days.push($(this).data("day"));
		});
	}

	if (mode === "pickdate") {
		selectedDate = $("#pickDateInput").val();
	}

	tiles[activeIndex].frequency = {
		mode,
		days,
		date: selectedDate
	};


	// ==== THEN CALCULATE NEXT OCCURRENCE ====
	tiles[activeIndex].nextOccurrence = formatDate(
		calculateNextOccurrence(tiles[activeIndex].frequency, now)
	);


	// Save tags
	let newTags = [];
	$(".tagOption.active").each(function () {
		newTags.push($(this).data("tag"));
	});
	tiles[activeIndex].tags = newTags;



	saveWorld();
	renderTiles();

	$("#popup").hide();
	$("#overlay").hide();
	$("#historyBox").empty();
});

//filtering with a tag button
$(document).on("click", ".tagBtn", function () {
	$(".tagBtn").removeClass("active");
	$(this).addClass("active");

	let tag = $(this).data("tag");

	$(".tile").each(function () {
		let index = $(this).data("index");
		let t = tiles[index];

		if (!t.tags || t.tags.length === 0) {
			$(this).hide();
			return;
		}

		if (t.tags.includes(tag)) {
			$(this).show();
		} else {
			$(this).hide();
		}
	});
});


/* frequency calculations */
function formatFrequency(freq) {
	if (!freq) freq = {
		mode: "",
		days: [],
		date: null
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

		case "pickdate":
			if (freq.date) {
				const d = new Date(freq.date);
				if (d < new Date()) {
					// always move to NEXT YEAR same date
					d.setFullYear(d.getFullYear() + 1);
				}
				return d;
			}
			return null;


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
$(document).on("click", ".tItem", function () {
	$(".tItem").removeClass("active");
	$(this).addClass("active");

	const filter = $(this).data("filter");

	$(".tile").each(function () {
		let index = $(this).data("index");
		let days = nextOccurrenceDays(tiles[index]);

		if (filter === "all") {
			$(this).show();
		}
		else if (filter === "today" && days === 0) {
			$(this).show();
		}
		else if (filter === 1 && days === 1) {
			$(this).show();
		}
		else if (filter == 2 && days === 2) {
			$(this).show();
		}
		else if (filter === "3plus" && days >= 3) {
			$(this).show();
		}
		else {
			$(this).hide();
		}
	});
});


/* profile menu toggle */
$("#profileIcon").on("click", function () {
	$("#profileMenu").toggle();
});

$(document).on("click", "#resetFlagsBtn", function () {
	resetAllFlags();
});

// ---- Filter: DONE tiles ----
$(document).on("click", "#filterDoneBtn", function () {
	$(".qfBtn").removeClass("active");
	$(this).addClass("active");

	$(".tile").each(function () {
		let index = $(this).data("index");
		let t = tiles[index];

		if (!t || !t.name) {
			$(this).hide();
			return;
		}

		if (t.done === true) $(this).show();
		else $(this).hide();
	});
});

// ---- Filter: SKIPPED tiles ----
$(document).on("click", "#filterSkippedBtn", function () {
	$(".qfBtn").removeClass("active");
	$(this).addClass("active");

	$(".tile").each(function () {
		let index = $(this).data("index");
		let t = tiles[index];

		if (!t || !t.name) {
			$(this).hide();
			return;
		}

		if (t.skip === true) $(this).show();
		else $(this).hide();
	});
});

// ---- Filter: NO ACTION tiles ----
$(document).on("click", "#filterNoActionBtn", function () {
	$(".qfBtn").removeClass("active");
	$(this).addClass("active");

	$(".tile").each(function () {
		let index = $(this).data("index");
		let t = tiles[index];

		if (!t || !t.name) {
			$(this).hide();
			return;
		}

		// No done + no skip
		if (!t.done && !t.skip) $(this).show();
		else $(this).hide();
	});
});


$(document).on("click", "#deleteTileBtn", function () {
	if (activeIndex === null) return;

	const confirmed = confirm("Are you sure you want to delete this tile? All history will be removed.");
	if (!confirmed) return;

	resetTile(activeIndex);
	saveWorld();
	renderTiles();

	$("#popup").hide();
	$("#overlay").hide();
});

function dailyResetFlags() {
    const today = formatDate(new Date());
    const lastReset = localStorage.getItem("lwp_last_reset");

    // Already reset today → do nothing
    if (lastReset === today) return;

    // Reset all tiles for a new day
    for (let i = 0; i < TILE_COUNT; i++) {
        tiles[i].done = false;
        tiles[i].skip = false;
    }

    // Save world after reset
    saveWorld();

    // Mark today's reset as completed
    localStorage.setItem("lwp_last_reset", today);
}



/* document ready functions */
$(document).ready(function () {
    checkAuth();

    // NEW: Daily reset
    dailyResetFlags();

    saveWorld();
    $("#popup").css("display", "none");
});

$(document).on("click", ".editLogBtn", function() {
    let card = $(this).closest(".historyCard");
    let logIndex = card.data("logindex");
    let log = tiles[activeIndex].logs[logIndex];

    let existingNote = log.note || "";
    let newNote = prompt("Add extra info for this action:", existingNote);

    // User cancelled
    if (newNote === null) return;

    // Save note (cannot modify done/skipped)
    log.note = newNote.trim();

    saveWorld();
    renderTiles();

    // Reload popup history instantly
    $(document).trigger("click", `.tile[data-index='${activeIndex}']`);
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
	if (!tiles[i].tags) tiles[i].tags = [];

}

function resetTile(i) {
	tiles[i] = {
		name: "",
		logs: [],
		lastUpdate: null,
		nextOccurrence: null,
		frequency: {
			mode: "daily",
			days: [],
			date: null
		},
		done: false,
		skip: false,
		tags: []
	};
}


function resetAllFlags() {
	for (let i = 0; i < TILE_COUNT; i++) {
		tiles[i].done = false;
		tiles[i].skip = false;
	}

	saveWorld();   // save to cloud or local depending on user
	renderTiles(); // refresh UI
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
