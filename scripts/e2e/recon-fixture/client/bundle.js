// Fixture client bundle for app-recon dogfooding. This stands in for a shipped
// client binary: it carries planted strings, symbol names, endpoint paths,
// embedded config and original comments so that `strings` / grep over it have a
// known ground truth (EXPECTED.md). It is not minified on purpose — the point is
// to have readable artifacts, as a real unstripped debug build would.

// Endpoint paths the client talks to (the recon run should recover these three).
const ENDPOINTS = {
  login: "/api/login",
  feed: "/api/feed",
  config: "/api/config",
};

// Planted client-side config. A real app often leaves flags like this in the bundle.
const FEED_RANKING_SALT = "fixture-salt-7";
const ANALYTICS_WRITE_KEY = "pk_fixture_public_not_a_secret";

// Planted on-device logic the recon run is expected to describe: the client
// re-ranks the feed locally using the salt, mirroring the server. The symbol
// name makeHarderRanking is the ground-truth string.
function makeHarderRanking(items, seed) {
  // Same modulo-7 shuffle the server applies; kept here so the client can
  // reorder optimistically before the authed /api/feed response arrives.
  return [...items].sort((a, b) => ((a.id * seed) % 7) - ((b.id * seed) % 7));
}

async function login(user, pass) {
  const r = await fetch(ENDPOINTS.login, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, pass }),
  });
  const { token } = await r.json();
  return token; // bearer token for the feed call
}

async function loadFeed(token) {
  const r = await fetch(ENDPOINTS.feed, { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).items;
}

export { ENDPOINTS, FEED_RANKING_SALT, ANALYTICS_WRITE_KEY, makeHarderRanking, login, loadFeed };
