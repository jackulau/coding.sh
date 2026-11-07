import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SpoolLine } from "../../src/core/types.ts";
import { MAX_INLINE_LINE_BYTES, appendSpool, resolveRaw, safeAgentId, spoolFile } from "../../src/spool/write.ts";
import { PKG_ROOT, isolate, removeTmp, tmp, tsNodeArgs } from "./_helpers.ts";

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
    assert.match(files[0]!, /^\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/);
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
    assert.equal(files[0], `${new Date(line.ts).toISOString().slice(0, 10)}.${line.pid}.jsonl`);
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
  });
});

describe("appendSpool", () => {
  test("writes per-pid daily files, honors disable, offloads big raw objects", () => {
    const env = { ...process.env, CODING_SH_HOME: freshHome() };
    const base: SpoolLine = { v: 0, agent: "wrapper", event: "session.start", ts: Date.UTC(2026, 0, 2, 3), pid: 4242, cwd: "/r", raw: { a: 1 } };
    const f = appendSpool(base, env);
    assert.equal(f, spoolFile("wrapper", base.ts, 4242, env));
    assert.ok(f?.endsWith("2026-01-02.4242.jsonl"));
    appendSpool({ ...base, event: "session.end" }, env);
    const lines = readFileSync(f!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["session.start", "session.end"]);
    assert.equal(appendSpool(base, { ...env, CODING_SH_DISABLE: "1" }), undefined);
    const bigRaw = { patch: "+".repeat(MAX_INLINE_LINE_BYTES) };
    appendSpool({ ...base, event: "big", raw: bigRaw }, env);
    const last = JSON.parse(readFileSync(f!, "utf8").trim().split("\n").pop()!) as SpoolLine;
    assert.ok(last.rawFile);
    assert.deepEqual(resolveRaw(last), bigRaw);
  });
});

describe("hook performance", () => {
  test("bundled hook: 10 KB payload well under 150 ms", { timeout: 60_000 }, async () => {
    let script = HOOK_TS;
    try {
      const { build } = await import("esbuild");
      const out = join(tmp("csh-bundle-"), "hook.mjs");
      await build({ entryPoints: [HOOK_TS], bundle: true, platform: "node", format: "esm", target: "node22", minify: true, outfile: out, logLevel: "silent" });
      script = out;
    } catch {
      // esbuild unavailable: measure the .ts source (slower: type stripping at startup)
    }
    const h = freshHome();
    const payload = JSON.stringify({ cwd: "/p", session_id: "s", tool_response: "z".repeat(10_000) });
    runHook(["claude-code", "warmup"], payload, { CODING_SH_HOME: h }, script); // first run warms the OS file cache only
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const r = runHook(["claude-code", "PostToolUse"], payload, { CODING_SH_HOME: h }, script);
      times.push(performance.now() - t);
      assert.equal(r.code, 0);
    }
    times.sort((a, b) => a - b);
    const t0 = performance.now();
    spawnSync(process.execPath, ["-e", "0"]);
    const bare = performance.now() - t0;
    const median = times[3]!;
    console.log(`# hook (${script.endsWith(".mjs") ? "bundled" : "ts source"}): median ${median.toFixed(1)} ms, min ${times[0]!.toFixed(1)} ms, max ${times[6]!.toFixed(1)} ms; bare node ${bare.toFixed(1)} ms`);
    assert.ok(median < 150, `median ${median} ms`);
    assert.equal(readLines(h, "claude-code").length, 8);
  });
});

void home;
