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

    // --- CASE 1: ISO format ---
    // Example: 2025-11-30T14:48:16.529Z
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const d = new Date(str);
        if (isNaN(d)) return "";
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }

    // --- Otherwise normalize separators ---
    // Convert "28.11.2025" → "28/11/2025"
    let s = str.replace(/\./g, "/");

    // Remove time part (anything after space or comma)
    s = s.split(",")[0].split(" ")[0].trim();

    // Expected now: DD/MM/YYYY
    const parts = s.split("/");
    if (parts.length !== 3) return "";

    const [day, month, year] = parts;

    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function toDateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
