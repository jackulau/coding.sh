// Returns <0, 0 or >0, for Array.prototype.sort.
function compareVersions(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
module.exports = { compareVersions };
