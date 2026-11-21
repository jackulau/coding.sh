// Monitors: `coding.sh monitor add --run|--judge` scores sessions that end, after each
// `coding.sh ingest`, once per session, with a cursor, a sample rate, a daily judge budget
// and the last error kept in <CODING_SH_HOME>/monitors.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as ingestCmd from "../../src/cli/commands/ingest.ts";
import * as monitorCmd from "../../src/cli/commands/monitor.ts";
import * as scoreCmd from "../../src/scores/cli.ts";
import { openContext } from "../../src/core/context.ts";
import { paths } from "../../src/core/paths.ts";
import { SIGNATURE_HEADER, signBody } from "../../src/alerts/notify.ts";
import type { ChatProvider } from "../../src/judge/providers.ts";
import { monitorVersion, NO_PROVIDER, parseOutput, runMonitors, sampleKey } from "../../src/monitor/run.ts";
import { readMonitors } from "../../src/monitor/state.ts";
import { startMonitorTimer } from "../../src/monitor/timer.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "spool", "hook.ts");
const NODE = `"${process.execPath}"`;
const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

function box(): Sandbox {
  const sb = sandbox({ T3CODE_HOME: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, AI_GATEWAY_API_KEY: undefined, GEMINI_API_KEY: undefined });
  sb.env.T3CODE_HOME = join(sb.root, "t3");
  boxes.push(sb);
  return sb;
}

/** One finished Claude Code session captured by the hook, timestamped now. */
function capture(sb: Sandbox, sessionId: string, prompt = "fix the failing test"): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...sb.env };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_DEV_REAL_STORE", "CODING_SH_DISABLE", "T3CODE_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const base = { session_id: sessionId, cwd: "/work/demo" };
  const lines: [string, Record<string, unknown>][] = [
    ["SessionStart", { source: "startup" }],
    ["UserPromptSubmit", { prompt }],
    ["Stop", { last_assistant_message: "The test passes now." }],
    ["SessionEnd", { reason: "exit" }],
  ];
  for (const [event, extra] of lines) {
    const input = JSON.stringify({ ...base, hook_event_name: event, ...extra });
    const r = spawnSync(process.execPath, ["--no-warnings", HOOK, "claude-code", event], { env, input, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
  }
}

async function add(sb: Sandbox, name: string, flags: Record<string, string | boolean | number>) {
  const r = await runCmd(monitorCmd, sb, { action: "add", positionals: [name], flags, json: true });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.code, 0, r.stderr);
  return r;
}

async function ingest(sb: Sandbox) {
  const r = await runCmd(ingestCmd, sb, { json: true });
  assert.equal(r.error, undefined, String(r.error));
  return r;
}

async function monitorScores(sb: Sandbox) {
  const r = await runCmd(scoreCmd, sb, { action: "list", flags: { source: "monitor" }, json: true });
  assert.equal(r.error, undefined, String(r.error));
  return r.json.items as { targetId: string; name: string; value: unknown; comment?: string; source: string; judgeVersion?: string }[];
}

