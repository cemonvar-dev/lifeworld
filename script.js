// ===== Supabase config =====
const SUPABASE_URL = "https://baswgycuhblyppvvdpay.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhc3dneWN1aGJseXBwdnZkcGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5MjEwMjEsImV4cCI6MjA3OTQ5NzAyMX0.ca23kyoMFHDcTvYRGEd8Dh32Y_3AoHj22-OFVxJZTMY";

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TILE_COUNT = 128;
let currentUser = null;
let tiles = {};
let activeIndex = null;

// ----- Utils -----
function initEmptyTiles() {
  tiles = {};
  for (let i = 0; i < TILE_COUNT; i++) {
    tiles[i] = {
      name: "",
      logs: [],
      lastUpdate: null,
      frequency: { mode: "daily", days: [] }   // NEW
    };
  }
}

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
            frequency: { mode: "daily", days: [] }
        };
    }
}


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


  async function loadWorldFromCloud() {
    if (!currentUser) return;

    const { data, error } = await supa
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
            frequency: { mode: "daily", days: [] }
        };
    }
	
    await saveWorldToCloud();
}

      // if something off, ensure structure
      if (!tiles || typeof tiles !== "object") {
        initEmptyTiles();
      }
    }
    renderTiles();
  }

  async function saveWorldToCloud() {
    if (!currentUser) return;
    const { error } = await supa
      .from("worlds")
      .upsert(
        { user_id: currentUser.id, data: tiles },
        { onConflict: "user_id" }
      );

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
	  $tile.css("background", "#F5F5F0");   // same pale gray as default
	}
    else if (count >= 1 && count <= 3) {
      $tile.css("background", "#F5CBCB"); // pastel pink
    }
    else if (count >= 4 && count <= 8) {
      $tile.css("background", "#c7f7c0"); // soft green
    }
    else if (count >= 9 && count <= 15) {
      $tile.css("background", "#b6d9ff"); // soft blue
    }
    else if (count > 15) {
      $tile.css("background", "linear-gradient(135deg, #ff9a9e, #fad0c4)");
    }
  }

 function renderTiles() {
  $("#grid").empty();

  for (let i = 0; i < TILE_COUNT; i++) {
    const t = tiles[i];

  if (!t.name && t.logs.length === 0) {
    $("#grid").append(`
        <div class="tile empty" data-index="${i}">
            <div class="plusIcon">+</div>
        </div>
    `);
    continue;
}

    const freqText = formatFrequency(t.frequency);
    const nextText = computeNextOccurrence(t.frequency);

   $("#grid").append(`    
  <div class="tile" data-index="${i}">
    
    <div class="tileTop">
      <div class="tileName">${t.name || ""}</div>
    </div>

    <div class="tileCenter">
      <div class="tileCount">${t.logs.length > 0 ? t.logs.length : ""}</div>
      <div class="tileNext">${nextText}</div>
    </div>

    <div class="tileFreq">${freqText}</div>
    <div class="tileLast">${t.lastUpdate || ""}</div>

  </div>
`);

    updateTileColor(i);
  }

  initDragAndDrop();
  applySearchFilter();
}


