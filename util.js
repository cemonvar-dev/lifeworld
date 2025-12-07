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

    // --- CASE 1: ISO with T ---
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const d = new Date(str);
        if (isNaN(d)) return "";
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }

    // --- CASE 2: ISO short (YYYY-MM-DD or YYYY-MM-DD HH:mm[:ss]) ---
    if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/.test(str)) {
        return str.split(" ")[0]; // always extract pure date
    }

    // --- Otherwise normalize separators (e.g. DD.MM.YYYY) ---
    let s = str.replace(/\./g, "/");
    s = s.split(",")[0].split(" ")[0].trim();

    const parts = s.split("/");
    if (parts.length !== 3) return "";

    const [day, month, year] = parts;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}


function toDateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDateTime(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");

    return `${year}-${month}-${day} ${hour}:${min}`;
}
