const cache = new Map();

function makeGetUser(fetchUser) {
  return async function getUser(id) {
    if (cache.has(id)) return cache.get(id);
    const user = await fetchUser(id);
    cache.set(id, user);
    return user;
  };
}

function clearCache() {
  cache.clear();
}

module.exports = { makeGetUser, clearCache };
