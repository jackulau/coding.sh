import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname } from "node:path";
import { request } from "node:http";
import { describe, test } from "node:test";
import { cacheFile } from "../../src/update/index.ts";
import { readStar, recordStar, STAR_LINE, starFile, starNotice, starVisible, type StarState } from "../../src/update/star.ts";
import { startViewer } from "../../src/viewer/server.ts";
import { FakeBlobs, FakeIndex, session } from "../viewer/fakes.ts";
import { clock, DAY, tmpEnv, ttyStream } from "./helpers.ts";

const out = { json: false };

function seed(env: NodeJS.ProcessEnv, state: StarState): void {
  mkdirSync(dirname(starFile(env)), { recursive: true });
  writeFileSync(starFile(env), JSON.stringify(state));
}

describe("opt-outs write and show nothing", () => {
  for (const [name, extra] of [
    ["CODING_SH_NO_STAR_PROMPT=1", { CODING_SH_NO_STAR_PROMPT: "1" }],
    ["NO_UPDATE_NOTIFIER", { NO_UPDATE_NOTIFIER: "1" }],
    ["NO_UPDATE_NOTIFIER set empty", { NO_UPDATE_NOTIFIER: "" }],
    ["CI", { CI: "true" }],
  ] as const) {
    test(name, () => {
      const env = tmpEnv(extra);
      const c = clock();
      const err = ttyStream();
      assert.equal(starNotice(env, out, { now: c.now, stderr: err }), false);
      c.advance(10 * DAY);
      assert.equal(starNotice(env, out, { now: c.now, stderr: err }), false);
      assert.equal(starVisible(env, 50, c.now), false);
      recordStar(env, "dismiss", c.now);
      assert.equal(err.text, "");
      assert.equal(existsSync(starFile(env)), false, "nothing written");
    });
  }

  test("CODING_SH_NO_STAR_PROMPT=0 is not an opt-out", () => {
    const env = tmpEnv({ CODING_SH_NO_STAR_PROMPT: "0" });
    starNotice(env, out, { now: clock().now, stderr: ttyStream() });
    assert.equal(existsSync(starFile(env)), true);
  });
});