describe("monitor --run", () => {
  it("scores a new session once after ingest, and a second ingest adds no row", async () => {
    const sb = box();
    const cmd = `${NODE} -e "console.log(JSON.stringify({value:1}))"`;
    await add(sb, "ok", { run: cmd });
    capture(sb, "mon-run-1");
    const first = await ingest(sb);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.json.monitors.map((m: { name: string; scored: number }) => [m.name, m.scored]), [["ok", 1]]);
    let rows = await monitorScores(sb);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.targetId, rows[0]!.name, rows[0]!.value, rows[0]!.source, rows[0]!.judgeVersion], ["mon-run-1", "ok", 1, "monitor", monitorVersion(cmd)]);

    const second = await ingest(sb);
    assert.equal(second.code, 0, second.stderr);
    rows = await monitorScores(sb);
    assert.equal(rows.length, 1, "one score per session and monitor");
    const def = readMonitors(paths(sb.env).monitors).monitors[0]!;
    assert.equal(def.scored, 1);
    assert.ok(def.cursor! > 0, "the cursor moved past the session");
    assert.equal(def.lastError, undefined);
  });

  it("a command that exits 1 leaves ingest at exit 0, writes no score, and monitor list shows the error", async () => {
    const sb = box();
    await add(sb, "broken", { run: `${NODE} -e "process.exit(1)"` });
    capture(sb, "mon-fail-1");
    const r = await ingest(sb);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.monitors[0].failed, 1);
    assert.equal((await monitorScores(sb)).length, 0);
    const listed = await runCmd(monitorCmd, sb, { action: "list", json: true });
    const m = listed.json.monitors[0];
    assert.equal(m.name, "broken");
    assert.match(m.lastError.message, /mon-fail-1: .*exit/i);
    assert.equal(m.lastError.sessionId, "mon-fail-1");
    assert.ok(m.lastError.at > 0);
    const human = await runCmd(monitorCmd, sb, { action: "list" });
    assert.match(human.stdout, /^NAME\tSCORES WITH\t/m);
    assert.match(human.stdout, /broken\trun: .*mon-fail-1/);
    // The human ingest prints the monitor's row and its error, and still exits 0.
    capture(sb, "mon-fail-2");
    const again = await runCmd(ingestCmd, sb, {});
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout + again.stderr, /Monitor broken/);
  });

  it("output without a value records an error and writes no score", async () => {
    const sb = box();
    await add(sb, "chatty", { run: `${NODE} -e "console.log('looks fine to me')"` });
    capture(sb, "mon-bad-1");
    const r = await ingest(sb);
    assert.equal(r.code, 0);
    assert.equal((await monitorScores(sb)).length, 0);
    const def = readMonitors(paths(sb.env).monitors).monitors[0]!;
    assert.match(def.lastError!.message, /value/);
    assert.throws(() => parseOutput("[1]"), /value/);
    assert.deepEqual(parseOutput('log line\n{"value":"pass","comment":"ok"}\n'), { value: "pass", comment: "ok" });
    assert.deepEqual(parseOutput('{"value":false}'), { value: false });
  });

  it("the command reads the session as show --json gives it on stdin; its comment is stored", async () => {
    const sb = box();
    const script = join(sb.root, "check.mjs");
    writeFileSync(
      script,
      [
        'let s = "";',
        'process.stdin.on("data", (d) => (s += d));',
        'process.stdin.on("end", () => {',
        "  const doc = JSON.parse(s);",
        '  const user = doc.events.find((e) => e.kind === "user.message");',
        '  console.log(JSON.stringify({ value: doc.session.id === process.env.CODING_SH_SESSION_ID ? 1 : 0, comment: `${doc.session.agent}: ${user.payload.text}` }));',
        "});",
      ].join("\n"),
    );
    await add(sb, "reader", { run: `${NODE} "${script}"` });
    capture(sb, "mon-stdin-1", "rename the helper");
    await ingest(sb);
    const rows = await monitorScores(sb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.value, 1);
    assert.equal(rows[0]!.comment, "claude-code: rename the helper");
  });

  it("--sample 0 leaves every session out; --where filters; the sample key is stable", async () => {
    const sb = box();
    const cmd = `${NODE} -e "console.log(JSON.stringify({value:1}))"`;
    await add(sb, "none", { run: cmd, sample: 0 });
    await add(sb, "codex-only", { run: cmd, where: "agent:codex" });
    capture(sb, "mon-sample-1");
    const r = await ingest(sb);
    const byName = Object.fromEntries(r.json.monitors.map((m: { name: string }) => [m.name, m]));
    assert.equal(byName.none.sampledOut, 1);
    assert.equal(byName.none.scored, 0);
    assert.equal(byName["codex-only"].scored, 0);
    assert.equal((await monitorScores(sb)).length, 0);
    assert.equal(sampleKey("abc"), sampleKey("abc"));
    assert.ok(sampleKey("abc") >= 0 && sampleKey("abc") < 1);
  });

  it("add checks its flags; rm removes; a name in use needs --force", async () => {
    const sb = box();
    const bad = async (flags: Record<string, string | boolean | number>, re: RegExp, name = "m") => {
      const r = await runCmd(monitorCmd, sb, { action: "add", positionals: [name], flags });
      assert.match(String(r.error?.message), re);
    };
    await bad({}, /--judge .*--run .*--http/);
    await bad({ run: "x", judge: "r.md" }, /--judge, --run or --http/);
    await bad({ run: "x", sample: 2 }, /--sample/);
    await bad({ run: "x", where: "((" }, /--where/);
    await bad({ judge: join(sb.root, "missing.md") }, /no rubric file/);
    await bad({ run: "x" }, /monitor name/, "bad name!");
    await add(sb, "m", { run: "x" });
    const dup = await runCmd(monitorCmd, sb, { action: "add", positionals: ["m"], flags: { run: "y" } });
    assert.match(String(dup.error?.message), /exists/);
    await add(sb, "m", { run: "y", force: true });
    assert.equal(readMonitors(paths(sb.env).monitors).monitors[0]!.command, "y");
    const rm = await runCmd(monitorCmd, sb, { action: "rm", positionals: ["m"] });
    assert.equal(rm.code, 0);
    assert.deepEqual(readMonitors(paths(sb.env).monitors).monitors, []);
    const gone = await runCmd(monitorCmd, sb, { action: "rm", positionals: ["m"] });
    assert.match(String(gone.error?.message), /no monitor named m/);
  });
});

