// The hook contract (exit 0, silent, one SpoolLine per call, side files, the
// shared day file, no git work) runs against both implementations: hook.ts
// (bundled to hook.mjs) and the POSIX sh fast path hook.sh, which hands the
// cases it does not cover to a hook.mjs beside it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { SpoolLine } from "../../src/core/types.ts";
import { MAX_INLINE_LINE_BYTES, SPOOL_FILE_CAP, appendSpool, resolveRaw, safeAgentId, spoolFile } from "../../src/spool/write.ts";
import { PKG_ROOT, gitc, isolate, makeRepo, removeTmp, tmp, tsNodeArgs } from "./_helpers.ts";
import { median, pairedRatio, timeMs } from "../helpers-timing.ts";

const HOOK_TS = join(PKG_ROOT, "src", "spool", "hook.ts");
const HOOK_SH_SRC = join(PKG_ROOT, "src", "spool", "hook.sh");
let home = "";

type Impl = "node" | "sh";
/** The sh fast path is what agents run outside Windows. */
const IMPLS: Impl[] = process.platform === "win32" ? ["node"] : ["node", "sh"];
/** hook.sh next to a bundled hook.mjs, as ~/.coding.sh/bin holds them. */
let HOOK_SH = "";
/** PATH for sh runs: a `node` that logs each start (to NODE_LOG) before running the real one. */
let SH_PATH = "";
let NODE_LOG = "";

