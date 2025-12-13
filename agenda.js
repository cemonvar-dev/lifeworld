function buildTodaysAgenda() {
  const agenda = {
    morning: [],
    afternoon: [],
    evening: []
  };

  for (let i = 0; i < TILE_COUNT; i++) {
    const t = tiles[i];
    if (!t || !t.name) continue;

    // only TODAY
    if (nextOccurrenceDays(t) !== 0) continue;

    // only unactioned
    if (t.done || t.skip) continue;

    // ---- TIME BLOCK RULES ----
    if (
      t.tags.includes("spirituality") ||
      t.tags.includes("health") ||
      t.tags.includes("habit") ||
      t.tags.includes("home")
    ) {
      agenda.morning.push(t);
    }
    else if (
      t.tags.includes("learning") ||
      t.tags.includes("work") ||
      t.tags.includes("outdoor")
    ) {
      agenda.afternoon.push(t);
    }
    else if (
      t.tags.includes("hobby") ||
      t.tags.includes("arts") ||
      t.tags.includes("games") ||
      t.tags.includes("friends") ||
      t.tags.includes("family")
    ) {
      agenda.evening.push(t);
    }
    else {
      agenda.afternoon.push(t); // safe fallback
    }
  }

  return agenda;
}

function renderAgenda() {
  const agenda = buildTodaysAgenda();

  function block(title, items) {
    if (items.length === 0) return "";
    return `
      <div style="margin-bottom:16px;">
        <strong>${title}</strong>
        <ul style="margin-top:6px;">
          ${items.map(t => `<li>${t.name}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  const html =
    block("🌅 Morning", agenda.morning) +
    block("☀️ Afternoon", agenda.afternoon) +
    block("🌙 Evening", agenda.evening);

  if (!html) {
    $("#agendaBox").hide();
    return;
  }

  $("#agendaContent").html(html);
  $("#agendaBox").show();
}