describe("monitor --judge", () => {
  it("the mock provider scores each session with the rubric; monitor run --since rescans nothing twice", async () => {
    const sb = box();
    const rubric = join(sb.root, "rubric.md");
    writeFileSync(rubric, "Did the agent finish the task the user asked for?\n");
    await add(sb, "helpful", { judge: rubric, provider: "mock" });
    capture(sb, "mon-judge-1");
    await ingest(sb);
    const rows = await monitorScores(sb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.value, 1);
    assert.match(rows[0]!.comment!, /mock verdict/);
    assert.equal(rows[0]!.judgeVersion, monitorVersion(readFileSync(rubric, "utf8")));
    const r = await runCmd(monitorCmd, sb, { action: "run", positionals: ["helpful"], flags: { since: "7d" }, json: true });
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    assert.equal(r.json.monitors[0].scored, 0);
    assert.equal(r.json.monitors[0].skipped, 1, "already scored");
    assert.equal((await monitorScores(sb)).length, 1);
  });

  it("with no provider it records 'no judge provider' and scores nothing", async () => {
    const sb = box();
    const rubric = join(sb.root, "rubric.md");
    writeFileSync(rubric, "Was the answer correct?\n");
    const added = await add(sb, "nokey", { judge: rubric });
    assert.equal(added.json.warning, NO_PROVIDER);
    capture(sb, "mon-nokey-1");
    const r = await ingest(sb);
    assert.equal(r.code, 0);
    assert.equal(r.json.monitors[0].stopped, "no-provider");
    assert.equal((await monitorScores(sb)).length, 0);
    assert.equal(readMonitors(paths(sb.env).monitors).monitors[0]!.lastError!.message, NO_PROVIDER);
  });

  it("stops for the day once the estimated spend reaches --max-usd-day", async () => {
    const sb = box();
    const rubric = join(sb.root, "rubric.md");
    writeFileSync(rubric, "Was the answer correct?\n");
    await add(sb, "costly", { judge: rubric, "max-usd-day": 5 });
    for (const id of ["mon-cost-1", "mon-cost-2", "mon-cost-3"]) capture(sb, id, `task ${id}`);
    await runCmd(ingestCmd, sb, { json: true, flags: {} }).then(() => undefined);
    // That ingest ran the monitor with no provider; now run it with one that reports a
    // million input tokens per call on a model with no price: $3 a call at the fallback rate.
    let calls = 0;
    const provider: ChatProvider = {
      name: "test",
      model: "unpriced-model",
      params: {},
      async complete() {
        calls++;
        return { text: JSON.stringify({ score: 1, pass: true, reason: "fine" }), model: "unpriced-model", usage: { inputTokens: 1_000_000, outputTokens: 0 } };
      },
    };
    const ctx = await openContext({ env: sb.env, cwd: sb.root });
    try {
      const r = await runMonitors(ctx, { force: true, all: true, provider });
      const m = r.monitors[0]!;
      assert.equal(m.scored, 2);
      assert.equal(m.stopped, "budget");
      assert.equal(calls, 2);
    } finally {
      await ctx.close();
    }
    const def = readMonitors(paths(sb.env).monitors).monitors[0]!;
    assert.equal(def.spend!.usd, 6);
    assert.match(def.lastError!.message, /max-usd-day/);
    assert.equal((await monitorScores(sb)).length, 2);
  });
});

