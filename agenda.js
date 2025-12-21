function buildTodaysPlan() {
  const plan = {
    morning: [],
    afternoon: [],
    evening: []
  };

  for (let i = 0; i < TILE_COUNT; i++) {
    const t = tiles[i];
    if (!t || !t.name) continue;

    // only TODAY
    if (nextOccurrenceDays(t) !== 0) continue;

    // determine status
    let status = "pending";
    if (t.done) status = "done";
    else if (t.skip) status = "skipped";

    const item = {
      name: t.name,
      status
    };

    // ---- time of day preference ----
    let timeOfDay = t.timeOfDay && t.timeOfDay.length > 0 ? t.timeOfDay[0] : "evening";
    
    if (timeOfDay === "morning") {
      plan.morning.push(item);
    }
    else if (timeOfDay === "evening") {
      plan.evening.push(item);
    }
    else {
      // default to evening if undefined
      plan.evening.push(item);
    }
  }

  return plan;
}

function renderTodayPlanPopup() {
  const plan = buildTodaysPlan();

  function block(title, items) {
    if (items.length === 0) return "";
    return `
      <div class="planBlock">
        <strong>${title}</strong>
        ${items.map(i => `
          <div class="planItem ${i.status}">
            <div class="planStatus">
              ${i.status === "done" ? "💪" : i.status === "skipped" ? "😢" : "⏳"}
            </div>
            <div>${i.name}</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  const html =
    block("🌅 Morning", plan.morning) +
    block("☀️ Afternoon", plan.afternoon) +
    block("🌙 Evening", plan.evening);

  $("#todayPlanContent").html(html || "<div>No tasks for today 🎉</div>");
  $("#todayPlanPopup").show();
}


 
$("#showAgendaBtn").on("click", function () {
  // Set filter to "today"
  filters.timeline = "today";
  
  // Update UI to show "today" as active
  $(".tItem").removeClass("active");
  $(`.tItem[data-filter='today']`).addClass("active");
  
  // Apply filters to main grid
  applyFilters();
  
  // Render the today plan popup
  renderTodayPlanPopup();
});

$("#closeTodayPlan").on("click", function () {
  $("#todayPlanPopup").hide();
});

// Close when clicking outside the popup
$(document).on("click", function (e) {
  if ($("#todayPlanPopup").is(":visible") && 
      !$(e.target).closest("#todayPlanPopup").length) {
    $("#todayPlanPopup").hide();
  }
});

$(document).on("keydown", function (e) {
  if (e.key === "Escape") {
    $("#todayPlanPopup").hide();
  }
});
