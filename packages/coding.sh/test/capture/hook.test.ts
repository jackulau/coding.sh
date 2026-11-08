import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { SpoolLine } from "../../src/core/types.ts";
import { MAX_INLINE_LINE_BYTES, SPOOL_FILE_CAP, appendSpool, resolveRaw, safeAgentId, spoolFile } from "../../src/spool/write.ts";
import { PKG_ROOT, gitc, isolate, makeRepo, removeTmp, tmp, tsNodeArgs } from "./_helpers.ts";

const HOOK_TS = join(PKG_ROOT, "src", "spool", "hook.ts");
let home = "";

before(() => {
  home = isolate();
});
after(() => removeTmp());

function freshHome(): string {
  return join(tmp("csh-hookhome-"), "home");
}

function runHook(args: string[], input: string | undefined, env: Record<string, string> = {}, script = HOOK_TS) {
  const nodeArgs = script.endsWith(".ts") ? tsNodeArgs() : [];
  const r = spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readLines(h: string, agent: string): SpoolLine[] {
  const dir = join(h, "spool", agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as SpoolLine);
}

describe("hook", () => {
  test("appends a SpoolLine with parsed JSON, payload cwd and runId; silent; exit 0", () => {
    const h = freshHome();
    const payload = { session_id: "s1", cwd: "/work/repo", hook_event_name: "PostToolUse", tool_input: { a: 1 } };
    const r = runHook(["claude-code", "PostToolUse"], JSON.stringify(payload), { CODING_SH_HOME: h, CODING_SH_RUN_ID: "run-7" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const files = readdirSync(join(h, "spool", "claude-code"));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const [line, ...rest] = readLines(h, "claude-code");
    assert.equal(rest.length, 0);
    assert.ok(line);
    assert.equal(line.v, 0);
    assert.equal(line.agent, "claude-code");
    assert.equal(line.event, "PostToolUse");
    assert.equal(line.cwd, "/work/repo");
    assert.equal(line.runId, "run-7");
    assert.deepEqual(line.raw, payload);
    assert.ok(Math.abs(line.ts - Date.now()) < 60_000);
    assert.equal(files[0], `${new Date(line.ts).toISOString().slice(0, 10)}.jsonl`);
  });

  test("a Claude Code hook records CLAUDE_CODE_ENTRYPOINT (how Claude Code was launched); other agents' do not", () => {
    const h = freshHome();
    const payload = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" });
    assert.equal(runHook(["claude-code", "SessionStart"], payload, { CODING_SH_HOME: h, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).code, 0);
    assert.equal(runHook(["codex", "SessionStart"], payload, { CODING_SH_HOME: h, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).code, 0);
    assert.deepEqual(readLines(h, "claude-code").map((l) => l.entrypoint), ["sdk-cli"]);
    assert.deepEqual(readLines(h, "codex").map((l) => l.entrypoint), [undefined]);
    const h2 = freshHome();
    assert.equal(runHook(["claude-code", "SessionStart"], payload, { CODING_SH_HOME: h2, CLAUDE_CODE_ENTRYPOINT: "" }).code, 0);
    assert.equal(readLines(h2, "claude-code")[0]!.entrypoint, undefined);
  });

  test("session-start and prompt lines record the repo HEAD read from .git; tool lines and CODING_SH_NO_GIT_HEAD do not", () => {
    const h = freshHome();
    const repo = makeRepo({ "a.txt": "a\n" });
    const head = gitc(repo, "rev-parse", "HEAD");
    const hook = (event: string, env: Record<string, string> = {}) =>
      runHook(["claude-code", event], JSON.stringify({ session_id: "s1", hook_event_name: event, cwd: join(repo, "sub") }), { CODING_SH_HOME: h, ...env });
    for (const e of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) assert.equal(hook(e).code, 0);
    assert.equal(hook("SessionStart", { CODING_SH_NO_GIT_HEAD: "1" }).code, 0);
    assert.deepEqual(
      readLines(h, "claude-code")
        .sort((a, b) => a.ts - b.ts)
        .map((l) => [l.event, l.git]),
      [
        ["SessionStart", { root: repo, head, branch: "main" }],
        ["UserPromptSubmit", { root: repo, head, branch: "main" }],
        ["PostToolUse", undefined],
        ["SessionStart", undefined],
      ],
    );
  });

  test("a corrupt HEAD still exits 0 silently, with no git field", () => {
    const h = freshHome();
    const repo = makeRepo({ "a.txt": "a\n" });
    writeFileSync(join(repo, ".git", "HEAD"), "\0\0garbage");
    const r = runHook(["claude-code", "SessionStart"], JSON.stringify({ session_id: "s1", cwd: repo }), { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const [line] = readLines(h, "claude-code");
    assert.equal(line?.event, "SessionStart");
    assert.equal(line?.git, undefined);
    assert.equal(existsSync(join(h, "spool", "errors.log")), false);
  });

  test("non-JSON stdin is kept as a string; no stdin is an empty string; cwd falls back to process cwd", () => {
    const h = freshHome();
    assert.equal(runHook(["codex", "notify"], "not json {", { CODING_SH_HOME: h }).code, 0);
    assert.equal(runHook(["codex", "notify"], undefined, { CODING_SH_HOME: h }).code, 0);
    const lines = readLines(h, "codex").sort((a, b) => a.ts - b.ts);
    assert.deepEqual(lines.map((l) => l.raw).sort(), ["", "not json {"]);
    assert.equal(lines[0]?.cwd, process.cwd());
    assert.equal(lines[0]?.runId, undefined);
  });

  test("payloads over 256 KB go to a side file referenced by rawFile", () => {
    const h = freshHome();
    const big = { cwd: "/big/repo", blob: "x".repeat(MAX_INLINE_LINE_BYTES + 10) };
    const text = JSON.stringify(big);
    assert.equal(runHook(["claude-code", "PreCompact"], text, { CODING_SH_HOME: h }).code, 0);
    const [line] = readLines(h, "claude-code");
    assert.ok(line?.rawFile);
    assert.equal("raw" in line, false);
    assert.equal(line.cwd, "/big/repo"); // sniffed without a full parse
    assert.ok(line.rawFile.startsWith(join(h, "spool", "claude-code", "raw")));
    assert.equal(readFileSync(line.rawFile, "utf8"), text);
    assert.deepEqual(resolveRaw(line), big);
  });

  test("CODING_SH_DISABLE=1 is a no-op", () => {
    const h = freshHome();
    const r = runHook(["claude-code", "Stop"], "{}", { CODING_SH_HOME: h, CODING_SH_DISABLE: "1" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(h), false);
  });

  test("--echo-continue prints exactly {\"continue\":true}", () => {
    const h = freshHome();
    const r = runHook(["cursor", "beforeSubmitPrompt", "--echo-continue"], "{}", { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"continue":true}\n');
    assert.equal(readLines(h, "cursor").length, 1);
    const r2 = runHook(["cursor", "stop"], "{}", { CODING_SH_HOME: h, CODING_SH_ECHO_CONTINUE: "1", CODING_SH_DISABLE: "1" });
    assert.equal(r2.stdout, '{"continue":true}\n');
  });

  test("--reply prints the given JSON document compacted, even when disabled; records ppid", () => {
    const h = freshHome();
    const r = runHook(["cursor", "beforeSubmitPrompt", "--reply", '{ "continue": true }'], "{}", { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"continue":true}\n');
    const [line] = readLines(h, "cursor");
    assert.equal(line?.event, "beforeSubmitPrompt", "the reply value is not taken as a positional");
    assert.equal(line?.ppid, process.pid);
    const r2 = runHook(["x", "y", '--reply={"decision":"ask"}'], "{}", { CODING_SH_HOME: h, CODING_SH_DISABLE: "1" });
    assert.equal(r2.stdout, '{"decision":"ask"}\n');
    const r3 = runHook(["x", "y", "--reply", "{not json"], "{}", { CODING_SH_HOME: h });
    assert.equal(r3.code, 0);
    assert.equal(r3.stdout, "", "invalid reply prints nothing");
    assert.match(readFileSync(join(h, "spool", "errors.log"), "utf8"), /--reply is not valid JSON/);
  });

  test("I/O failure is logged to errors.log and still exits 0 silently", () => {
    const h = freshHome();
    mkdirSync(join(h, "spool"), { recursive: true });
    writeFileSync(join(h, "spool", "claude-code"), "I am a file, not a dir");
    const r = runHook(["claude-code", "Stop"], "{}", { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const log = readFileSync(join(h, "spool", "errors.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    const entry = JSON.parse(log[0]!);
    assert.equal(entry.agent, "claude-code");
    assert.equal(entry.event, "Stop");
    assert.match(entry.code, /ENOTDIR|EEXIST/);
  });

  test("hostile agent ids cannot escape the spool dir", () => {
    const h = freshHome();
    assert.equal(runHook(["../../etc", "x"], "{}", { CODING_SH_HOME: h }).code, 0);
    assert.deepEqual(readdirSync(join(h, "spool")), ["unknown"]);
    assert.equal(safeAgentId("Claude-Code"), "claude-code");
    assert.equal(safeAgentId("a/b"), "unknown");
    assert.equal(safeAgentId(""), "unknown");
  });

  test("concurrent hooks never interleave lines", async () => {
    const h = freshHome();
    const n = 24;
    const payload = JSON.stringify({ cwd: "/c", data: "y".repeat(100_000) });
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(process.execPath, [...tsNodeArgs(), HOOK_TS, "opencode", `e${i}`], { env: { ...process.env, CODING_SH_HOME: h }, stdio: ["pipe", "ignore", "ignore"] });
          c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          c.stdin.end(payload);
        }),
      ),
    );
    const lines = readLines(h, "opencode");
    assert.equal(lines.length, n);
    assert.equal(new Set(lines.map((l) => l.event)).size, n);
    assert.equal(readdirSync(join(h, "spool", "opencode")).filter((f) => f.endsWith(".jsonl")).length, 1, "one shared day file");
  });

  test("processes appending to the shared day file at the same time never interleave lines", async () => {
    const h = freshHome();
    const writers = 8;
    const each = 100;
    const start = Date.now() + 1500; // every writer starts its loop at the same moment
    const script = `
      const { appendSpool } = await import(${JSON.stringify(pathToFileURL(join(PKG_ROOT, "src", "spool", "write.ts")).href)});
      while (Date.now() < ${start});
      const w = Number(process.argv[1]);
      for (let i = 0; i < ${each}; i++)
        appendSpool({ v: 0, agent: "fake", event: "w" + w + "-" + i, ts: ${Date.UTC(2026, 0, 2)}, pid: process.pid, cwd: "/c", raw: { data: String(w).repeat(5_000 + ((i * 7919) % 120_000)) } });
    `;
    await Promise.all(
      Array.from({ length: writers }, (_, w) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(process.execPath, [...tsNodeArgs(), "--input-type=module", "-e", script, String(w)], { env: { ...process.env, CODING_SH_HOME: h }, stdio: ["ignore", "ignore", "pipe"] });
          let err = "";
          c.stderr.on("data", (d) => (err += d));
          c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err}`))));
        }),
      ),
    );
    for (const f of readdirSync(join(h, "spool", "fake"))) assert.match(f, /^2026-01-02(\.\d+)?\.jsonl$/);
    const lines = readLines(h, "fake"); // JSON.parse throws on an interleaved line
    assert.equal(lines.length, writers * each);
    assert.equal(new Set(lines.map((l) => l.event)).size, writers * each);
    for (const l of lines) assert.equal((l.raw as { data: string }).data[0], l.event.slice(1, l.event.indexOf("-")));
  });
});

describe("appendSpool", () => {
  test("writes one file per UTC day for every writer, honors disable, offloads big raw objects", () => {
    const env = { ...process.env, CODING_SH_HOME: freshHome() };
    const base: SpoolLine = { v: 0, agent: "wrapper", event: "session.start", ts: Date.UTC(2026, 0, 2, 3), pid: 4242, cwd: "/r", raw: { a: 1 } };
    const f = appendSpool(base, env);
    assert.equal(f, spoolFile("wrapper", base.ts, env));
    assert.ok(f?.endsWith("2026-01-02.jsonl"));
    assert.equal(appendSpool({ ...base, event: "session.end", pid: 4343 }, env), f, "another process, same file");
    const lines = readFileSync(f!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["session.start", "session.end"]);
    assert.equal(appendSpool(base, { ...env, CODING_SH_DISABLE: "1" }), undefined);
    const bigRaw = { patch: "+".repeat(MAX_INLINE_LINE_BYTES) };
    appendSpool({ ...base, event: "big", raw: bigRaw }, env);
    const last = JSON.parse(readFileSync(f!, "utf8").trim().split("\n").pop()!) as SpoolLine;
    assert.ok(last.rawFile);
    assert.deepEqual(resolveRaw(last), bigRaw);
  });

  test("a failed append leaves no raw side file behind", () => {
    const env = { ...process.env, CODING_SH_HOME: freshHome() };
    const line: SpoolLine = { v: 0, agent: "fake", event: "PostToolUse", ts: Date.now(), pid: 777, cwd: "/r", raw: null };
    mkdirSync(spoolFile("fake", line.ts, env), { recursive: true }); // the append fails (EISDIR, like ENOSPC)
    const big = JSON.stringify({ secret: "sk-live-" + "A".repeat(MAX_INLINE_LINE_BYTES) });
    assert.throws(() => appendSpool({ ...line, raw: JSON.parse(big) }, env, { rawText: big }), { code: "EISDIR" });
    const rawDir = join(env.CODING_SH_HOME, "spool", "fake", "raw");
    assert.deepEqual(existsSync(rawDir) ? readdirSync(rawDir) : [], [], "payload not orphaned");
  });

  test("starts on a fresh line after a torn fragment, so the fragment cannot swallow the new line", () => {
    const env = { ...process.env, CODING_SH_HOME: freshHome() };
    const base: SpoolLine = { v: 0, agent: "fake", event: "Stop", ts: Date.now(), pid: 555, cwd: "/r", raw: { a: 1 } };
    const f = spoolFile("fake", base.ts, env);
    mkdirSync(join(f, ".."), { recursive: true });
    appendFileSync(f, JSON.stringify(base) + "\n" + JSON.stringify(base).slice(0, 30)); // partial write (ENOSPC)
    appendSpool({ ...base, event: "UserPromptSubmit" }, env);
    const lines = readFileSync(f, "utf8").split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[1], JSON.stringify(base).slice(0, 30), "fragment isolated on its own line");
    assert.equal((JSON.parse(lines[2]!) as SpoolLine).event, "UserPromptSubmit");
    assert.equal(lines[3], "");
  });

  test("a day file at the size cap is left alone: the day continues in <day>.1.jsonl, then <day>.2.jsonl", () => {
    const env = { ...process.env, CODING_SH_HOME: freshHome() };
    const base: SpoolLine = { v: 0, agent: "fake", event: "PostToolUse", ts: Date.UTC(2026, 0, 2, 3), pid: 1, cwd: "/r", raw: { a: 1 } };
    const first = appendSpool(base, env)!;
    assert.ok(first.endsWith("2026-01-02.jsonl"));
    truncateSync(first, SPOOL_FILE_CAP); // sparse: no 64 MB written
    const second = appendSpool({ ...base, event: "Stop" }, env)!;
    assert.ok(second.endsWith("2026-01-02.1.jsonl"), second);
    assert.equal(statSync(first).size, SPOOL_FILE_CAP, "the full file is not appended to");
    assert.equal(appendSpool({ ...base, event: "Stop2" }, env), second);
    truncateSync(second, SPOOL_FILE_CAP + 10);
    assert.ok(appendSpool(base, env)!.endsWith("2026-01-02.2.jsonl"));
    assert.ok(appendSpool({ ...base, ts: Date.UTC(2026, 0, 3) }, env)!.endsWith("2026-01-03.jsonl"), "a new day starts a new file");
  });
});

describe("hook performance", () => {
  // Absolute times swing 10x under parallel test load, so the hook is timed against a
  // bare node start that reads the same stdin, interleaved pair by pair so both see
  // the same load. Idle on the desk: hook/bare ≈ 1.05; a hook made 2x slower ≈ 2.1
  // (≈ 1.8 with every core busy). One re-measure absorbs a burst; a real
  // regression fails both.
  test("bundled hook: 10 KB payload costs under 1.5x a bare node start", { timeout: 120_000 }, async () => {
    let script = HOOK_TS;
    try {
      const { build } = await import("esbuild");
      const out = join(tmp("csh-bundle-"), "hook.mjs");
      await build({ entryPoints: [HOOK_TS], bundle: true, platform: "node", format: "esm", target: "node22", minify: true, outfile: out, logLevel: "silent" });
      script = out;
    } catch {
      // esbuild unavailable: measure the .ts source (slower: type stripping at startup)
    }
    const bundled = script.endsWith(".mjs");
    const h = freshHome();
    const payload = JSON.stringify({ cwd: "/p", session_id: "s", tool_response: "z".repeat(10_000) });
    const bare = () => spawnSync(process.execPath, ["-e", "process.stdin.resume()"], { input: payload, env: { ...process.env, CODING_SH_HOME: h } });
    runHook(["claude-code", "warmup"], payload, { CODING_SH_HOME: h }, script); // warms the OS file cache only
    bare();
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
    const measure = () => {
      const hook: number[] = [];
      const base: number[] = [];
      for (let i = 0; i < 9; i++) {
        let t = performance.now();
        bare();
        base.push(performance.now() - t);
        t = performance.now();
        const r = runHook(["claude-code", "PostToolUse"], payload, { CODING_SH_HOME: h }, script);
        hook.push(performance.now() - t);
        assert.equal(r.code, 0);
      }
      return { hook: median(hook), bare: median(base), ratio: median(hook) / median(base) };
    };
    const limit = bundled ? 1.5 : 3; // .ts source pays for type stripping
    let m = measure();
    const first = m;
    if (m.ratio >= limit) m = measure();
    console.log(`# hook (${bundled ? "bundled" : "ts source"}): median ${m.hook.toFixed(1)} ms, bare node ${m.bare.toFixed(1)} ms, ratio ${m.ratio.toFixed(2)}${m === first ? "" : ` (first try ${first.ratio.toFixed(2)})`}`);
    assert.ok(m.ratio < limit, `hook ${m.hook.toFixed(1)} ms is ${m.ratio.toFixed(2)}x a bare node start (${m.bare.toFixed(1)} ms); limit ${limit}x`);
    assert.equal(readLines(h, "claude-code").length, m === first ? 10 : 19);
  });
});

void home;