before(async () => {
  home = isolate();
  if (!IMPLS.includes("sh")) return;
  const bin = tmp("csh-hookbin-");
  const { build } = await import("esbuild");
  await build({ entryPoints: [HOOK_TS], bundle: true, platform: "node", format: "esm", target: "node22", minify: true, outfile: join(bin, "hook.mjs"), logLevel: "silent" });
  HOOK_SH = join(bin, "hook.sh");
  copyFileSync(HOOK_SH_SRC, HOOK_SH);
  const shim = tmp("csh-nodeshim-");
  NODE_LOG = join(shim, "node.log");
  writeFileSync(join(shim, "node"), `#!/bin/sh\necho "$*" >> "$NODE_LOG"\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(join(shim, "node"), 0o755);
  SH_PATH = [shim, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
});
after(() => removeTmp());

function freshHome(): string {
  return join(tmp("csh-hookhome-"), "home");
}

function runHook(args: string[], input: string | undefined, env: Record<string, string> = {}, script: string | Impl = HOOK_TS, cwd?: string) {
  const sh = script === "sh";
  const file = script === "node" ? HOOK_TS : sh ? HOOK_SH : script;
  const nodeArgs = file.endsWith(".ts") ? tsNodeArgs() : [];
  const childEnv: Record<string, string | undefined> = { ...process.env, ...(sh ? { PATH: SH_PATH, NODE_LOG } : {}), ...env };
  // Parent agents' session markers from the test runner's own env (an agent running the tests) stay out.
  // sh takes $PWD from the env when it names the cwd (maybe through a symlink); node reports the real path.
  if (sh && !("PWD" in env)) delete childEnv.PWD;
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "T3CODE_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) if (!(k in env)) delete childEnv[k];
  const r = spawnSync(sh ? "/bin/sh" : process.execPath, sh ? [file, ...args] : [...nodeArgs, file, ...args], {
    input,
    cwd,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const runHook_sh = (args: string[], input: string | undefined, env: Record<string, string> = {}, cwd?: string) => runHook(args, input, env, "sh", cwd);

/** Node starts the sh hook made since the last call (its fallback to hook.mjs). */
function nodeStarts(): number {
  if (!existsSync(NODE_LOG)) return 0;
  const n = readFileSync(NODE_LOG, "utf8").split("\n").filter(Boolean).length;
  writeFileSync(NODE_LOG, "");
  return n;
}

function readLines(h: string, agent: string): SpoolLine[] {
  const dir = join(h, "spool", agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as SpoolLine);
}

for (const impl of IMPLS) describe(`hook contract (${impl === "node" ? "hook.mjs" : "hook.sh"})`, () => {
  const runHook_ = (args: string[], input: string | undefined, env: Record<string, string> = {}, cwd?: string) => runHook(args, input, env, impl, cwd);

  test("appends a SpoolLine with parsed JSON, payload cwd and runId; silent; exit 0", () => {
    const h = freshHome();
    const payload = { session_id: "s1", cwd: "/work/repo", hook_event_name: "PostToolUse", tool_input: { a: 1 } };
    const r = runHook_(["claude-code", "PostToolUse"], JSON.stringify(payload), { CODING_SH_HOME: h, CODING_SH_RUN_ID: "run-7" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const [line, ...rest] = readLines(h, "claude-code");
    assert.equal(rest.length, 0);
    assert.equal(line?.runId, "run-7");
    assert.deepEqual(line?.raw, payload);
  });

  test("writes a SpoolLine: inline JSON, payload cwd, pid and ppid, the UTC day file; silent; exit 0", () => {
    const h = freshHome();
    const payload = { session_id: "s1", cwd: "/work/repo", hook_event_name: "PostToolUse", tool_input: { a: 1, s: "é \"q\" \\" } };
    nodeStarts();
    const r = runHook_(["claude-code", "PostToolUse"], JSON.stringify(payload) + "\n", { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    if (impl === "sh") assert.equal(nodeStarts(), 0, "the sh fast path starts no node");
    const files = readdirSync(join(h, "spool", "claude-code"));
    assert.equal(files.length, 1);
    const [line, ...rest] = readLines(h, "claude-code");
    assert.equal(rest.length, 0);
    assert.ok(line);
    assert.equal(line.v, 0);
    assert.equal(line.agent, "claude-code");
    assert.equal(line.event, "PostToolUse");
    assert.equal(line.cwd, "/work/repo");
    assert.equal(line.runId, undefined);
    assert.equal(line.rawFile, undefined);
    assert.deepEqual(line.raw, payload);
    assert.equal(typeof line.pid, "number");
    assert.equal(line.ppid, process.pid);
    assert.ok(Math.abs(line.ts - Date.now()) < 60_000);
    assert.ok(Number.isInteger(line.ts));
    assert.equal(files[0], `${new Date(line.ts).toISOString().slice(0, 10)}.jsonl`);
  });
  test("a Claude Code hook records CLAUDE_CODE_ENTRYPOINT (how Claude Code was launched); other agents' do not", () => {
    const h = freshHome();
    const payload = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" });
    assert.equal(runHook_(["claude-code", "SessionStart"], payload, { CODING_SH_HOME: h, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).code, 0);
    assert.equal(runHook_(["codex", "SessionStart"], payload, { CODING_SH_HOME: h, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).code, 0);
    assert.deepEqual(readLines(h, "claude-code").map((l) => l.entrypoint), ["sdk-cli"]);
    assert.deepEqual(readLines(h, "codex").map((l) => l.entrypoint), [undefined]);
    const h2 = freshHome();
    assert.equal(runHook_(["claude-code", "SessionStart"], payload, { CODING_SH_HOME: h2, CLAUDE_CODE_ENTRYPOINT: "" }).code, 0);
    assert.equal(readLines(h2, "claude-code")[0]!.entrypoint, undefined);
  });

  test("non-JSON stdin is kept as a string; no stdin is an empty string; cwd falls back to process cwd", () => {
    const h = freshHome();
    assert.equal(runHook_(["codex", "notify"], "not json {", { CODING_SH_HOME: h }).code, 0);
    assert.equal(runHook_(["codex", "notify"], undefined, { CODING_SH_HOME: h }).code, 0);
    const lines = readLines(h, "codex").sort((a, b) => a.ts - b.ts);
    assert.deepEqual(lines.map((l) => resolveRaw(l)).sort(), ["", "not json {"]);
    assert.equal(lines[0]?.cwd, process.cwd());
    assert.equal(lines[0]?.runId, undefined);
  });

  test("payloads over 256 KB go to a side file referenced by rawFile", () => {
    const h = freshHome();
    const big = { cwd: "/big/repo", blob: "x".repeat(MAX_INLINE_LINE_BYTES + 10) };
    const text = JSON.stringify(big);
    assert.equal(runHook_(["claude-code", "PreCompact"], text, { CODING_SH_HOME: h }).code, 0);
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
    const r = runHook_(["claude-code", "Stop"], "{}", { CODING_SH_HOME: h, CODING_SH_DISABLE: "1" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(h), false);
  });

  test("--echo-continue prints exactly {\"continue\":true}", () => {
    const h = freshHome();
    const r = runHook_(["cursor", "beforeSubmitPrompt", "--echo-continue"], "{}", { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"continue":true}\n');
    assert.equal(readLines(h, "cursor").length, 1);
    const r2 = runHook_(["cursor", "stop"], "{}", { CODING_SH_HOME: h, CODING_SH_ECHO_CONTINUE: "1", CODING_SH_DISABLE: "1" });
    assert.equal(r2.stdout, '{"continue":true}\n');
  });

  test("--reply prints the given JSON document compacted, even when disabled; records ppid", () => {
    const h = freshHome();
    const r = runHook_(["cursor", "beforeSubmitPrompt", "--reply", '{ "continue": true }'], "{}", { CODING_SH_HOME: h });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"continue":true}\n');
    const [line] = readLines(h, "cursor");
    assert.equal(line?.event, "beforeSubmitPrompt", "the reply value is not taken as a positional");
    assert.equal(line?.ppid, process.pid);
    const r2 = runHook_(["x", "y", '--reply={"decision":"ask"}'], "{}", { CODING_SH_HOME: h, CODING_SH_DISABLE: "1" });
    assert.equal(r2.stdout, '{"decision":"ask"}\n');
    const r3 = runHook_(["x", "y", "--reply", "{not json"], "{}", { CODING_SH_HOME: h });
    assert.equal(r3.code, 0);
    assert.equal(r3.stdout, "", "invalid reply prints nothing");
    assert.match(readFileSync(join(h, "spool", "errors.log"), "utf8"), /--reply is not valid JSON/);
  });

  test("I/O failure is logged to errors.log and still exits 0 silently", () => {
    const h = freshHome();
    mkdirSync(join(h, "spool"), { recursive: true });
    writeFileSync(join(h, "spool", "claude-code"), "I am a file, not a dir");
    const r = runHook_(["claude-code", "Stop"], "{}", { CODING_SH_HOME: h });
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
    assert.equal(runHook_(["../../etc", "x"], "{}", { CODING_SH_HOME: h }).code, 0);
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
          const argv = impl === "sh" ? ["/bin/sh", HOOK_SH] : [process.execPath, ...tsNodeArgs(), HOOK_TS];
          const c = spawn(argv[0]!, [...argv.slice(1), "opencode", `e${i}`], { env: { ...process.env, CODING_SH_HOME: h, ...(impl === "sh" ? { PATH: SH_PATH, NODE_LOG } : {}) }, stdio: ["pipe", "ignore", "ignore"] });
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

  test("records parent agents' session ids from the env as spawnedBy; none in an eval run or for unsafe ids", () => {
    const h = freshHome();
    const payload = JSON.stringify({ session_id: "child", hook_event_name: "SessionStart" });
    const env = { CODING_SH_HOME: h, CLAUDE_CODE_SESSION_ID: "c1a2-b3", CODEX_THREAD_ID: "019a-thread", CODEX_TOOL_CALL_ID: "call_7" };
    assert.equal(runHook_(["codex", "SessionStart"], payload, env).code, 0);
    assert.equal(runHook_(["gemini-cli", "SessionStart"], payload, { CODING_SH_HOME: h, CLAUDE_CODE_SESSION_ID: "c1a2-b3" }).code, 0);
    assert.equal(runHook_(["codex", "SessionStart"], payload, { ...env, CODING_SH_HOME: freshHome(), CODING_SH_RUN_ID: "run-1" }).code, 0);
    assert.deepEqual(readLines(h, "codex").map((l) => l.spawnedBy), [
      [
        { agent: "claude-code", session: "c1a2-b3" },
        { agent: "codex", session: "019a-thread", toolCallId: "call_7" },
      ],
    ]);
    assert.deepEqual(readLines(h, "gemini-cli").map((l) => l.spawnedBy), [[{ agent: "claude-code", session: "c1a2-b3" }]]);
    const h2 = freshHome();
    assert.equal(runHook_(["codex", "SessionStart"], payload, { CODING_SH_HOME: h2, CLAUDE_CODE_SESSION_ID: 'x"y' }).code, 0);
    assert.equal(readLines(h2, "codex")[0]!.spawnedBy, undefined);
    assert.deepEqual(readLines(h2, "codex")[0]!.raw, JSON.parse(payload));
  });
});

const describeSh = IMPLS.includes("sh") ? describe : describe.skip;
describeSh("hook.sh", () => {
  test("inlines one-line JSON objects whose line fits in 1024 bytes; anything else goes to a side file; never starts node", () => {
    const h = freshHome();
    const env = { CODING_SH_HOME: h };
    const small = { cwd: "/w", s: "a".repeat(800) };
    const big = { cwd: "/w", s: "b".repeat(1000) };
    const multi = '{\n  "cwd": "/w",\n  "n": 1\n}';
    nodeStarts();
    for (const [event, text] of [["e1", JSON.stringify(small)], ["e2", JSON.stringify(big)], ["e3", multi], ["e4", "[1,2]"], ["e5", "{}"]] as const) assert.equal(runHook_sh([`claude-code`, event], text + "\n", env).code, 0);
    assert.equal(nodeStarts(), 0);
    const byEvent = new Map(readLines(h, "claude-code").map((l) => [l.event, l]));
    assert.deepEqual(byEvent.get("e1")!.raw, small);
    assert.equal(byEvent.get("e1")!.rawFile, undefined);
    for (const e of ["e2", "e3", "e4"]) {
      const l = byEvent.get(e)!;
      assert.ok(l.rawFile?.startsWith(join(h, "spool", "claude-code", "raw") + "/"), e);
      assert.equal("raw" in l, false);
      assert.equal(statSync(l.rawFile!).mode & 0o777, 0o600);
    }
    assert.deepEqual(resolveRaw(byEvent.get("e2")!), big);
    assert.deepEqual(resolveRaw(byEvent.get("e3")!), { cwd: "/w", n: 1 });
    assert.deepEqual(resolveRaw(byEvent.get("e4")!), [1, 2]);
    assert.deepEqual(byEvent.get("e5")!.raw, {});
    assert.equal(byEvent.get("e2")!.cwd, "/w", "the payload cwd, read without a parse");
    assert.equal(statSync(join(h, "spool", "claude-code")).mode & 0o777, 0o700);
    for (const f of readdirSync(join(h, "spool", "claude-code"))) if (f.endsWith(".jsonl")) assert.equal(statSync(join(h, "spool", "claude-code", f)).mode & 0o777, 0o600);
  });

  test("a cwd it cannot copy into JSON as is falls back to the process cwd", () => {
    const h = freshHome();
    const cwd = tmp("csh-shcwd-");
    assert.equal(runHook_sh(["codex", "e"], JSON.stringify({ cwd: "C:\\work\\x" }), { CODING_SH_HOME: h }, cwd).code, 0);
    const [line] = readLines(h, "codex");
    assert.equal(line!.cwd, realpathSync(cwd));
    assert.deepEqual(line!.raw, { cwd: "C:\\work\\x" });
  });

  test("appends to the day's latest numbered continuation", () => {
    const h = freshHome();
    const dir = join(h, "spool", "codex");
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, `${day}.1.jsonl`), "");
    writeFileSync(join(dir, `${day}.2.jsonl`), "");
    assert.equal(runHook_sh(["codex", "e"], "{}", { CODING_SH_HOME: h }).code, 0);
    const files = readdirSync(dir).filter((f) => readFileSync(join(dir, f), "utf8"));
    if (new Date().toISOString().slice(0, 10) === day) assert.deepEqual(files, [`${day}.2.jsonl`]);
  });

  test("names the UTC day file as hook.mjs does, across leap days, century years and day ends", () => {
    // A date(1) on PATH that prints a fixed time (dash and bash 3.2 read the clock through it).
    const bin = tmp("csh-fakedate-");
    writeFileSync(join(bin, "date"), '#!/bin/sh\ncase "$1" in +%s) echo "${FAKE_NOW%?????????}" ;; *) echo "$FAKE_NOW" ;; esac\n');
    chmodSync(join(bin, "date"), 0o755);
    const h = freshHome();
    const times = [0, Date.UTC(2000, 1, 29, 12), Date.UTC(2024, 11, 31, 23, 59, 59, 999), Date.UTC(2025, 0, 1), Date.UTC(2100, 1, 28, 23, 59, 59), Date.UTC(2100, 2, 1), Date.UTC(2026, 10, 8, 4, 5, 6, 7)];
    for (const [i, t] of times.entries()) {
      const ns = String(t * 1_000_000 + 123_456).padStart(10, "0");
      // CODING_SH_HOOK_REEXEC: dash stays dash (no move to bash 5, which has its own clock).
      assert.equal(runHook_sh(["codex", `t${i}`], "{}", { CODING_SH_HOME: h, PATH: `${bin}:${SH_PATH}`, FAKE_NOW: ns, CODING_SH_HOOK_REEXEC: "1" }).code, 0);
    }
    const dir = join(h, "spool", "codex");
    const got = new Map<string, string>();
    for (const f of readdirSync(dir)) for (const l of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) got.set((JSON.parse(l) as SpoolLine).event, f);
    const lines = readLines(h, "codex");
    // bash 5 reads EPOCHREALTIME instead of date(1): nothing to check there.
    if (lines.some((l) => l.ts > 1e12 && l.ts !== times[Number(l.event.slice(1))])) return;
    for (const [i, t] of times.entries()) assert.equal(got.get(`t${i}`), `${new Date(t).toISOString().slice(0, 10)}.jsonl`, new Date(t).toISOString());
    for (const l of lines) assert.equal(l.ts, times[Number(l.event.slice(1))]);
  });

  test("concurrent hooks writing lines just under 1024 bytes never interleave them", async () => {
    const h = freshHome();
    const n = 96;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn("/bin/sh", [HOOK_SH, "opencode", `e${i}`], { env: { ...process.env, CODING_SH_HOME: h, PATH: SH_PATH, NODE_LOG }, stdio: ["pipe", "ignore", "ignore"] });
          c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          c.stdin.end(JSON.stringify({ cwd: "/c", i, data: String(i % 10).repeat(800) }));
        }),
      ),
    );
    const lines = readLines(h, "opencode"); // JSON.parse throws on an interleaved line
    assert.equal(lines.length, n);
    for (const l of lines) {
      assert.equal(l.rawFile, undefined, "inline");
      assert.equal((l.raw as { data: string }).data[0], String((l.raw as { i: number }).i % 10));
    }
  });

  test("a session end touches .ingest.pending and starts `ingest --background` from cli-path in its own process group, without waiting", () => {
    const h = freshHome();
    const dir = tmp("csh-fakecli-");
    const out = join(dir, "ran.json");
    const cli = join(dir, "cli.mjs");
    writeFileSync(cli, `import { writeFileSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\nconst pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), pgid, umask: process.umask() }));\nsetTimeout(() => {}, 3000);\n`);
    mkdirSync(join(h, "bin"), { recursive: true });
    writeFileSync(join(h, "bin", "cli-path"), cli + "\n");
    const t0 = Date.now();
    const r = runHook_sh(["claude-code", "Stop"], JSON.stringify({ session_id: "s" }), { CODING_SH_HOME: h });
    const took = Date.now() - t0;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(took < 2500, `the hook waited for the ingest (${took} ms)`);
    assert.ok(existsSync(join(h, "spool", ".ingest.pending")));
    const deadline = Date.now() + 10_000;
    while (!existsSync(out) && Date.now() < deadline) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"]);
    const ran = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; pgid: string; umask: number };
    assert.deepEqual(ran.argv, ["ingest", "--background"]);
    const ours = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();
    assert.notEqual(ran.pgid, ours, "the ingest runs in its own process group");
    assert.equal(ran.umask, process.umask(), "the ingest gets the agent's umask, not the hook's 077");
  });

  test("CODING_SH_NO_AUTO_INGEST=1 and non-end events start no ingest", () => {
    const h = freshHome();
    const dir = tmp("csh-fakecli-");
    const out = join(dir, "ran");
    const cli = join(dir, "cli.mjs");
    writeFileSync(cli, `require("node:fs").writeFileSync(${JSON.stringify(out)}, "x");\n`);
    mkdirSync(join(h, "bin"), { recursive: true });
    writeFileSync(join(h, "bin", "cli-path"), cli + "\n");
    nodeStarts();
    assert.equal(runHook_sh(["claude-code", "Stop"], "{}", { CODING_SH_HOME: h, CODING_SH_NO_AUTO_INGEST: "1" }).code, 0);
    assert.equal(runHook_sh(["claude-code", "PostToolUse"], "{}", { CODING_SH_HOME: h }).code, 0);
    assert.equal(nodeStarts(), 0);
    assert.equal(existsSync(join(h, "spool", ".ingest.pending")), false);
    assert.equal(readLines(h, "claude-code").length, 2);
  });

  test("hands --reply, eval runs, host apps, model base URLs, proxy session starts and odd values to hook.mjs", () => {
    const h = freshHome();
    const cases: [string[], Record<string, string>][] = [
      [["cursor", "stop", "--reply", "{}"], {}],
      [["codex", "e"], { CODING_SH_RUN_ID: "r" }],
      [["codex", "e"], { T3CODE_THREAD_ID: "t" }],
      [["codex", "e"], { ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh" }],
      [["codex", "e"], { OPENAI_BASE_URL: "https://api.openai.com/v1" }],
      [["codex", "e"], { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }],
      [["codex", "e"], { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", LITELLM_BASE_URL: "http://127.0.0.1:4000" }],
      [["codex", "e"], { CLAUDE_CODE_SESSION_ID: "a b" }],
      [["Codex", "e"], {}],
      [["codex", "e v"], {}],
      [["codex"], {}],
    ];
    for (const [args, env] of cases) {
      nodeStarts();
      assert.equal(runHook_sh(args, "{}", { CODING_SH_HOME: h, ...env }).code, 0, args.join(" "));
      assert.equal(nodeStarts(), 1, `${args.join(" ")} ${JSON.stringify(env)}`);
    }
    nodeStarts();
    assert.equal(runHook_sh(["codex", "e"], "{}", { CODING_SH_HOME: h, ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic", OPENAI_BASE_URL: "http://localhost:4319/openai/v1" }).code, 0);
    assert.equal(nodeStarts(), 0, "the coding.sh proxy's loopback URL stays on the fast path");
    writeFileSync(join(h, "proxy-installs.json"), "{}");
    nodeStarts();
    assert.equal(runHook_sh(["claude-code", "SessionStart"], "{}", { CODING_SH_HOME: h, CODING_SH_NO_PROXY_AUTOSTART: "1" }).code, 0);
    assert.equal(nodeStarts(), 0, "proxy autostart off");
    assert.equal(runHook_sh(["claude-code", "SessionStart"], "{}", { CODING_SH_HOME: h }).code, 0);
    assert.equal(nodeStarts(), 1);
    assert.equal(readLines(h, "codex").length + readLines(h, "unknown").length + readLines(h, "cursor").length, cases.length + 1);
  });

  test("names every gateway's URL variable and default port, so a gateway base URL goes to hook.mjs", async () => {
    const { GATEWAYS } = await import("../../src/integrations/gateway/providers.ts");
    const { BASE_URL_VARS } = await import("../../src/integrations/gateway/ids.ts");
    const src = readFileSync(HOOK_SH_SRC, "utf8");
    for (const g of Object.values(GATEWAYS) as { urlEnv: readonly string[]; ports?: readonly number[] }[]) {
      for (const k of g.urlEnv) assert.ok(src.includes(`\${${k}-}`), k);
      for (const port of g.ports ?? []) assert.match(src, new RegExp(`\\| ${port}\\)`), String(port));
    }
    for (const k of BASE_URL_VARS) assert.ok(src.includes(`"\${${k}-}"`), k);
  });

  test("runs no git and no network tool; the fast path needs only cat, date, mkdir and wc", () => {
    const src = readFileSync(HOOK_SH_SRC, "utf8").replace(/^\s*#.*$/gm, "");
    assert.doesNotMatch(src, /\bgit\b|\.git\b|packed-refs|\bcurl\b|\bwget\b|\bnc\b|\/dev\/tcp/);
    // A PATH with nothing else on it (no /bin, no /usr/bin): every line still gets written without node.
    const bin = tmp("csh-shpath-");
    for (const tool of ["cat", "date", "mkdir", "wc"]) {
      const at = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      symlinkSync(at, join(bin, tool));
    }
    copyFileSync(join(dirname(NODE_LOG), "node"), join(bin, "node"));
    chmodSync(join(bin, "node"), 0o755);
    const h = freshHome();
    nodeStarts();
    for (const [event, text] of [["PostToolUse", '{"cwd":"/w","a":1}'], ["PreToolUse", JSON.stringify({ cwd: "/w", s: "x".repeat(2000) })], ["Stop", "{}"]]) assert.equal(runHook_sh(["claude-code", event!], text, { CODING_SH_HOME: h, PATH: bin }).code, 0);
    assert.equal(nodeStarts(), 0);
    assert.deepEqual(readLines(h, "claude-code").map((l) => l.event).sort(), ["PostToolUse", "PreToolUse", "Stop"]);
  });

  test("reads payloads byte for byte on both sides of bash's 256 KB read-builtin bound, and through dash's cat", () => {
    const h = freshHome();
    const want: string[] = [];
    let i = 0;
    for (const env of [{}, { CODING_SH_HOOK_REEXEC: "1" }] as Record<string, string>[])
      for (const size of [600, 2046, 2047, 2048, 2049, 4096, 9000, 262143, 262144, 262145])
        for (const tail of ["", "\n", "\n\n"])
          for (const multi of [false, true]) {
            const head = multi ? '{"cwd":"/w",\n"i":' : '{"cwd":"/w","i":';
            const body = `${head}${i},"s":"`;
            const payload = `${body}${"é".repeat(Math.max(0, Math.floor((size - body.length - 2) / 2)))}"}`;
            want.push(payload);
            assert.equal(runHook_sh(["codex", `e${i++}`], payload + tail, { CODING_SH_HOME: h, ...env }).code, 0);
          }
    const lines = readLines(h, "codex").sort((a, b) => Number(a.event.slice(1)) - Number(b.event.slice(1)));
    assert.equal(lines.length, want.length);
    for (const [k, l] of lines.entries()) {
      const got = l.rawFile ? readFileSync(l.rawFile, "utf8") : JSON.stringify(l.raw);
      assert.equal(l.rawFile ? got : JSON.stringify(JSON.parse(want[k]!)), l.rawFile ? want[k] : got, l.event);
    }
    assert.ok(!existsSync(join(h, "spool", "errors.log")));
  });

  const bash5 = Number(spawnSync("/bin/bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout?.trim() || 0) >= 5;
  test("with bash 5 at /bin/bash, a payload under 256 KB starts no process at all (no cat, date or mkdir)", { skip: !bash5 && "no bash 5 at /bin/bash" }, () => {
    const h = freshHome();
    // An agent dir as it is after its first side file (making raw/ takes one mkdir(1), once).
    mkdirSync(join(h, "spool", "claude-code", "raw"), { recursive: true, mode: 0o700 });
    // PATH holds only the node shim: any other command the hook ran would fail and show.
    const before = Date.now();
    nodeStarts();
    for (const n of [10, 600, 2000, 100_000]) {
      const r = runHook_sh(["claude-code", `PreToolUse${n}`], JSON.stringify({ cwd: "/w", s: "x".repeat(n) }), { CODING_SH_HOME: h, PATH: dirname(NODE_LOG) });
      assert.equal(r.code, 0);
    }
    assert.equal(nodeStarts(), 0);
    const lines = readLines(h, "claude-code");
    assert.equal(lines.length, 4);
    for (const l of lines) {
      const n = Number(l.event.slice("PreToolUse".length));
      const raw = l.rawFile ? JSON.parse(readFileSync(l.rawFile, "utf8")) : l.raw;
      assert.deepEqual(raw, { cwd: "/w", s: "x".repeat(n) });
      assert.ok(l.ts >= before - 1 && l.ts <= Date.now() + 1, `ts ${l.ts}`);
    }
    assert.ok(!existsSync(join(h, "spool", "errors.log")));
  });
});