describe("monitor --judge --provider gemini", () => {
  it("adds with exit 0, and with no GEMINI_API_KEY the warning names it", async () => {
    const sb = box();
    const rubric = join(sb.root, "rubric.md");
    writeFileSync(rubric, "Was the answer correct?\n");
    const r = await runCmd(monitorCmd, sb, { action: "add", positionals: ["g"], flags: { judge: rubric, provider: "gemini" } });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.code, 0);
    assert.match(r.stdout + r.stderr, /set GEMINI_API_KEY/);
    assert.equal(readMonitors(paths(sb.env).monitors).monitors[0]!.provider, "gemini");
  });
});

/** A local evaluator: answers each POST with the next queued reply and records what it got. */
async function evaluator(replies: ((res: ServerResponse) => void)[]) {
  const posts: { path: string; body: string; signature: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      posts.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), signature: req.headers[SIGNATURE_HEADER.toLowerCase()] as string | undefined });
      const next = replies.length > 1 ? replies.shift()! : replies[0]!;
      next(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`;
  servers.push(server);
  return { url, posts };
}
const servers: ReturnType<typeof createServer>[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done()))))));

const answer = (status: number, body: string, headers: Record<string, string> = {}) => (res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
};

async function addHttp(sb: Sandbox, name: string, url: string): Promise<string> {
  const r = await add(sb, name, { http: url });
  assert.match(r.json.secret, /^[0-9a-f]{64}$/, "32 random bytes in hex");
  assert.equal(r.json.monitor.secret, undefined, "the secret is printed once, apart from the definition");
  return r.json.secret as string;
}

describe("monitor --http", () => {
  it("retries a 503, scores the 200 answer, and signs each POST with the printed secret", async () => {
    const sb = box();
    const ev = await evaluator([answer(503, "busy"), answer(200, '{"value":1,"comment":"looks right"}')]);
    capture(sb, "mon-http-1", "add a retry");
    await ingest(sb);
    const secret = await addHttp(sb, "h", ev.url);
    const r = await runCmd(monitorCmd, sb, { action: "run", positionals: ["h"], flags: { since: "7d" }, json: true });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.monitors[0].scored, 1);
    const rows = await monitorScores(sb);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.targetId, rows[0]!.value, rows[0]!.comment, rows[0]!.judgeVersion], ["mon-http-1", 1, "looks right", monitorVersion(ev.url)]);
    assert.equal(ev.posts.length, 2, "one retry after the 503");
    for (const p of ev.posts) assert.equal(p.signature, signBody(secret, p.body));
    const doc = JSON.parse(ev.posts[1]!.body);
    assert.equal(doc.apiVersion, "v1");
    assert.equal(doc.monitor, "h");
    assert.equal(doc.session.session.id, "mon-http-1");
    assert.ok(doc.session.events.some((e: { kind: string; payload: { text?: string } }) => e.kind === "user.message" && e.payload.text === "add a retry"));

    const file = paths(sb.env).monitors;
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const listed = await runCmd(monitorCmd, sb, { action: "list", json: true });
    assert.equal(listed.json.monitors[0].secret, undefined, "list never shows the secret");
    assert.equal(listed.json.monitors[0].url, ev.url);
    const human = await runCmd(monitorCmd, sb, { action: "list" });
    assert.ok(!human.stdout.includes(secret));
    assert.match(human.stdout, /h\thttp: http:\/\/127\.0\.0\.1/);
  });

  it("a 4xx, a redirect, a 5xx three times, an answer without a value or one over 256 KB writes no score and records the status", async () => {
    const cases: [string, (res: ServerResponse) => void, RegExp, number][] = [
      ["bad", answer(400, "no such rubric"), /→ 400: no such rubric/, 1],
      ["moved", answer(302, "", { location: "/elsewhere" }), /→ 302/, 1],
      ["novalue", answer(200, '{"score":1}'), /not \{"value"/, 1],
      ["huge", answer(200, `{"value":1,"comment":"${"x".repeat(300 * 1024)}"}`), /256 KB/, 1],
      ["down", answer(500, "oops"), /→ 500: oops/, 3],
    ];
    for (const [name, reply, re, posts] of cases) {
      const sb = box();
      // A one-shot failure is followed by a good answer, so a retry would score; "down" always fails.
      const ev = await evaluator(posts === 1 ? [reply, answer(200, '{"value":1}')] : [reply]);
      capture(sb, `mon-http-${name}`);
      await ingest(sb);
      await addHttp(sb, name, ev.url);
      const r = await runCmd(monitorCmd, sb, { action: "run", positionals: [name], flags: { since: "7d" }, json: true });
      assert.equal(r.code, 1, `${name}: a failed monitor exits 1`);
      assert.equal(r.json.monitors[0].failed, 1, name);
      assert.equal((await monitorScores(sb)).length, 0, name);
      assert.equal(ev.posts.length, posts, `${name}: ${posts} attempt(s)`);
      const def = readMonitors(paths(sb.env).monitors).monitors[0]!;
      assert.match(def.lastError!.message, re, name);
      assert.equal(def.lastError!.sessionId, `mon-http-${name}`);
      // An answer is about the session, so the monitor moves past it; an evaluator that is down is not.
      assert.equal(def.cursor === undefined, name === "down", `${name}: cursor ${def.cursor}`);
    }
  });

  it("an evaluator that can't be reached stops the pass after 2 sessions, and the next pass starts at the first of them", async () => {
    const sb = box();
    const now = Date.now();
    const sessions = [mkSession("out-1", now - 30_000), mkSession("out-2", now - 20_000), mkSession("out-3", now - 10_000)];
    await sb.seed(sessions);
    const drop = (res: ServerResponse) => res.socket?.destroy();
    // out-1 gets a 500 on each of its 3 tries, out-2 a dropped connection; after that the evaluator is back.
    const ev = await evaluator([answer(500, "down"), answer(500, "down"), answer(500, "down"), drop, drop, drop, answer(200, '{"value":1}')]);
    await addHttp(sb, "out", ev.url);
    const ctx = await openContext({ env: sb.env, cwd: sb.root });
    try {
      const first = (await runMonitors(ctx, { force: true })).monitors[0]!;
      assert.deepEqual([first.scored, first.failed, first.stopped], [0, 2, "unreachable"]);
      assert.deepEqual(ev.posts.map((p) => JSON.parse(p.body).session.session.id), ["out-1", "out-1", "out-1", "out-2", "out-2", "out-2"], "out-3 is not tried");
      let def = readMonitors(paths(sb.env).monitors).monitors[0]!;
      assert.equal(def.cursor, undefined, "the cursor stays before out-1");
      assert.equal(def.lastError!.sessionId, "out-2");
      assert.match(def.lastError!.message, /out-2: POST http:\/\/127\.0\.0\.1:\d+\/score failed: .*; stopped after 2 sessions in a row/);

      const second = (await runMonitors(ctx, { force: true })).monitors[0]!;
      assert.deepEqual([second.scored, second.failed, second.stopped], [3, 0, undefined]);
      def = readMonitors(paths(sb.env).monitors).monitors[0]!;
      assert.equal(def.cursor, sessions[2]!.endedAt);
      assert.equal(def.lastError, undefined, "a clean pass clears the error");
    } finally {
      await ctx.close();
    }
    assert.deepEqual((await monitorScores(sb)).map((s) => s.targetId).sort(), ["out-1", "out-2", "out-3"]);
  });

  it("a session held for the next pass is found again when one that ended at the same moment was scored before it", async () => {
    const sb = box();
    const at = Date.now() - 10_000;
    await sb.seed([mkSession("tie-a", at), mkSession("tie-b", at)]);
    const ev = await evaluator([answer(200, '{"value":1}'), answer(503, "busy"), answer(503, "busy"), answer(503, "busy"), answer(200, '{"value":2}')]);
    await addHttp(sb, "tie", ev.url);
    const ctx = await openContext({ env: sb.env, cwd: sb.root });
    try {
      const first = (await runMonitors(ctx, { force: true })).monitors[0]!;
      assert.deepEqual([first.scored, first.failed], [1, 1]);
      assert.ok(readMonitors(paths(sb.env).monitors).monitors[0]!.cursor! < at + 1000, "the cursor is before the end both sessions share");
      const second = (await runMonitors(ctx, { force: true })).monitors[0]!;
      assert.deepEqual([second.scored, second.skipped], [1, 1]);
    } finally {
      await ctx.close();
    }
    assert.deepEqual((await monitorScores(sb)).map((s) => [s.targetId, s.value]).sort(), [["tie-a", 1], ["tie-b", 2]]);
  });

  it("add takes exactly one of --judge, --run or --http, and an http(s) URL without credentials", async () => {
    const sb = box();
    const bad = async (flags: Record<string, string | boolean | number>, re: RegExp) => {
      const r = await runCmd(monitorCmd, sb, { action: "add", positionals: ["m"], flags });
      assert.match(String(r.error?.message), re);
      assert.equal(r.error?.name, "UsageError", "exit 2");
    };
    await bad({ http: "http://127.0.0.1:1/x", run: "x" }, /--judge, --run or --http/);
    await bad({ http: "http://127.0.0.1:1/x", judge: "r.md" }, /--judge, --run or --http/);
    await bad({ http: "ftp://example.test/x" }, /http or https/);
    await bad({ http: "not a url" }, /http or https/);
    await bad({ http: "https://user:pw@example.test/x" }, /credentials/);
    await bad({ http: "https://example.test/x", provider: "mock" }, /--provider and --model go with --judge/);
  });
});

describe("serve's monitor timer", () => {
  it("scores sessions the writer ingested, through the write lane, and stops cleanly", async () => {
    const sb = box();
    capture(sb, "mon-timer-1");
    const first = await ingest(sb);
    assert.equal(first.json.monitors, undefined, "no monitors, no monitors field");
    await add(sb, "ok", { run: `${NODE} -e "console.log(JSON.stringify({value:1}))"` });
    const ctx = await openContext({ env: sb.env, cwd: sb.root });
    let writes = 0;
    const stop = startMonitorTimer({ index: ctx.index, env: sb.env, config: ctx.config, paths: paths(sb.env), intervalMs: 20, write: (fn) => (writes++, fn()) });
    try {
      const deadline = Date.now() + 30_000;
      while (!readMonitors(paths(sb.env).monitors).monitors[0]!.scored && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    } finally {
      await stop();
      await ctx.close();
    }
    assert.equal(writes, 1);
    assert.equal((await monitorScores(sb)).length, 1);
  });
});
