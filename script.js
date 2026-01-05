const TILE_COUNT = 128;
let currentUser = null;
let tiles = {};
let activeIndex = null;
const filters = {
    timeline: "today", // "today" | 1 | 2 | "3plus" | "all"
    status: null, // "done" | "skip" | "noaction" | null
    category: null // "arts", "health", etc | null
};


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
            tags: [],
            timeOfDay: []
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
                        },
                        done: false,
                        skip: false,
                        tags: [],
                        timeOfDay: []
                    };
                }
            }
            for (let i = 0; i < TILE_COUNT; i++) normalizeTile(i);
                dailyResetFlags();
        } catch(e) {
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
                    tags: [],
                    timeOfDay: []
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

    refreshNextOccurrences();
    renderTiles();
}


async function saveWorldToCloud() {
    if (!currentUser) return;

    // Check if all tiles are empty (no name and no logs)
    const allEmpty = Object.values(tiles).every(
        t => (!t.name || t.name.trim() === "") && (!t.logs || t.logs.length === 0)
    );
    if (allEmpty) {
        // Don't backup or overwrite cloud data if everything is empty
        return;
    }

    // 1. Fetch current data from worlds
    const { data: currentData, error: fetchError } = await supa
        .from("worlds")
        .select("data")
        .eq("user_id", currentUser.id)
        .single();

    // 2. Fetch last backup for this user
    let shouldBackup = false;
    if (currentData && currentData.data) {
        const { data: lastBackup, error: backupFetchError } = await supa
            .from("worlds_backup")
            .select("updated_at")
            .eq("user_id", currentUser.id)
            .order("updated_at", { ascending: false })
            .limit(1)
            .single();

        if (!lastBackup || !lastBackup.updated_at) {
            shouldBackup = true; // No backup exists
        } else {
            const lastBackupTime = new Date(lastBackup.updated_at).getTime();
            const now = Date.now();
            const diffMinutes = (now - lastBackupTime) / (1000 * 60);
            if (diffMinutes > 20) {
                shouldBackup = true;
            }
        }

        // Only backup if needed
        if (shouldBackup) {
            try {
                await supa
                    .from("worlds_backup")
                    .upsert({
                        user_id: currentUser.id,
                        data: currentData.data,
                        updated_at: new Date().toISOString()
                    }, {
                        onConflict: "user_id"
                    });
            } catch (backupError) {
                console.error("Backup failed:", backupError);
            }
        }
    }

    // 3. Save new data to main table
    const { error } = await supa
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

    // Apply soft vertical gradients instead of solid fills to keep visuals subtle
    if (count === 0) {
        $tile.css("background", "#F5F5F0"); // keep pale gray for empty
    } else if (count >= 1 && count <= 3) {
        $tile.css("background", "linear-gradient(to bottom, rgba(245,245,240,0.6), rgba(245,203,203,0.95))"); // pale -> soft pink
    } else if (count >= 4 && count <= 8) {
        $tile.css("background", "linear-gradient(to bottom, rgba(245,245,240,0.6), rgba(199,247,192,0.95))"); // pale -> soft green
    } else if (count >= 9 && count <= 15) {
        $tile.css("background", "linear-gradient(to bottom, rgba(245,245,240,0.6), rgba(182,217,255,0.95))"); // pale -> soft blue
    } else if (count > 15) {
        $tile.css("background", "linear-gradient(to bottom, rgba(250,208,196,0.75), rgba(255,154,158,0.95))"); // pale -> warm gradient for high counts
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
            const lastDoneLog = t.logs
                .filter(l => l.text === "done")
                .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

            lastUpdateText = lastDoneLog ?
                convertToShortDate(lastDoneLog.date) :
                "";

        }


        // Determine time of day icon
        const timeOfDay = t.timeOfDay && t.timeOfDay.length > 0 ? t.timeOfDay[0] : "evening";
        const timeIcon = timeOfDay === "morning" ? "🌅" : "🌙";
  let emoji = "";
        if (t.done) {
            emoji = "💪";
        } else if (t.skip) {
            emoji = "😢";
        } else {
            emoji = "💬";
        }

        $("#grid").append(`    
		  <div class="tile" data-index="${i}" style="display: flex; flex-direction: column; justify-content: space-between;">
			<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
			  <div class="tileName" style="flex: 1; word-wrap: break-word; overflow-wrap: break-word; margin-right: 8px; font-weight: bold;">${t.name || ""}</div>
			  <div style="font-size: 1.2em; flex-shrink: 0;">${timeIcon}</div>
			</div>
			<div>
			  <div class="tileCenter">
				<div class="tileNext" style="font-weight: bold; font-size: 1.1em; margin-bottom: 8px;">${nextText}</div>  
			  </div>
			  <div class="tileLast">${freqText}</div>
			</div>
			<div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 12px;">
			  <div style="display: flex; gap: 5px;">
					${emoji}
			  </div>
              <div>${lastUpdateText}</div>
			  <div class="tileCount" style="font-weight: bold;">(${(t.logs || []).filter(l => l.text === "done").length || "0"})</div>
			</div>
		  </div>
		`);

        updateTileColor(i);
    }

    initDragAndDrop();
    applyFilters();
    applySearchFilter();
    dailyResetFlags();
}

