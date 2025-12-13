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

    // ---- time block rules ----
    if (
      t.tags.includes("spirituality") ||
      t.tags.includes("health") ||
      t.tags.includes("habit") ||
      t.tags.includes("home")
    ) {
      plan.morning.push(item);
    }
    else if (
      t.tags.includes("learning") ||
      t.tags.includes("work") ||
      t.tags.includes("outdoor")
    ) {
      plan.afternoon.push(item);
    }
    else {
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
  renderTodayPlanPopup();
});

$("#closeTodayPlan").on("click", function () {
  $("#todayPlanPopup").hide();
});

$(document).on("keydown", function (e) {
  if (e.key === "Escape") {
    $("#todayPlanPopup").hide();
  }
});
