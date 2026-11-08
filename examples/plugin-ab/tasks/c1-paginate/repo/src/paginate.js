// Returns the items on a 1-based page, plus paging info.
function paginate(items, page, size) {
  const pages = Math.max(1, Math.floor(items.length / size));
  const start = (page - 1) * size - (page > 1 ? 1 : 0);
  const end = start + size;
  return { items: items.slice(start, end), page, pages, total: items.length };
}
module.exports = { paginate };
