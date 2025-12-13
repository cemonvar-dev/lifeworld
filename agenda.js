function buildTodaysAgenda() {
  const agenda = {
    must: [],
    should: [],
    optional: []
  };

  for (let i = 0; i < TILE_COUNT; i++) {
    const t = tiles[i];
    if (!t || !t.name) continue;

    // only TODAY
    if (nextOccurrenceDays(t) !== 0) continue;

    // only unactioned
    if (t.done || t.skip) continue;

    // ---- simple priority rules (MVP) ----
    if (t.tags.includes("health") || t.tags.includes("spirituality")) {
      agenda.must.push(t);
    }
    else if (
      t.tags.includes("learning") ||
      t.tags.includes("family") ||
      t.tags.includes("friends")
    ) {
      agenda.should.push(t);
    }
    else {
      agenda.optional.push(t);
    }
  }

  return agenda;
}function renderAgenda() {
  const agenda = buildTodaysAgenda();

  function section(title, items) {
    if (items.length === 0) return "";
    return `
      <div style="margin-bottom:12px;">
        <strong>${title}</strong>
        <ul>
          ${items.map(t => `<li>${t.name}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  const html =
    section("Must do", agenda.must) +
    section("Should do", agenda.should) +
    section("Optional", agenda.optional);

  if (!html) {
    $("#agendaBox").hide();
    return;
  }

  $("#agendaContent").html(html);
  $("#agendaBox").show();
}

$("#showAgendaBtn").on("click", function () {
  renderAgenda();
});

