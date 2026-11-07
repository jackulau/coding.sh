// The shared journey fixtures (docs/PRODUCTION.md §6) exist and behave as the
// journeys (§7) expect: the mock LLM, answer.mjs, wait-session.mjs and flood.mjs.
// wait-session and flood run against a real `coding.sh serve` (bundled into a
// temp dir, temp HOME and CODING_SH_HOME), the way J1/J5/J7 use them.
// Run: node --test "deploy/test/*.test.mjs"
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fx = (p) => join(root, "examples/production", p);
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Spawns a long-running node script and resolves with its first stdout line. */
async function start(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  const line = await new Promise((res, rej) => {
    createInterface({ input: child.stdout }).once("line", res);
    child.once("exit", () => rej(new Error(`${args.join(" ")} exited early: ${stderr}`)));
  });
  return { child, line, exited, stderr: () => stderr };
}

/** Runs a node script to completion without blocking the event loop (the server under test lives in it). */
function run(args, env = { PATH: process.env.PATH }, input) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("exit", (status) => {
      clearTimeout(timer);
      res({ status, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

/** Expands `a/{b,c}` (one brace group) into `a/b`, `a/c`. */
const expand = (p) => {
  const m = /^(.*)\{([^}]*)\}(.*)$/.exec(p);
  return m ? m[2].split(",").map((x) => m[1] + x + m[3]) : [p];
};

describe("journey fixtures exist", () => {
  test("every examples/production path PRODUCTION.md names is in the repo", () => {
    const doc = readFileSync(join(root, "docs/PRODUCTION.md"), "utf8");
    const named = new Set();
    for (const [m] of doc.matchAll(/examples\/production\/(?:\{[^}\s]*\}|[A-Za-z0-9_.\-/])+/g)) {
      for (const p of expand(m.replace(/[./]+$/, ""))) named.add(p);
    }
    for (const p of ["mock-llm/server.mjs", "mock-llm/answer.mjs", "wait-session.mjs", "flood.mjs"]) {
      assert.ok(named.has(`examples/production/${p}`), `PRODUCTION.md no longer names ${p}`);
    }
    const missing = [...named].filter((p) => !existsSync(join(root, p)));
    assert.deepEqual(missing, [], "fixtures named in docs/PRODUCTION.md are missing");
  });

  test("J7's SQLite variant runs a server that knows the flood key, and J4 frees port 4318 first", () => {
    const doc = readFileSync(join(root, "docs/PRODUCTION.md"), "utf8");
    // A keyless (J4) server answers every Bearer key with 401 and has no `flood` project (QA J7).
    const sqlite = doc.slice(doc.indexOf("**SQLite variant:**"));
    const block = /```sh\n([\s\S]*?)```/.exec(sqlite)?.[1] ?? "";
    assert.match(block, /CODING_SH_INGEST_KEYS=[^\s]*flood:\$INGEST_KEY_FLOOD/, "the J7 SQLite server configures the flood key");
    assert.match(block, /kill -9 \$SERVE/);
    const kill = /sleep ([\d.]+); kill -9/.exec(block);
    assert.ok(kill && Number(kill[1]) < 1.5, "the kill lands before a ~1.6 s SQLite flood ends");
    assert.match(block.slice(0, block.indexOf("flood.mjs")), /readyz/, "the flood starts once the server is ready");
    const j4 = doc.slice(doc.indexOf("**J4:"), doc.indexOf("**J5:"));
    assert.match(j4, /docker compose stop coding-sh/, "J4/J5 say to free 4318 from the J1 stack");
  });
});

describe("mock-llm/server.mjs", () => {
  let srv;
  let url = "";
  before(async () => {
    srv = await start([fx("mock-llm/server.mjs"), "--port", "0"], { PATH: process.env.PATH });
    url = /http:\/\/\S+/.exec(srv.line)[0];
  });
  after(() => srv?.child.kill("SIGKILL"));

  const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** Parses an SSE body into [{event, data}] (data JSON-decoded unless "[DONE]"). */
  const sse = (text) =>
    text
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const raw = /^data: (.*)$/m.exec(block)[1];
        return { event, data: raw === "[DONE]" ? raw : JSON.parse(raw) };
      });

  test("listens on 127.0.0.1:9999 by default", () => {
    assert.match(readFileSync(fx("mock-llm/server.mjs"), "utf8"), /"9999"/);
    assert.match(srv.line, /^mock-llm listening on http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("OpenAI chat completions: pong, 1000/500 usage, no cache, model echoed", async () => {
    const r = await post("/v1/chat/completions", { model: "mock-gpt", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.model, "mock-gpt");
    assert.equal(j.choices[0].message.content, "pong");
    assert.equal(j.usage.prompt_tokens, 1000);
    assert.equal(j.usage.completion_tokens, 500);
    assert.equal(j.usage.prompt_tokens_details.cached_tokens, 0);
  });

  test("OpenAI streaming sends the usage chunk only when asked", async () => {
    const withUsage = sse(await (await post("/v1/chat/completions", { model: "m1", stream: true, stream_options: { include_usage: true }, messages: [] })).text());
    assert.equal(withUsage.at(-1).data, "[DONE]");
    const chunks = withUsage.slice(0, -1).map((e) => e.data);
    assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "pong");
    assert.ok(chunks.every((c) => c.model === "m1" && c.object === "chat.completion.chunk"));
    const last = chunks.at(-1);
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage.prompt_tokens, 1000);
    assert.equal(last.usage.completion_tokens, 500);

    const plain = sse(await (await post("/v1/chat/completions", { model: "m1", stream: true, messages: [] })).text());
    assert.ok(plain.every((e) => e.data === "[DONE]" || !e.data.usage), "no usage chunk without include_usage");
  });

  test("Anthropic messages, plain and streaming", async () => {
    const j = await (await post("/v1/messages", { model: "mock-claude", max_tokens: 64, messages: [{ role: "user", content: "hi" }] })).json();
    assert.equal(j.model, "mock-claude");
    assert.deepEqual(j.content, [{ type: "text", text: "pong" }]);
    assert.equal(j.usage.input_tokens, 1000);
    assert.equal(j.usage.output_tokens, 500);
    assert.equal(j.usage.cache_read_input_tokens, 0);
    assert.equal(j.usage.cache_creation_input_tokens, 0);

    const evs = sse(await (await post("/v1/messages", { model: "mock-claude", max_tokens: 64, stream: true, messages: [] })).text());
    assert.deepEqual(
      evs.map((e) => e.event),
      ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
    );
    assert.ok(evs.every((e) => e.data.type === e.event));
    assert.equal(evs[0].data.message.model, "mock-claude");
    assert.equal(evs[0].data.message.usage.input_tokens, 1000);
    assert.equal(evs[2].data.delta.text, "pong");
    assert.equal(evs[4].data.usage.output_tokens, 500);
  });

  test("unknown routes are 404, and SIGTERM stops it with exit 0", async () => {
    assert.equal((await post("/v1/embeddings", {})).status, 404);
    const own = await start([fx("mock-llm/server.mjs"), "--port", "0"], { PATH: process.env.PATH });
    own.child.kill("SIGTERM");
    assert.equal(await own.exited, 0, own.stderr());
  });
});

describe("mock-llm/answer.mjs", () => {
  test("reads stdin and prints pong", async () => {
    const r = await run([fx("mock-llm/answer.mjs")], undefined, JSON.stringify({ input: "Where is order 42?" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "pong\n");
  });
});

describe("wait-session.mjs and flood.mjs against coding.sh serve", () => {
  const ikDemo = `csh_ik_${randomBytes(32).toString("base64url")}`;
  const ikFlood = `csh_ik_${randomBytes(32).toString("base64url")}`;
  const rk = `csh_rk_${randomBytes(32).toString("base64url")}`;
  let srv;
  let url = "";
  let cli = "";
  let dir = "";
  const env = { PATH: process.env.PATH };
  /** Env for a `coding.sh serve` with its own temp HOME and CODING_SH_HOME. */
  const serveEnv = (name) => {
    const home = join(dir, name);
    mkdirSync(home);
    return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), NO_UPDATE_NOTIFIER: "1", CODING_SH_LOG: "json" };
  };

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-fixtures-")));
    roots.push(dir);
    const { bundle } = await import("../../packages/coding.sh/scripts/bundle.mjs");
    ({ cli } = await bundle(join(dir, "dist")));
    srv = await start([cli, "serve", "--port", "0", "--json"], {
      ...serveEnv("home"),
      CODING_SH_INGEST_KEYS: `demo:${ikDemo},flood:${ikFlood}`,
      CODING_SH_READ_KEYS: `*:${rk}`,
      // One request at a time: concurrent flood batches are throttled (J5's backpressure, small).
      CODING_SH_QUEUE_MAX_EVENTS: "1",
    });
    const ready = JSON.parse(srv.line);
    assert.equal(ready.ready.ok, true);
    url = ready.url;
  });
  after(async () => {
    srv?.child.kill("SIGTERM");
    await srv?.exited;
  });

  const wait = (...args) => run([fx("wait-session.mjs"), "--url", url, ...args], env);
  const floodRun = (...args) => run([fx("flood.mjs"), "--url", url, "--key", ikFlood, ...args], env);
  const floodSessions = async () => {
    const r = await fetch(`${url}/api/sessions?project=flood&limit=500`, { headers: { authorization: `Bearer ${rk}` } });
    assert.equal(r.status, 200);
    return (await r.json()).items;
  };
  const sum = (items) => items.reduce((n, s) => n + s.stats.events, 0);

  test("wait-session: times out with exit 1, fails fast on a bad key, never prints a key", async () => {
    const t = await wait("--key", rk, "--session", "demo/missing", "--timeout-ms", "600");
    assert.equal(t.status, 1);
    const out = JSON.parse(t.stdout);
    assert.equal(out.timeout, true);
    assert.ok(out.elapsedMs >= 500 && out.elapsedMs < 5000, String(out.elapsedMs));

    const bad = await wait("--key", "csh_rk_wrong", "--session", "demo/missing", "--timeout-ms", "10000");
    assert.equal(bad.status, 1);
    assert.ok(JSON.parse(bad.stdout).elapsedMs < 5000, "a 401 does not wait for the timeout");
    assert.ok(!(bad.stdout + bad.stderr).includes("csh_rk_wrong"));
    assert.equal((await run([fx("wait-session.mjs"), "--session", "x"], env)).status, 2, "--url is required");
  });

  test("wait-session: prints {elapsedMs, stats} once the session exists", async () => {
    const body = { v: 0, service: "j1-app", events: [{ v: 0, id: "j1-a", sessionId: "j1", ts: Date.now() - 1000, kind: "llm.call", model: "mock-gpt", usage: { inputTokens: 1000, outputTokens: 500 }, payload: { text: "pong" } }] };
    const pending = wait("--key", rk, "--session", "demo/j1", "--timeout-ms", "5000");
    await new Promise((r) => setTimeout(r, 300));
    const ing = await fetch(`${url}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${ikDemo}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(ing.status, 200);
    const r = await pending;
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["elapsedMs", "stats"]);
    assert.ok(out.elapsedMs >= 250 && out.elapsedMs <= 5000, String(out.elapsedMs));
    assert.equal(out.stats.events, 1);
    assert.equal(out.stats.usage.inputTokens, 1000);
    assert.equal(out.stats.usage.outputTokens, 500);
    assert.ok(!r.stdout.includes(rk) && !r.stdout.includes(ikDemo));
  });

  test("flood: stored = acked without --retry; --retry reaches exactly N with no duplicates", async () => {
    const args = ["--events", "600", "--batch", "50", "--sessions", "5", "--seed", "5", "--concurrency", "12"];
    const first = await floodRun(...args);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const a = JSON.parse(first.stdout);
    for (const k of ["sent", "acked", "throttled", "retryAfterSeen"]) assert.ok(k in a, k);
    assert.equal(a.sent, 600);
    assert.ok(a.throttled > 0, `12 concurrent batches against a 1-event queue are throttled: ${first.stdout}`);
    assert.equal(a.retryAfterSeen.n, a.throttled);
    assert.equal(a.retryAfterSeen.allIntGe1, true);
    assert.ok(a.retryAfterSeen.min >= 1);
    assert.ok(a.acked > 0 && a.acked < 600);
    assert.equal(sum(await floodSessions()), a.acked, "every acked event is stored, nothing else");
    assert.ok(!(first.stdout + first.stderr).includes(ikFlood));

    const second = await floodRun(...args, "--retry");
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const b = JSON.parse(second.stdout);
    assert.equal(b.acked, 600);
    assert.equal(b.inserted, 600 - a.acked, "the re-run only adds what the first run dropped");
    const items = await floodSessions();
    assert.deepEqual(items.map((s) => s.id).sort(), ["flood/s-0", "flood/s-1", "flood/s-2", "flood/s-3", "flood/s-4"]);
    assert.equal(sum(items), 600);
  });

  test("flood: a rejected key fails fast with exit 1 even with --retry, never printing the key", async () => {
    // QA J7: a keyless loopback server (the J4 server) rejects every Bearer key with 401, and
    // flood --retry used to retry those 401s until the 10-minute deadline.
    const keyless = await start([cli, "serve", "--port", "0", "--json"], serveEnv("home-keyless"));
    try {
      const kurl = JSON.parse(keyless.line).url;
      const args = ["--events", "2000", "--batch", "200", "--sessions", "5", "--seed", "7", "--concurrency", "8", "--retry"];
      for (const [u, k] of [[kurl, ikFlood], [url, "csh_ik_wrong"]]) {
        const t0 = Date.now();
        const r = await run([fx("flood.mjs"), "--url", u, "--key", k, ...args]);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.ok(Date.now() - t0 < 20_000, "a 401 does not wait for --deadline-ms");
        const out = JSON.parse(r.stdout);
        assert.equal(out.acked, 0);
        assert.match(out.error, /401/);
        assert.ok(out.other["401"] >= 1 && out.other["401"] <= 8, `at most one 401 per worker: ${r.stdout}`);
        assert.ok(!(r.stdout + r.stderr).includes(k));
      }
    } finally {
      keyless.child.kill("SIGTERM");
      await keyless.exited;
    }
  });

  test("flood: --retry gives up at the deadline with exit 1 when the server is gone", async () => {
    const r = await run([fx("flood.mjs"), "--url", "http://127.0.0.1:9", "--key", ikFlood, "--events", "10", "--batch", "10", "--sessions", "1", "--retry", "--deadline-ms", "1500"], env);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.acked, 0);
    assert.ok(out.other.network >= 1);
    assert.equal((await run([fx("flood.mjs"), "--url", url, "--events", "0"], env)).status, 2);
  });
});