describe("hook.mjs", () => {
  test("does no git work: in a repo, no event touches .git or records a git field (ingest reads HEAD from the reflog)", () => {
    const h = freshHome();
    const repo = makeRepo({ "a.txt": "a\n" });
    mkdirSync(join(repo, "sub"));
    // Preloaded into the hook: logs every fs call on a path inside a .git dir, then the hook runs as usual.
    const dir = tmp("csh-fstrace-");
    const tracer = join(dir, "trace.mjs");
    const log = join(dir, "touched.log");
    writeFileSync(
      tracer,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const touched = [];
const inGit = (p) => /(^|[\\\\/])\\.git([\\\\/]|$)/.test(p instanceof URL ? p.pathname : String(p));
const wrap = (name, f) => function (p, ...rest) { if (typeof p === "string" || p instanceof URL) { if (inGit(p)) touched.push(name + " " + p); } return f.call(this, p, ...rest); };
for (const name of ["openSync", "statSync", "lstatSync", "readFileSync", "existsSync", "accessSync", "readdirSync", "readlinkSync", "opendirSync"]) fs[name] = wrap(name, fs[name]);
const realpath = fs.realpathSync;
fs.realpathSync = wrap("realpathSync", realpath);
fs.realpathSync.native = wrap("realpathSync.native", realpath.native);
syncBuiltinESMExports();
const write = fs.appendFileSync;
process.on("exit", () => write(${JSON.stringify(log)}, touched.map((t) => t + "\\n").join("")));
`,
    );
    for (const event of ["SessionStart", "UserPromptSubmit", "beforeSubmitPrompt", "PostToolUse"]) {
      const r = spawnSync(process.execPath, [...tsNodeArgs(), "--import", pathToFileURL(tracer).href, HOOK_TS, "claude-code", event], {
        input: JSON.stringify({ session_id: "s1", hook_event_name: event, cwd: join(repo, "sub") }),
        env: { ...process.env, CODING_SH_HOME: h, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    assert.ok(existsSync(log), "the fs tracer ran");
    assert.equal(readFileSync(log, "utf8"), "", "the hook touched .git");
    const lines = readLines(h, "claude-code");
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.filter((l) => "git" in l), []);
  });

  test("no module the hook loads names .git, packed-refs or the git binary", () => {
    // The hook's static import graph (type-only imports are erased and skipped).
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)) walk(join(file, "..", m[1]!));
    };
    walk(HOOK_TS);
    assert.ok(seen.size > 3, [...seen].join(", "));
    for (const file of seen) {
      const src = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""); // comments may say "no git work"
      assert.doesNotMatch(src, /["'`/\\]\.git\b|packed-refs|githead|["'`]git["'`]/, file);
    }
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
  // Absolute times swing 10x under parallel test load, so the hook is measured against a
  // bare node start that reads the same stdin, in pairs run back to back, two ways:
  // - CPU time, as each process reports it at exit: waiting for a core doesn't count, so
  //   it holds on a loaded runner. Hook/bare ≈ 1.2 on a laptop, idle or with every core
  //   busy. Windows counts it in 15.6 ms ticks, so it is summed over the pairs.
  // - Wall time, the median of the pairs' ratios: load at the moment of a pair stretches
  //   both its sides. Hook/bare ≈ 1.05 idle; under load it swings (0.8 to 1.9 on the desk).
  // A hook made 2x slower is about 2x on both, so passing either one is enough. One
  // re-measure absorbs a burst; a real regression fails both.
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
    // Preloaded into both: at exit, the process's own CPU time (user + system, since it started) on stderr.
    const reporter = join(tmp("csh-cpu-"), "cpu.cjs");
    writeFileSync(reporter, `process.on("exit", () => { const u = process.resourceUsage(); require("node:fs").writeSync(2, "\\ncpu-us:" + (u.userCPUTime + u.systemCPUTime) + "\\n"); });\n`);
    const env = { ...process.env, CODING_SH_HOME: h };
    const nodeArgs = bundled ? [] : tsNodeArgs();
    // Wall ms of one run; its CPU ms goes on `cpu`.
    const run = (args: string[], cpu: number[]) => {
      let r: ReturnType<typeof spawnSync> | undefined;
      const ms = timeMs(() => (r = spawnSync(process.execPath, ["-r", reporter, ...args], { input: payload, env, encoding: "utf8" })));
      assert.equal(r!.status, 0, String(r!.stderr));
      const used = /cpu-us:(\d+)/.exec(String(r!.stderr));
      assert.ok(used, `no CPU time reported: ${String(r!.stderr)}`);
      cpu.push(Number(used[1]) / 1000);
      return ms;
    };
    const hookArgs = [...nodeArgs, script, "claude-code", "PostToolUse"];
    const bareArgs = ["-e", "process.stdin.resume()"];
    run([...nodeArgs, script, "claude-code", "warmup"], []); // warms the OS file cache only
    run(bareArgs, []);
    const PAIRS = 15;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const measure = () => {
      const hookCpu: number[] = [];
      const bareCpu: number[] = [];
      const wall = pairedRatio(() => run(hookArgs, hookCpu), () => run(bareArgs, bareCpu), PAIRS);
      const cpu = sum(hookCpu) / sum(bareCpu);
      const text = `CPU ${cpu.toFixed(2)}x (medians ${median(hookCpu).toFixed(1)} and ${median(bareCpu).toFixed(1)} ms), wall ${wall.ratio.toFixed(2)}x (medians ${median(wall.a).toFixed(1)} and ${median(wall.b).toFixed(1)} ms)`;
      return { ratio: Math.min(cpu, wall.ratio), text };
    };
    const limit = bundled ? 1.5 : 3; // .ts source pays for type stripping
    let m = measure();
    const first = m;
    if (m.ratio >= limit) m = measure();
    console.log(`# hook (${bundled ? "bundled" : "ts source"}) against a bare node start over ${PAIRS} pairs: ${m.text}${m === first ? "" : ` (first try: ${first.text})`}`);
    assert.ok(m.ratio < limit, `hook against a bare node start over ${PAIRS} pairs: ${m.text}; limit ${limit}x on either`);
    assert.equal(readLines(h, "claude-code").length, 1 + (m === first ? 1 : 2) * PAIRS);
  });
});

void home;
