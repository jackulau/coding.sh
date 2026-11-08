// Continuous reference run for the app-recon dogfood. Boots the fixture on a
// free port, performs the recon mechanically (drive the API, read the client
// bundle), writes a report, and grades it with verify.mjs. It also runs the
// negative control (an empty report must fail), so a loosened verifier is
// caught. Exits 0 only when every assertion holds.
//
//   node scripts/e2e/recon-fixture/run.mjs
//
// This exercises the fixture + verifier loop, not a live agent's reasoning —
// that needs the skill installed and a model (see README.md). CI runs this to
// keep the harness green on every fixture or verifier edit.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const fails = [];
const assert = (cond, msg) => {
  if (!cond) fails.push(msg);
  process.stdout.write(`${cond ? "ok  " : "NOT "} ${msg}\n`);
};

async function main() {
  // 1. Boot the server on an OS-assigned port, read the real port from its log.
  const srv = spawn(node, [join(here, "server.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in 3s")), 3000);
    srv.stdout.on("data", (b) => {
      const m = String(b).match(/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;

  try {
    // 2. Drive the API and assert the observed behaviour (the capture step).
    const noAuth = await fetch(`${base}/api/feed`);
    assert(noAuth.status === 401, "GET /api/feed without a token is 401");

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "alice", pass: "pw" }),
    });
    const { token } = await login.json();
    assert(login.status === 200 && typeof token === "string" && token.includes("."), "POST /api/login mints a dotted token");

    const feed = await fetch(`${base}/api/feed`, { headers: { authorization: `Bearer ${token}` } });
    const feedBody = await feed.json();
    assert(feed.status === 200 && Array.isArray(feedBody.items), "GET /api/feed with the token returns items");

    const bad = await fetch(`${base}/api/feed`, { headers: { authorization: "Bearer garbage.sig" } });
    assert(bad.status === 401, "a tampered token is rejected (401)");

    const config = await fetch(`${base}/api/config`);
    const configBody = await config.json();
    assert(config.status === 200 && configBody.flags, "GET /api/config is open and returns flags");

    // 3. Read the client bundle (the artifacts step).
    const bundle = readFileSync(join(here, "client", "bundle.js"), "utf8");
    for (const s of ["makeHarderRanking", "FEED_RANKING_SALT", "ANALYTICS_WRITE_KEY", "/api/login", "/api/feed", "/api/config"]) {
      assert(bundle.includes(s), `bundle still carries ${s}`);
    }

    // 4. Compose a report from what was observed, then grade it.
    const payload = Buffer.from(token.split(".")[0], "base64url").toString();
    const report = [
      "# App recon: recon-fixture",
      "- Authorization: owned (the operator owns this fixture). Case one.",
      "## Endpoints",
      "POST /api/login (none) -> {token}; GET /api/feed (Bearer token) -> {items}; GET /api/config (none) -> {flags}",
      "## Auth chain",
      `login mints a Bearer token (${payload}); /api/feed needs it or returns 401. login -> token -> feed.`,
      "## Artifacts",
      "makeHarderRanking re-ranks the feed with FEED_RANKING_SALT. ANALYTICS_WRITE_KEY is a public key, not a secret.",
    ].join("\n\n");

    const dir = mkdtempSync(join(tmpdir(), "recon-run-"));
    const good = join(dir, "report.md");
    const empty = join(dir, "empty.md");
    writeFileSync(good, report);
    writeFileSync(empty, "# nothing\n");

    const verify = join(here, "verify.mjs");
    const passOk = spawnSync(node, [verify, good], { encoding: "utf8" });
    assert(passOk.status === 0, "verifier passes the composed report");
    const failOk = spawnSync(node, [verify, empty], { encoding: "utf8" });
    assert(failOk.status === 1, "verifier fails an empty report (negative control)");
  } finally {
    srv.kill();
  }

  if (fails.length) {
    process.stdout.write(`\n${fails.length} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nrecon-fixture reference run: all assertions passed\n");
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  process.exit(1);
});