describe("terminal line", () => {
  test("firstSeen is written once, on the first check", () => {
    const env = tmpEnv();
    const c = clock();
    const t0 = c.now();
    starNotice(env, out, { now: c.now, stderr: ttyStream() });
    assert.equal(readStar(env).firstSeen, t0);
    c.advance(DAY);
    starNotice(env, out, { now: c.now, stderr: ttyStream() });
    assert.equal(readStar(env).firstSeen, t0, "not rewritten");
    assert.equal(starFile(env).endsWith("star.json"), true);
  });

  test("waits 3 days, prints once, then never again", () => {
    const env = tmpEnv();
    const c = clock();
    const err = ttyStream();
    assert.equal(starNotice(env, out, { now: c.now, stderr: err }), false, "first run only starts the clock");
    c.advance(3 * DAY - 1);
    assert.equal(starNotice(env, out, { now: c.now, stderr: err }), false, "one ms short");
    c.advance(1);
    assert.equal(starNotice(env, out, { now: c.now, stderr: err }), true);
    assert.equal(err.text, STAR_LINE + "\n");
    assert.match(STAR_LINE, /^Enjoying coding\.sh\? A star on GitHub helps other people find it: https:\/\/github\.com\/jackulau\/coding\.sh$/);
    assert.equal(readStar(env).cliShownAt, c.now());
    c.advance(30 * DAY);
    assert.equal(starNotice(env, out, { now: c.now, stderr: err }), false);
    assert.equal(err.text, STAR_LINE + "\n", "still one line");
  });

  test("uses the dim style when the output has one", () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    const err = ttyStream();
    starNotice(env, { json: false, style: (s, st) => `<${st}>${s}</${st}>` }, { now: () => 4 * DAY, stderr: err });
    assert.equal(err.text, `<faint>${STAR_LINE}</faint>\n`);
  });

  test("not with --json, a non-TTY stderr, mcp, statusline or update", () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    const now = () => 5 * DAY;
    assert.equal(starNotice(env, { json: true }, { now, stderr: ttyStream() }), false);
    const pipe = ttyStream(false);
    assert.equal(starNotice(env, out, { now, stderr: pipe }), false);
    assert.equal(starNotice(env, out, { now, stderr: ttyStream(), command: "mcp" }), false);
    assert.equal(starNotice(env, out, { now, stderr: ttyStream(), command: "update" }), false);
    assert.equal(starNotice(env, out, { now, stderr: ttyStream(), command: "statusline" }), false);
    assert.equal(pipe.text, "");
    assert.equal(readStar(env).cliShownAt, undefined, "a skipped run does not use up the line");
    assert.equal(starNotice(env, out, { now, stderr: ttyStream() }), true);
  });

  test("not in the run that printed the update notice, but the next run prints it", () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    const err = ttyStream();
    assert.equal(starNotice(env, out, { now: () => 5 * DAY, stderr: err, skip: true }), false);
    assert.equal(err.text, "");
    assert.equal(starNotice(env, out, { now: () => 5 * DAY, stderr: err }), true);
  });

  test("dismissed or starred in the viewer: the CLI never prints", () => {
    for (const state of [{ firstSeen: 0, dismissedAt: 1 }, { firstSeen: 0, starredAt: 1 }]) {
      const env = tmpEnv();
      seed(env, state);
      const err = ttyStream();
      assert.equal(starNotice(env, out, { now: () => 9 * DAY, stderr: err }), false);
      assert.equal(err.text, "");
    }
  });

  test("a home that cannot be written prints at most once (never on every command)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    chmodSync(env.CODING_SH_HOME!, 0o555);
    try {
      const err = ttyStream();
      let printed = 0;
      for (let i = 0; i < 5; i++) if (starNotice(env, out, { now: () => 9 * DAY, stderr: err })) printed++;
      assert.ok(printed <= 1, `printed ${printed} times`);
      assert.ok(err.text.split("\n").filter(Boolean).length <= 1);
      assert.deepEqual(readdirSync(env.CODING_SH_HOME!).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
    } finally {
      chmodSync(env.CODING_SH_HOME!, 0o755);
    }
  });

  test("a read-only home does not throw", () => {
    const env = tmpEnv();
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    mkdirSync(starFile(env), { recursive: true }); // a directory where the file goes
    assert.doesNotThrow(() => starNotice(env, out, { now: () => 9 * DAY, stderr: ttyStream() }));
  });
});

describe("viewer state", () => {
  test("shows after 3 days and 5 sessions, until dismissed", () => {
    const env = tmpEnv();
    const c = clock();
    assert.equal(starVisible(env, 9, c.now), false, "the first check starts the clock");
    c.advance(3 * DAY);
    assert.equal(starVisible(env, 4, c.now), false, "4 sessions");
    assert.equal(starVisible(env, 5, c.now), true);
    recordStar(env, "dismiss", c.now);
    assert.equal(readStar(env).dismissedAt, c.now());
    assert.equal(starVisible(env, 99, c.now), false);
  });

  test("starred also ends it, and the first record wins", () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    recordStar(env, "starred", () => 5 * DAY);
    recordStar(env, "starred", () => 6 * DAY);
    assert.deepEqual(readStar(env), { firstSeen: 0, starredAt: 5 * DAY });
    assert.equal(starVisible(env, 99, () => 9 * DAY), false);
  });

  test("makes no network call: fetch, http, https and net all throw, and the CLI and viewer state paths still run", async () => {
    const real = { fetch: globalThis.fetch, http: http.request, https: https.request, connect: net.connect };
    let calls = 0;
    const trap = (): never => {
      calls++;
      throw new Error("no network");
    };
    globalThis.fetch = trap;
    http.request = trap;
    https.request = trap;
    net.connect = trap;
    try {
      const env = tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "1" });
      seed(env, { firstSeen: 0 });
      assert.equal(starNotice(env, out, { now: () => 9 * DAY, stderr: ttyStream() }), true);
      assert.equal(starVisible(env, 9, () => 9 * DAY), true);
      recordStar(env, "dismiss");
      assert.equal((await runMain(tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "1" }), ["version"])).code, 0);
    } finally {
      globalThis.fetch = real.fetch;
      http.request = real.http;
      https.request = real.https;
      net.connect = real.connect;
    }
    assert.equal(calls, 0);
  });

  test("does not touch the update cache", () => {
    const env = tmpEnv();
    starNotice(env, out, { now: () => 9 * DAY, stderr: ttyStream() });
    assert.equal(existsSync(cacheFile(env)), false);
  });
});