function openFirstEmptyTile() {
    for (let i = 0; i < TILE_COUNT; i++) {
        const t = tiles[i];
        if (!t.name && t.logs.length === 0) {
            $(`.tile[data-index='${i}']`).trigger("click");
            return;
        }
    }

    alert("No empty tiles left 😅");
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

function refreshHistoryDisplay() {
    if (activeIndex === null) return;

    let logs = [...tiles[activeIndex].logs].sort((a, b) => {
        return new Date(b.date) - new Date(a.date); // newest first
    });

    if (logs.length > 0) {
        $("#historyBox").html(
            logs.map((log, index) => {
                   let emoji = "";
                if (log.text === "done") {
                    emoji = "💪";
                } else if (log.text === "skipped") {
                    emoji = "😢";
                } else {
                    emoji = "💬";
                }

                return `
      <div class="historyItem" data-logindex="${index}" data-logdate="${log.date}" data-logtext="${log.text}">
        <div class="historyHeader">
          <div class="historyAction">
            ${emoji} ${log.text}
          </div>

          <div class="historyMeta">
            <span class="historyDate">${log.date}</span>
            <span class="historyActions">
              <span class="editLogBtn">edit</span>
              <span class="deleteLogBtn">delete</span>
            </span>
          </div>
        </div>

        <div class="historyDetails">
          ${log.note ? log.note : "<em>details goes here</em>"}
        </div>
      </div>
    `;
            }).join("")
        );
    } else {
        $("#historyBox").html("<div style='color:#888;'>No history yet</div>");
    }
}

// ---- Popup / tile click ----
$(document).on("click", ".tile", function() {
    // --- VIRTUAL EMPTY TILE ---
    if ($(this).hasClass("virtual-empty")) {
        openFirstEmptyTile();
        return;
    }

    // --- REAL TILE ---
    activeIndex = $(this).data("index");
    if (activeIndex === undefined) return;

    $("#tileTitle").text(tiles[activeIndex].name || "");

    $("#doneToggle").prop("checked", tiles[activeIndex].done === true);
    $("#skipToggle").prop("checked", tiles[activeIndex].skip === true);


    // HISTORY
    normalizeTile(activeIndex);
    refreshHistoryDisplay();

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

    // Load time of day preferences
    let selectedTimeOfDay = tiles[activeIndex].timeOfDay || [];
    $(".timeOfDayBtn").removeClass("active");
    selectedTimeOfDay.forEach(time => {
        $(`.timeOfDayBtn[data-time='${time}']`).addClass("active");
    });

    $("#overlay").show();
    $("#popup").show();

    if (!tiles[activeIndex].name) $("#tileNameInput").focus();

});

// ---- Frequency UI Handlers ----
$(document).on("change", "input[name='freqMode']", function() {
    const mode = this.value;

    if (mode === "daily") {
        $("#customDays").hide();
        $("#pickDateContainer").hide();
    } else if (mode === "custom") {
        $("#customDays").show();
        $("#pickDateContainer").hide();
    } else if (mode === "pickdate") {
        $("#customDays").hide();
        $("#pickDateContainer").show();
    }

    // Auto-save frequency change
    autoSaveTileChanges(false);
});


$(document).on("click", ".dayBtn", function() {
    $(this).toggleClass("active");
    // Auto-save when day selection changes
    autoSaveTileChanges(false);
});

$(document).on("click", ".tagOption", function() {
    $(this).toggleClass("active");
    // Auto-save when tags change
    autoSaveTileChanges(false);
});

$(document).on("click", ".timeOfDayBtn", function() {
    $(this).toggleClass("active");
    // Auto-save when time of day changes
    autoSaveTileChanges(false);
});

$(document).on("change", "#pickDateInput", function() {
    // Auto-save when pick date changes
    autoSaveTileChanges(false);
});

$(document).on("input", "#pickDateInput", function() {
    // Also listen to input event for better date picker compatibility
    autoSaveTileChanges(false);
});

$(document).on("change", "#doneToggle", function() {
    // Auto-save when done toggle changes
    autoSaveTileChanges(false);
    // Refresh history to show the new log entry
    refreshHistoryDisplay();
});

$(document).on("change", "#skipToggle", function() {
    // Auto-save when skip toggle changes
    autoSaveTileChanges(false);
    // Refresh history to show the new log entry
    refreshHistoryDisplay();
});

// Auto-save tile name on blur
$("#tileTitle").on("blur", function() {
    autoSaveTileChanges(false);
});


// TOGGLE SETTINGS MENU
$("#settingsIcon").on("click", function() {
    $("#settingsMenu").toggle();
    $("#profileMenu").hide(); // hide profile menu if open
});

// Close settings menu when clicking outside
$(document).on("click", function(e) {
    if (!$(e.target).closest("#profileWrapper").length) {
        $("#settingsMenu").hide();
    }
});


$("#openThemeSelector").on("click", function() {
    $("#themePopup").show();
    $("#settingsMenu").hide();
});

$("#closeThemePopup").on("click", function() {
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
$(document).on("click", ".themeOption", function() {
    let selected = $(this).data("theme");

    localStorage.setItem("lwp_theme", selected);
    applyTheme(selected);

    $("#themePopup").hide();
});



// ---- Auto-save helper function ----
function autoSaveTileChanges(closePopup = false) {
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
    // ==== SAVE FREQUENCY ====
    //*******************************
    let mode = $("input[name='freqMode']:checked").val();
    let days = [];
    let selectedDate = null;

    if (mode === "custom") {
        $(".dayBtn.active").each(function() {
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

    // ==== CALCULATE NEXT OCCURRENCE ====
    tiles[activeIndex].nextOccurrence = formatDate(
        calculateNextOccurrence(tiles[activeIndex].frequency, now)
    );

    // Save tags
    let newTags = [];
    $(".tagOption.active").each(function() {
        newTags.push($(this).data("tag"));
    });
    tiles[activeIndex].tags = newTags;

    // Save time of day
    let newTimeOfDay = [];
    $(".timeOfDayBtn.active").each(function() {
        newTimeOfDay.push($(this).data("time"));
    });
    tiles[activeIndex].timeOfDay = newTimeOfDay;

    saveWorld();
    renderTiles();


    if (closePopup) {
        $("#popup").hide();
        $("#overlay").hide();
        $("#historyBox").empty();
    }
}

// ---- Save ----
$("#saveBtn").on("click", function() {
    autoSaveTileChanges(true);
});

//filtering with a tag button
$(document).on("click", ".tagBtn", function() {
    const tag = $(this).data("tag");

    if (filters.category === tag) {
        filters.category = null;
        $(".tagBtn").removeClass("active");
    } else {
        filters.category = tag;
        $(".tagBtn").removeClass("active");
        $(this).addClass("active");
    }

    applyFilters();
});

function applyFilters() {
    $(".tile").each(function() {
        const index = $(this).data("index");
        const t = tiles[index];

        const isEmpty = !t || (!t.name && t.logs.length === 0);

        // Show empty tiles ONLY when everything is neutral
        const allowEmpty =
            filters.timeline === "all" &&
            filters.status === null &&
            filters.category === null;

        if (isEmpty) {
            if (allowEmpty) {
                $(this).removeClass("grayed-out").show();
            } else {
                $(this).addClass("grayed-out").show();
            }
            return;
        }

        // --- TIMELINE ---
        let days = nextOccurrenceDays(t);
        let timelineOk = true;

        if (filters.timeline === "today") timelineOk = (days === 0);
        else if (filters.timeline === 1) timelineOk = (days === 1);
        else if (filters.timeline === 2) timelineOk = (days === 2);
        else if (filters.timeline === "3plus") timelineOk = (days >= 3);

        // --- STATUS ---
        let statusOk = true;
        if (filters.status === "done") statusOk = t.done === true;
        else if (filters.status === "skip") statusOk = t.skip === true;
        else if (filters.status === "noaction") statusOk = !t.done && !t.skip;

        // --- CATEGORY ---
        let categoryOk = true;
        if (filters.category) {
            categoryOk = t.tags && t.tags.includes(filters.category);
        }

        // --- FINAL ---
        if (timelineOk && statusOk && categoryOk) {
            $(this).removeClass("grayed-out").show();
        } else {
            $(this).addClass("grayed-out").show();
        }
    });

    // --- Virtual empty tile in filtered view ---
    $(".virtual-empty").remove(); // safety

    if (isFilteredView()) {
        appendVirtualEmptyTile();
    }

}

function isFilteredView() {
    return (
        filters.timeline !== "all" ||
        filters.status !== null ||
        filters.category !== null ||
        $("#searchBox").val().trim() !== ""
    );
}

function appendVirtualEmptyTile() {
    $("#grid").append(`
    <div class="tile empty virtual-empty">
      <div class="plusIcon">+</div>
    </div>
  `);
}



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
        } else if (t.nextOccurrence == "NaN-NaN-NaN") {

            t.nextOccurrence = null;
            t.lastUpdate = convertToShortDate(t.lastUpdate);
            t.nextOccurrence = formatDate(calculateNextOccurrence(freq, t.lastUpdate || today));
            continue;
        }


        let next = new Date(t.nextOccurrence);



        // If next >= today → okay
        if (next >= today) continue;

        // --- If tile done but its cycle is over, reset the flag ---
        // Only reset if the task was done on a previous cycle (not today)
        if (t.done === true) {
            const lastDoneDate = t.lastUpdate ? toDateOnly(new Date(t.lastUpdate)) : null;
            const todayDateOnly = toDateOnly(today);
            if (!lastDoneDate || lastDoneDate.getTime() !== todayDateOnly.getTime()) {
                t.done = false;
            }
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

$(document).on("click", ".virtual-empty", function() {
    // find first real empty slot
    for (let i = 0; i < TILE_COUNT; i++) {
        const t = tiles[i];
        if (!t.name && t.logs.length === 0) {
            $(`.tile[data-index='${i}']`).trigger("click");
            break;
        }
    }
});


// Click outside popup closes it
$(document).on("mousedown", function(e) {
    const popup = $("#popup");

    // if popup is not visible, do nothing
    if (!popup.is(":visible")) return;

    // if click is inside popup → ignore
    if ($(e.target).closest("#popup").length > 0) return;

    // otherwise → behave as cancel
    $("#cancelBtn").click();
});


// ESC closes popup
$(document).on("keydown", function(e) {
    if (e.key === "Escape") {
        if ($("#popup").is(":visible")) {
            $("#cancelBtn").click();
        }
    }
});

// ---- Cancel ----
$("#cancelBtn").on("click", function() {

    $("#popup").hide();
    $("#overlay").hide();
});

// Close when clicking outside
$(document).on("click", function(e) {
    if (!$(e.target).closest("#profileWrapper").length) {
        $("#profileMenu").hide();
    }
});

// Replace old login/logout buttons
$("#menuLoginBtn").on("click", () => $("#loginBtn").click());
$("#menuLogoutBtn").on("click", () => $("#logoutBtn").click());

/* filtering */
$(document).on("click", ".tItem", function() {
    const clicked = $(this).data("filter");

    if (filters.timeline === clicked) {
        // deselect → fallback to all
        filters.timeline = "all";
    } else {
        filters.timeline = clicked;
    }

    // UI
    $(".tItem").removeClass("active");
    $(`.tItem[data-filter='${filters.timeline}']`).addClass("active");

    applyFilters();
});



/* profile menu toggle */
$("#profileIcon").on("click", function() {
    $("#profileMenu").toggle();
});

$(document).on("click", "#resetFlagsBtn", function() {
    resetAllFlags();
});

// ---- Filter: DONE tiles ----
function toggleStatusFilter(type, btn) {
    if (filters.status === type) {
        filters.status = null;
        $(".qfBtn").removeClass("active");
    } else {
        filters.status = type;
        $(".qfBtn").removeClass("active");
        $(btn).addClass("active");
    }
    applyFilters();
}

$("#filterDoneBtn").on("click", function() {
    toggleStatusFilter("done", this);
});

$("#filterSkippedBtn").on("click", function() {
    toggleStatusFilter("skip", this);
});

$("#filterNoActionBtn").on("click", function() {
    toggleStatusFilter("noaction", this);
});



$(document).on("click", "#deleteTileBtn", function() {
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

    // Reset all tiles for a new day ONLY if they have no "done" log from today
    for (let i = 0; i < TILE_COUNT; i++) {
        const todayStr = formatDate(new Date());

        // Check if tile was actually done today
        const donedToday = tiles[i].logs.some(log =>
            log.text === "done" &&
            convertToShortDate(log.date) === todayStr
        );

        // Check if tile was skipped today
        const skippedToday = tiles[i].logs.some(log =>
            log.text === "skipped" &&
            convertToShortDate(log.date) === todayStr
        );

        // Only reset if NOT done/skipped today
        if (!donedToday) tiles[i].done = false;
        if (!skippedToday) tiles[i].skip = false;
    }

    // Save world after reset
    saveWorld();

    // Mark today's reset as completed
    localStorage.setItem("lwp_last_reset", today);
}



/* document ready functions */
$(document).ready(function() {
    checkAuth();

    // NEW: Daily reset
    dailyResetFlags();

    saveWorld();
    $("#popup").css("display", "none");

    // Set "today" as active filter on page load
    $(`.tItem[data-filter='${filters.timeline}']`).addClass("active");
});

$(document).on("click", ".editLogBtn", function() {
    let card = $(this).closest(".historyItem");
    let logDate = card.data("logdate");
    let logText = card.data("logtext");

    // Find the actual log in the unsorted array by matching date and text
    let log = tiles[activeIndex].logs.find(l => l.date === logDate && l.text === logText);

    if (!log) return;

    let existingNote = log.note || "";
    let newNote = prompt("Add extra info for this action:", existingNote);

    // User cancelled
    if (newNote === null) return;

    // Save note (cannot modify done/skipped)
    log.note = newNote.trim();

    saveWorld();

    // Refresh history display without closing popup
    refreshHistoryDisplay();
});



/*tile drag & drop */
function initDragAndDrop() {
    if ('ontouchstart' in window) {
        // Disable drag on mobile
        return;
    }

    $(".tile").draggable({
        revert: "invalid",
        start: function() {
            $(this).css("z-index", 9999);
        },
        stop: function() {
            $(this).css("z-index", "");
        }
    });

    $(".tile").droppable({
        drop: function(event, ui) {
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
    if (!tiles[i].timeOfDay) tiles[i].timeOfDay = [];

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
        tags: [],
        timeOfDay: []
    };
}


function resetAllFlags() {
    for (let i = 0; i < TILE_COUNT; i++) {
        tiles[i].done = false;
        tiles[i].skip = false;
    }

    saveWorld(); // save to cloud or local depending on user
    renderTiles(); // refresh UI
}


// ---- Search ----
function applySearchFilter() {
    let q = $("#searchBox").val().toLowerCase().trim();
    if (q === "") {
        // Don't show all tiles - reapply filters instead
        applyFilters();
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

$("#searchBox").on("keyup", function() {
    applySearchFilter();
});

$(document).on("click", ".deleteLogBtn", function() {
    const logDate = $(this).closest(".historyItem").data("logdate");
    const logText = $(this).closest(".historyItem").data("logtext");

    const ok = confirm("Delete this history entry?");
    if (!ok) return;

    // Find and remove the log by matching date and text
    const indexToRemove = tiles[activeIndex].logs.findIndex(l => l.date === logDate && l.text === logText);
    if (indexToRemove !== -1) {
        tiles[activeIndex].logs.splice(indexToRemove, 1);
    }

    saveWorld();

    // Refresh history display without closing popup
    refreshHistoryDisplay();
});