// Duration helpers.
function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}
module.exports = { formatDuration };
