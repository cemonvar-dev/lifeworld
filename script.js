// ===== Supabase config =====
const SUPABASE_URL = "https://baswgycuhblyppvvdpay.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhc3dneWN1aGJseXBwdnZkcGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5MjEwMjEsImV4cCI6MjA3OTQ5NzAyMX0.ca23kyoMFHDcTvYRGEd8Dh32Y_3AoHj22-OFVxJZTMY";

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TILE_COUNT = 64;
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

      // Ensure frequency exists for old users
      for (let i = 0; i < TILE_COUNT; i++) {
        if (!tiles[i].frequency) {
          tiles[i].frequency = { mode: "daily", days: [] };
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

// ... (cloud load/save unchanged except frequency safety) ...

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

