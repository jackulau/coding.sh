// Groups ISO timestamps (UTC, from the API) by calendar day for the daily report.
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function groupByDay(isoList) {
  const out = {};
  for (const iso of isoList) (out[dayKey(iso)] ??= []).push(iso);
  return out;
}
module.exports = { dayKey, groupByDay };