function call(port: number, token: string | undefined, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { host: `127.0.0.1:${port}`, ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      h["content-type"] ??= "application/json";
      h["content-length"] = String(Buffer.byteLength(body));
    }
    const req = request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
      let s = "";
      res.on("data", (c: Buffer) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : null }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function viewer(sessions: number, env: NodeJS.ProcessEnv | undefined, now = () => 5 * DAY) {
  const index = new FakeIndex();
  for (let i = 0; i < sessions; i++) await index.upsertSession(session(`s${i}`));
  return startViewer({ index, blobs: new FakeBlobs(), port: 0, star: env && { env, now } });
}

describe("/api/star", () => {
  test("GET shows after 3 days with 5 sessions; POST dismiss ends it", async () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    const v = await viewer(5, env);
    try {
      assert.equal((await call(v.port, undefined, "GET", "/api/star")).status, 401);
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: true });
      const r = await call(v.port, v.token, "POST", "/api/star", JSON.stringify({ action: "dismiss" }));
      assert.equal(r.status, 200);
      assert.equal(readStar(env).dismissedAt, 5 * DAY);
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: false });
    } finally {
      await v.close();
    }
  });

  test("POST starred records starredAt", async () => {
    const env = tmpEnv();
    const v = await viewer(5, env);
    try {
      assert.equal((await call(v.port, v.token, "POST", "/api/star", JSON.stringify({ action: "starred" }))).status, 200);
      assert.equal(readStar(env).starredAt, 5 * DAY);
    } finally {
      await v.close();
    }
  });

  test("subagents do not count toward the 5", async () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    const index = new FakeIndex();
    await index.upsertSession(session("top"));
    for (let i = 0; i < 4; i++) await index.upsertSession(session(`sub${i}`, { parent: { sessionId: "top" } }));
    const v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, star: { env, now: () => 5 * DAY } });
    try {
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: false });
      for (let i = 0; i < 4; i++) await index.upsertSession(session(`top${i}`));
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: true });
    } finally {
      await v.close();
    }
  });

  test("fewer than 5 sessions: show is false", async () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 0 });
    const v = await viewer(4, env);
    try {
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: false });
    } finally {
      await v.close();
    }
  });

  test("less than 3 days after first use: show is false", async () => {
    const env = tmpEnv();
    seed(env, { firstSeen: 4 * DAY });
    const v = await viewer(9, env);
    try {
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: false });
    } finally {
      await v.close();
    }
  });

  test("an opt-out answers show:false and writes nothing", async () => {
    const env = tmpEnv({ CODING_SH_NO_STAR_PROMPT: "1" });
    const v = await viewer(9, env);
    try {
      assert.deepEqual((await call(v.port, v.token, "GET", "/api/star")).body, { show: false });
      await call(v.port, v.token, "POST", "/api/star", JSON.stringify({ action: "dismiss" }));
      assert.equal(existsSync(starFile(env)), false);
    } finally {
      await v.close();
    }
  });

  test("bad bodies are rejected", async () => {
    const env = tmpEnv();
    const v = await viewer(5, env);
    try {
      const post = (b: string, h?: Record<string, string>) => call(v.port, v.token, "POST", "/api/star", b, h);
      assert.equal((await post(JSON.stringify({ action: "nope" }))).status, 400);
      assert.equal((await post(JSON.stringify({}))).status, 400);
      assert.equal((await post(JSON.stringify(null))).status, 400);
      assert.equal((await post("not json")).status, 400);
      assert.equal((await post(JSON.stringify({ action: "dismiss" }), { "content-type": "text/plain" })).status, 415);
      const big = await post(JSON.stringify({ action: "dismiss", pad: "x".repeat(2048) }));
      assert.equal(big.status, 413);
      assert.match(JSON.stringify(big.body), /exceeds 1 KB/, "a small cap is not rounded to 0 MB");
      assert.equal((await post(JSON.stringify({ action: "dismiss" }), { origin: "http://evil.example" })).status, 403);
      assert.equal((await call(v.port, v.token, "PUT", "/api/star", "{}")).status, 405);
      assert.equal((await call(v.port, v.token, "GET", "/api/star/x")).status, 404);
      assert.equal(existsSync(starFile(env)), false, "no bad request wrote state");
    } finally {
      await v.close();
    }
  });

  test("404 when the route is not wired (serve, static, hosted)", async () => {
    const v = await viewer(9, undefined);
    try {
      assert.equal((await call(v.port, v.token, "GET", "/api/star")).status, 404);
      assert.equal((await call(v.port, v.token, "POST", "/api/star", JSON.stringify({ action: "dismiss" }))).status, 404);
    } finally {
      await v.close();
    }
  });
});

