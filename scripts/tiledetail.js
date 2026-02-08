function editLog () {
    let card = $(this).closest(".historyItem");
    let logDate = card.data("logdate");
    let logText = card.data("logtext");

    // Find the actual log in the unsorted array by matching date and text
    let log = tiles[activeIndex].logs.find(l => l.date === logDate && l.text === logText);

    if (!log) return;

    let existingNote = log.note || "";
    showEditNoteModal(existingNote, function (newNote) {
        if (typeof newNote !== "string") return;
        log.note = newNote.trim();
        saveWorld();
        refreshHistoryDisplay();
    })
}

function deleteTile () {
    if (activeIndex === null) return;

    const confirmed = confirm("Are you sure you want to delete this tile? All history will be removed.");
    if (!confirmed) return;

    resetTile(activeIndex);
    saveWorld();
    renderTiles();

    $("#popup").hide();
    $("#overlay").hide();
}

// Custom modal for editing log note with textarea
function showEditNoteModal(existingNote, onSave) {
    // Add ESC key handler to close modal
    function escHandler(e) {
        if (e.key === "Escape") {
            $("#editNoteModalOverlay").remove();
            $(document).off("keydown", escHandler);
        }
    }
    $(document).on("keydown", escHandler);
    // Remove any existing modal
    $("#editNoteModalOverlay").remove();

    const modalHtml = `
            <div id="editNoteModalOverlay" style="position:fixed;z-index:99999;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;">
                <div id="editNoteModal" style="background:#f3f3f3;padding:24px 20px 18px 20px;border-radius:18px;box-shadow:0 8px 40px rgba(0,0,0,.18);min-width:320px;max-width:90vw;">
                    <div style="font-weight:700;font-size:16px;margin-bottom:10px;color:#222;">Edit Note</div>
                    <textarea id="editNoteTextarea" style="width:260px;min-width:0;max-width:100%;min-height:80px;max-height:200px;padding:10px 12px;border-radius:12px;border:1px solid #bbb;background:#fff;color:#222;font-size:15px;resize:vertical;">${existingNote.replace(/</g, "&lt;")}</textarea>
                    <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end;">
                        <button id="editNoteCancelBtn" style="padding:8px 16px;border-radius:10px;border:none;background:#eee;color:#444;font-weight:600;">Cancel</button>
                        <button id="editNoteSaveBtn" style="padding:8px 16px;border-radius:10px;border:none;background:#72e3ff;color:#181c2a;font-weight:700;">Save</button>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    $("#editNoteCancelBtn").on("click", function () {
        $("#editNoteModalOverlay").remove();
    });
    $("#editNoteModalOverlay").on("click", function (e) {
        if (e.target === this) $("#editNoteModalOverlay").remove();
    });
    $("#editNoteSaveBtn").on("click", function () {
        const val = $("#editNoteTextarea").val();
        $("#editNoteModalOverlay").remove();
        onSave(val);
    });
    $("#editNoteTextarea").focus();
}

function completeTile() {
    if (activeIndex === null) return;
    tiles[activeIndex].completed = true;
    // Add a log entry for completed if not already completed today
    const today = new Date().toISOString().slice(0, 10);
    const alreadyLogged = (tiles[activeIndex].logs || []).some(log => log.text === "completed" && log.date && log.date.slice(0, 10) === today);
    if (!alreadyLogged) {
        tiles[activeIndex].logs = tiles[activeIndex].logs || [];
        tiles[activeIndex].logs.push({ text: "completed", date: new Date().toISOString() });
    }
    autoSaveTileChanges(true);
    setTimeout(function () { renderTiles(); }, 10);
}

function setTileAsHeader() {
    debugger;
    if (activeIndex === null) return;
    // Toggle header state
    tiles[activeIndex].header = !tiles[activeIndex].header;
    // Update button UI
    if (tiles[activeIndex].header) {
        $(this).addClass("active").text("✅ Header");
    } else {
        $(this).removeClass("active").text("🏷️ Set as Header");
    }
    autoSaveTileChanges(false);
    setTimeout(function () { renderTiles(); }, 10);
}