$(document).on("click", ".qfBtn", function() {
  $(".qfBtn").removeClass("active");
  $(this).addClass("active");

  const filter = $(this).data("filter");

  $(".tile").each(function() {
    let index = $(this).data("index");
    let freq = tiles[index].frequency;
    let days = nextOccurrenceDays(freq);

    if (filter === "all") {
      $(this).show();
    }
    else if (filter === "today" && days === 0) {
      $(this).show();
    }
    else if (filter === "tomorrow" && days === 1) {
      $(this).show();
    }
    else if (filter === "2" && days === 2) {
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



function formatFrequency(freq) {
  if (!freq) 
  {
	  freq= {mode:"",days:[]};
  }
  
  if (freq.mode === "daily") return "Daily";
  if (freq.mode === "weekly") return "Weekly";

  if (freq.mode === "custom") {
    if (!freq.days || freq.days.length === 0) return "Custom";
    return "Every " + freq.days.join(" & ");
  }

  return "";
}


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

  // Update just one tile UI (for future use if needed)
  function updateTileUI(i) {
    let t = tiles[i];
    let tile = $(`.tile[data-index='${i}']`);
    tile.find(".tileName").text(t.name || "");
    tile.find(".count").text(t.logs.length);
    tile.find(".timestamp").text(t.lastUpdate || "");
    updateTileColor(i);
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
      let logsMatch = t.logs.some(log => log.toLowerCase().includes(q));
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



// ---- Popup / tile click ----
$(document).on("click", ".tile", function() {
  activeIndex = $(this).data("index");

  $("#tileTitle").text(tiles[activeIndex].name || "Tile details");
  $("#entryText").val("");

  // HISTORY
  let logs = tiles[activeIndex].logs;
  if (logs.length > 0) {
    $("#historyBox").html(
      logs.map((item) => `
        <div class="timelineItem">
          <div class="timelineText">${item}</div>
          <div class="timelineDate">${tiles[activeIndex].lastUpdate || ""}</div>
        </div>
      `).join("")
    );
  } else {
    $("#historyBox").html("<div style='color:#888;'>No history yet</div>");
  }

  // ==== LOAD FREQUENCY INTO POPUP ====
  let freq = tiles[activeIndex].frequency || { mode:"daily", days:[] };

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
$(document).on("change", "input[name='freqMode']", function() {
  if (this.value === "custom") $("#customDays").show();
  else $("#customDays").hide();
});

$(document).on("click", ".dayBtn", function() {
  $(this).toggleClass("active");
});

// ---- Save ----
$("#saveBtn").on("click", function() {
  if (activeIndex === null) return;

  let name = $("#tileTitle").text().trim();
  tiles[activeIndex].name = name;

  let txt  = $("#entryText").val().trim();
  if (txt.length > 0) tiles[activeIndex].logs.push(txt);

  let now = new Date().toLocaleString();
  tiles[activeIndex].lastUpdate = now;

  // ==== SAVE FREQUENCY ====
  let mode = $("input[name='freqMode']:checked").val();
  let days = [];

  if (mode === "custom") {
    $(".dayBtn.active").each(function() {
      days.push($(this).data("day"));
    });
  }

  tiles[activeIndex].frequency = { mode, days };

  saveWorld();
  renderTiles();

  $("#popup").hide();
  $("#overlay").hide();
  $("#historyBox").empty();
});

// ---- Cancel ----
$("#cancelBtn").on("click", function() {
  $("#popup").hide();
  $("#overlay").hide();
});


// ---- Auth ----
  async function checkAuth() {
    const { data } = await supa.auth.getUser();
    if (data.user) {
      currentUser = data.user;
      $("#userInfo").text(`Logged in as ${currentUser.email}`);
      $("#loginBtn").hide();
      $("#logoutBtn").show();
      await loadWorldFromCloud();
    } else {
      currentUser = null;
      $("#userInfo").text("Not logged in (using local storage)");
      $("#loginBtn").show();
      $("#logoutBtn").hide();
      loadWorldFromLocal();
      renderTiles();
    }
  }

  $("#loginBtn").on("click", async () => {
    const { error } = await supa.auth.signInWithOAuth({
      provider: "google"
    });
    if (error) {
      console.error(error);
      alert("Login failed");
    }
  });

  $("#logoutBtn").on("click", async () => {
    await supa.auth.signOut();
    currentUser = null;
    loadWorldFromLocal();
    renderTiles();
    checkAuth();
  });

  supa.auth.onAuthStateChange((_event, _session) => {
    checkAuth();
  });

  // ---- Init ----
  $(document).ready(function() {
    checkAuth();
  });
  
  
  // PROFILE MENU TOGGLE
$("#profileIcon").on("click", function () {
  $("#profileMenu").toggle();
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

// Update profile UI on auth change
function updateProfileUI() {
  if (currentUser) {
    $("#profileEmail").text(currentUser.email);
    $("#menuLoginBtn").hide();
    $("#menuLogoutBtn").show();
  } else {
    $("#profileEmail").text("Guest");
    $("#menuLoginBtn").show();
    $("#menuLogoutBtn").hide();
  }
}

// Hook into your existing checkAuth()
const originalCheck = checkAuth;
checkAuth = async function() {
  await originalCheck();
  updateProfileUI();
};

// ESC closes popup
$(document).on("keydown", function (e) {
  if (e.key === "Escape") {
    if ($("#popup").is(":visible")) {
      $("#cancelBtn").click();
    }
  }
});

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


function computeNextOccurrence(freq) {
  const today = new Date();
  const todayIndex = today.getDay(); // Sun=0 ... Sat=6

  const map = {
    "Mon": 1,
    "Tue": 2,
    "Wed": 3,
    "Thu": 4,
    "Fri": 5,
    "Sat": 6,
    "Sun": 0
  };
  
  if (!freq) 
  {
	  freq= {mode:"",days:[]};
  } 
  

  if (freq.mode === "daily") {
    return "today";
  }

  if (freq.mode === "weekly") {
    return "in 7 days";
  }

  if (freq.mode === "custom" && freq.days.length > 0) {
    let minDiff = 999;

    freq.days.forEach(d => {
      let target = map[d];
      let diff = (target - todayIndex + 7) % 7;
      if (diff === 0) diff = 7;
      if (diff < minDiff) minDiff = diff;
    });

    if (minDiff === 1) return "tomorrow";
    if (minDiff === 0) return "today";
    return `${minDiff} days later`;
  }

  return "";
}

function nextOccurrenceDays(freq) {
  // same logic as computeNextOccurrence but returns the raw day count
  const today = new Date();
  const todayIndex = today.getDay();

  const map = {
    "Mon": 1,
    "Tue": 2,
    "Wed": 3,
    "Thu": 4,
    "Fri": 5,
    "Sat": 6,
    "Sun": 0
  };

  if (!freq) return 999;

  if (freq.mode === "daily") return 0;
  if (freq.mode === "weekly") return 7;

  if (freq.mode === "custom" && freq.days.length > 0) {
    let minDiff = 999;

    freq.days.forEach(d => {
      let target = map[d];
      let diff = (target - todayIndex + 7) % 7;
      if (diff === 0) diff = 7;
      if (diff < minDiff) minDiff = diff;
    });

    return minDiff;
  }

  return 999;
}
