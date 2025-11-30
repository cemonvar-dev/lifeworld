// ----- Utils -----
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function convertToShortDate(str) {
    if (!str) return "";

    // Normalize separators: replace dots with slashes
    let s = str.replace(/\./g, "/");

    // Remove time part (anything after space or comma)
    s = s.split(",")[0].split(" ")[0].trim();

    // Now expected: "DD/MM/YYYY"
    const parts = s.split("/");

    if (parts.length !== 3) return "";

    const [day, month, year] = parts;

    if (!day || !month || !year) return "";

    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