describe("the page", () => {
  const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
  test("has the card, its two buttons and the GitHub link", () => {
    assert.match(html, /Enjoying coding\.sh\?/);
    assert.match(html, /A star on GitHub helps other people find it\./);
    assert.match(html, /id="star-go" href="https:\/\/github\.com\/jackulau\/coding\.sh" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /<aside class="star-card" id="star" aria-label=/);
    assert.match(html, /z-index: 35; width: min\(26rem/, "below the overlay (50) and the phone sheet (40, 41)");
    assert.match(html, /fetch\("\/api\/star"/);
    assert.match(html, /codingsh\.star\.dismissed/);
  });
});

const AGENT_HOME_KEYS = ["HOME", "USERPROFILE", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODING_SH_NO_AUTO_INGEST"];

/** main() with a TTY stderr, and process.env pointed at the temp home like runCmd does: some paths read os.homedir(), not the env main gets. */
async function runMain(env: NodeJS.ProcessEnv, argv: string[]): Promise<{ code: number; err: string }> {
  const { main } = await import("../../src/cli/main.ts");
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const write = process.stderr.write;
  const saved = Object.fromEntries(AGENT_HOME_KEYS.map((k) => [k, process.env[k]]));
  for (const k of AGENT_HOME_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  let err = "";
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  process.stderr.write = ((s: string | Uint8Array) => ((err += String(s)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv, env);
    return { code, err };
  } finally {
    process.stderr.write = write;
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
    for (const k of AGENT_HOME_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("main wiring", () => {
  test("a successful command prints the line once; --json and a failing command do not", async () => {
    const env = tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "1" });
    seed(env, { firstSeen: Date.now() - 4 * DAY });
    const json = await runMain(env, ["version", "--json"]);
    assert.equal(json.code, 0);
    assert.doesNotMatch(json.err, /Enjoying/);
    const bad = await runMain(env, ["version", "--no-such-flag"]);
    assert.notEqual(bad.code, 0);
    assert.doesNotMatch(bad.err, /Enjoying/);
    assert.equal(readStar(env).cliShownAt, undefined);
    const ok = await runMain(env, ["version"]);
    assert.equal(ok.code, 0);
    assert.match(ok.err, /Enjoying coding\.sh\? A star on GitHub/);
    assert.notEqual(readStar(env).cliShownAt, undefined);
    assert.doesNotMatch((await runMain(env, ["version"])).err, /Enjoying/);
  });

  test("never beside the update notice", async () => {
    const env = tmpEnv();
    seed(env, { firstSeen: Date.now() - 4 * DAY });
    mkdirSync(dirname(cacheFile(env)), { recursive: true });
    writeFileSync(cacheFile(env), JSON.stringify({ latest: "99.0.0", checkedAt: Date.now(), attemptedAt: Date.now() }));
    const first = await runMain(env, ["version"]);
    assert.match(first.err, /Update available/);
    assert.doesNotMatch(first.err, /Enjoying/);
    const second = await runMain(env, ["version"]);
    assert.doesNotMatch(second.err, /Update available/, "the update notice is once a day");
    assert.match(second.err, /Enjoying/);
  });
});
