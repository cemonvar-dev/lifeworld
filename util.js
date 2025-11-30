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
    // Expected format: "DD/MM/YYYY, HH:MM:SS"
    if (!str) return "";

    // Split date and time
    const parts = str.split(",");
    if (parts.length < 1) return "";

    const datePart = parts[0].trim(); // "29/11/2025"

    const [day, month, year] = datePart.split("/");

    if (!day || !month || !year) return "";

    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
