// A tiny, owned target for dogfooding the app-recon skill. No real secrets: the
// signing key is a fixture constant, and the data is made up. It exists only so
// a recon run has a known-correct answer (EXPECTED.md) to be graded against.
//
//   node scripts/e2e/recon-fixture/server.mjs [port]
//
// API:
//   POST /api/login   {user, pass}      -> {token}        mints a signed session token
//   GET  /api/feed    Authorization: Bearer <token>       -> {items: [...]}  (needs the token)
//   GET  /api/config  (no auth)                           -> {flags: {...}}
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

// Fixture constant, not a secret. The planted string FEED_RANKING_SALT below is
// the same idea on the client: a value the recon run is expected to surface.
const SIGNING_KEY = "recon-fixture-signing-key-not-a-secret";
const FEED_RANKING_SALT = "fixture-salt-7";

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", SIGNING_KEY).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = createHmac("sha256", SIGNING_KEY).update(body).digest("base64url");
  if (mac !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

// Local ranking the client is supposed to mirror (see client/bundle.js:
// makeHarderRanking). Kept server-side too so the auth-gated feed is deterministic.
function rankItems(items, user) {
  const seed = createHmac("sha256", FEED_RANKING_SALT).update(user).digest()[0];
  return [...items].sort((a, b) => ((a.id * seed) % 7) - ((b.id * seed) % 7));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const FEED = [
  { id: 1, title: "first post" },
  { id: 2, title: "second post" },
  { id: 3, title: "third post" },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/login") {
    const { user, pass } = await readJson(req);
    if (!user || !pass) return send(res, 400, { error: "user and pass required" });
    return send(res, 200, { token: sign({ user, iat: 1 }) });
  }
  if (req.method === "GET" && url.pathname === "/api/feed") {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const claims = verify(token);
    if (!claims) return send(res, 401, { error: "missing or invalid bearer token" });
    return send(res, 200, { items: rankItems(FEED, claims.user) });
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, { flags: { newRanking: true, maxItems: 50 } });
  }
  return send(res, 404, { error: "not found" });
});

// Port 0 lets the OS pick a free port (the runner reads the real one from this
// line), which avoids a clash with whatever else is on a fixed port. Default
// 8731 only when no port is given (0 is a valid, explicit request).
const port = process.argv[2] === undefined ? 8731 : Number(process.argv[2]);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`recon-fixture listening on http://127.0.0.1:${server.address().port}\n`);
});
