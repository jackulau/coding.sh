// Adds what the docs screenshots need on top of seed.mjs, then keeps a team
// server running for capture-docs.mjs. Run seed.mjs first, then:
//
//   node --experimental-strip-types scripts/shots/seed-docs.mjs <root>
//
// <root> is the "root" line seed.mjs prints. Everything stays under it: HOME,
// CODING_SH_HOME and every agent config dir point inside it, as in seed.mjs.
//
// 1. An experiment pair on the seed's own home (<root>/cs), run by the real
//    `coding.sh exp run`: coding.sh's AGENTS.md as it is today (agents-md-today)
//    and the rewrite (agents-md-rewrite), on the same 20 coding.sh tasks and the
//    same pass/fail record the landing's Compare section shows (src/data/compare.ts).
//    The seed's own experiment keeps its id; the docs shoot only this pair.
// 2. A team server: a second `coding.sh serve` on its own home (<root>/team/serve)
//    with two ingest keys made by `coding.sh serve keygen` (projects alice and
//    bob) and a read key. Each person gets a home of their own with Claude Code
//    transcripts on the coding.sh repo, runs
//    `coding.sh init --remote <url> --key <key> --remote-mode full`, and then
//    `coding.sh ingest --backfill`, which sends the sessions to /v1/ingest.
// 3. The quickstart's own run: a third `coding.sh serve` on its own home
//    (<root>/sdk) and triage.mjs exactly as the quickstart shows it
//    (src/data/quickstart.ts), run with the SDK. Its OpenAI calls go to
//    scripts/e2e/stub-model.mjs, which answers as gpt-5-mini, so the picture
//    shows the model, provider and token counts of the code above it.
//
// Set CODING_SH_CLI to use a CLI build other than packages/coding.sh/dist/cli.mjs.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "../../src/data/compare.ts";
import { TRIAGE_ANSWER, TRIAGE_ISSUE, TRIAGE_MODEL, TRIAGE_TS } from "../../src/data/quickstart.ts";
import { startStub } from "../../../../scripts/e2e/stub-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const CLI = process.env.CODING_SH_CLI || join(repoRoot, "packages/coding.sh/dist/cli.mjs");

const ROOT = process.argv[2];
if (!ROOT || !existsSync(join(ROOT, "cs", "index.db"))) {
  console.error("usage: node --experimental-strip-types scripts/shots/seed-docs.mjs <root printed by seed.mjs>");
  process.exit(2);
}

/** The same isolation as seed.mjs: one temp home per person, nothing outside ROOT. */
function homeEnv(base, cs) {
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, "home"),
    USERPROFILE: join(base, "home"),
    CODING_SH_HOME: cs,
    CLAUDE_CONFIG_DIR: join(base, "claude"),
    CODEX_HOME: join(base, "codex"),
    CURSOR_CONFIG_DIR: join(base, "cursor"),
    XDG_DATA_HOME: join(base, "xdg"),
    XDG_CONFIG_HOME: join(base, "xdg-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TZ: process.env.TZ || "America/Chicago",
  };
  for (const k of ["HOME", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) mkdirSync(env[k], { recursive: true });
  return env;
}
const run = (env, args, cwd) => execFileSync(process.execPath, [CLI, ...args], { cwd: cwd ?? env.HOME, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ================================================================== 1. the experiment pair
const seedEnv = homeEnv(ROOT, join(ROOT, "cs"));
const EXP = join(ROOT, "docs-exp");
mkdirSync(join(EXP, "trials"), { recursive: true });
// One case per coding.sh task. The input is what the task asks for; a run passes when the
// agent's verifier passed, which the stand-in agent below reports as "pass".
writeFileSync(join(EXP, "coding-sh-tasks.jsonl"), TASKS.map((t) => JSON.stringify({ id: t.task, input: t.label, expected: "pass" })).join("\n") + "\n");
// The stand-in agent replays the recorded outcome of each task and trial (src/data/compare.ts):
// base is AGENTS.md as it is today, cand the rewrite.
writeFileSync(join(EXP, "record.json"), JSON.stringify(Object.fromEntries(TASKS.map((t) => [t.task, { base: t.base, cand: t.cand }]))));
writeFileSync(join(EXP, "agent.mjs"), `import { readFileSync } from "node:fs";
const record = JSON.parse(readFileSync(new URL("./record.json", import.meta.url), "utf8"));
const arm = process.argv[2];
const runs = record[process.env.CODING_SH_CASE_ID][arm];
const trial = Number(process.env.CODING_SH_TRIAL);
process.stdout.write(runs[trial % runs.length] === "1" ? "pass" : "fail");
`);
run(seedEnv, ["dataset", "import", join(EXP, "coding-sh-tasks.jsonl"), "--name", "coding-sh-tasks"]);
const expIds = {};
for (const [name, arm] of [["agents-md-today", "base"], ["agents-md-rewrite", "cand"]]) {
  const task = JSON.stringify({ kind: "command", command: `node ${join(EXP, "agent.mjs")} ${arm}`, output: "text" });
  const out = JSON.parse(run(seedEnv, ["exp", "run", "--dataset", "coding-sh-tasks", "--task", task, "--grader", '{"kind":"exact"}', "--name", name, "--trials", "5", "--concurrency", "1", "--no-session", "--json"]));
  expIds[name] = out.id ?? out.experiment?.id;
  if (!expIds[name]) throw new Error(`exp run ${name}: no experiment id in ${JSON.stringify(out).slice(0, 300)}`);
}

// ================================================================== 2. the team server
const TEAM = join(ROOT, "team");
const serveEnv = homeEnv(join(TEAM, "serve"), join(TEAM, "serve", "cs"));
/** `coding.sh serve keygen`: the key (stdout) and the hash entry for CODING_SH_*_KEYS (stderr). */
function keyOut(args) {
  const r = spawnSync(process.execPath, [CLI, "serve", "keygen", ...args], { env: serveEnv, encoding: "utf8" });
  const key = r.stdout.trim().split("\n")[0].trim();
  const entry = /CODING_SH_(?:INGEST|READ)_KEYS=(\S+)/.exec(r.stdout + r.stderr)?.[1];
  if (r.status !== 0 || !key || !entry) throw new Error("keygen printed no key: " + r.stdout + r.stderr);
  return { key, entry };
}
const alice = keyOut(["--project", "alice"]);
const bob = keyOut(["--project", "bob"]);
const reader = keyOut(["--project", "*", "--read"]);

function start(args, env) {
  return new Promise((resolveUrl, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: env.HOME, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const m = /https?:\/\/\S+/.exec(buf);
      if (m) resolveUrl({ url: m[0], proc: p });
    });
    p.stderr.on("data", () => {});
    p.on("exit", (code) => reject(new Error(`${args[0]} exited ${code}: ${buf}`)));
  });
}
const team = await start(["serve", "--port", "0"], { ...serveEnv, CODING_SH_INGEST_KEYS: `${alice.entry},${bob.entry}`, CODING_SH_READ_KEYS: reader.entry });

// ------------------------------------------------------------------ each person's machine
const NOW = Date.now();
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const uuid = (seed) => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A Claude Code transcript (the format seed.mjs writes), one assistant message per step. */
function claude(env, cwd, { seed, t0, model, prompt, steps, final }) {
  const project = join(env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const sid = uuid("team:" + seed);
  const base = { sessionId: sid, cwd, version: "2.1.300", gitBranch: "main", userType: "external", entrypoint: "cli" };
  const ts = (s) => iso(t0 + Math.round(s * 1000));
  let n = 0;
  const id = (p) => `${p}${seed.replace(/[^a-z0-9]/gi, "").slice(0, 6)}${String(++n).padStart(3, "0")}`;
  const usage = ([i, o, cr = 0, cw = 0]) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  const lines = [{ type: "mode", mode: "default", sessionId: sid }];
  lines.push({ ...base, type: "user", uuid: id("u"), parentUuid: null, timestamp: ts(0), promptId: "p1", message: { role: "user", content: prompt } });
  for (const st of steps) {
    const mid = id("msg_");
    const tid = id("toolu_");
    const content = [];
    if (st.text) content.push({ type: "text", text: st.text });
    content.push({ type: "tool_use", id: tid, name: st.tool.name, input: st.tool.input });
    lines.push({ ...base, type: "assistant", uuid: id("a"), parentUuid: null, timestamp: ts(st.at), requestId: "req_" + mid, message: { id: mid, type: "message", role: "assistant", model, content, stop_reason: "tool_use", usage: usage(st.u) } });
    const result = st.tool.error ? "Error: Exit code 1\n" + st.tool.out : st.tool.out;
    lines.push({ ...base, type: "user", uuid: id("u"), parentUuid: null, timestamp: ts(st.at + (st.tool.dur ?? 0.4)), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: result, is_error: !!st.tool.error }] }, toolUseResult: result });
  }
  const mid = id("msg_");
  lines.push({ ...base, type: "assistant", uuid: id("a"), parentUuid: null, timestamp: ts(final.at), requestId: "req_" + mid, message: { id: mid, type: "message", role: "assistant", model, content: [{ type: "text", text: final.text }], stop_reason: "end_turn", usage: usage(final.u) } });
  lines.push({ ...base, type: "system", subtype: "turn_duration", uuid: id("s"), timestamp: ts(final.at + 0.1), durationMs: Math.round((final.at + 0.1) * 1000), isMeta: true });
  writeFileSync(join(project, sid + ".jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""));
}

const PASS = (n) => `ℹ tests ${n}\nℹ pass ${n}\nℹ fail 0\n`;
const PEOPLE = [
  {
    name: "alice", key: alice.key, sessions: (P) => [
      {
        seed: "alice-locked-index", t0: NOW - 26 * MIN, model: "claude-opus-4-8", prompt: "Retry ingest when the index is locked",
        steps: [
          { at: 4, tool: { name: "Read", input: { file_path: P("src/core/lock.ts") }, out: "export async function withIngestLock…" }, u: [3, 240, 16800, 7200] },
          { at: 31, text: "I'll retry SQLITE_BUSY with a short backoff before giving up.", tool: { name: "Edit", input: { file_path: P("src/core/ingest.ts"), old_string: "await index.putEvents(batch);", new_string: "await retryBusy(() => index.putEvents(batch));" } }, u: [4, 520, 19400, 1800] },
          { at: 48, tool: { name: "Bash", input: { command: "npm test -- test/core/ingest.test.ts", description: "Run the ingest tests" }, out: PASS(57), dur: 14 }, u: [3, 90, 21200, 600] },
        ],
        final: { at: 70, text: "Ingest now retries a locked index three times with backoff. 57 ingest tests pass.", u: [3, 180, 21900, 300] },
      },
      {
        seed: "alice-sessions-project", t0: NOW - 95 * MIN, model: "claude-sonnet-4-6", prompt: "Add --project to coding.sh sessions",
        steps: [
          { at: 5, tool: { name: "Read", input: { file_path: P("src/cli/commands/sessions.ts") }, out: "export async function run(c: Ctx) {…" }, u: [3, 160, 14100, 5600] },
          { at: 22, tool: { name: "Edit", input: { file_path: P("src/cli/registry.ts"), old_string: "AGENT_ONE,", new_string: "AGENT_ONE,\n      PROJECT," } }, u: [3, 310, 15900, 1200] },
          { at: 39, tool: { name: "Bash", input: { command: "npm test -- test/cli/sessions.test.ts", description: "Run the sessions tests" }, out: PASS(41), dur: 9 }, u: [3, 80, 17200, 400] },
        ],
        final: { at: 55, text: "coding.sh sessions takes --project, and the team viewer's filter uses the same key. 41 tests pass.", u: [3, 140, 17600, 200] },
      },
    ],
  },
  {
    name: "bob", key: bob.key, sessions: (P) => [
      {
        seed: "bob-otlp-limit", t0: NOW - 41 * MIN, model: "claude-sonnet-4-6", prompt: "Cap the OTLP request body at 16 MiB",
        steps: [
          { at: 3, tool: { name: "Read", input: { file_path: P("src/otel/receiver.ts") }, out: "const body = await readBody(req);" }, u: [3, 150, 13800, 6100] },
          { at: 19, tool: { name: "Edit", input: { file_path: P("src/otel/receiver.ts"), old_string: "const body = await readBody(req);", new_string: "const body = await readBody(req, { limit: 16 * 1024 * 1024 });" } }, u: [3, 290, 15100, 900] },
          { at: 33, tool: { name: "Bash", input: { command: "npm test -- test/otel/receiver.test.ts", description: "Run the receiver tests" }, out: "✖ answers 413 for a body over the limit\n  AssertionError: 500 !== 413\nℹ tests 23\nℹ pass 22\nℹ fail 1\n", error: true, dur: 8 }, u: [3, 70, 16000, 300] },
          { at: 58, text: "The limit error reaches the handler as a 500. I'll map it to 413.", tool: { name: "Edit", input: { file_path: P("src/otel/receiver.ts"), old_string: "} catch (e) {", new_string: "} catch (e) {\n    if (e instanceof BodyTooLarge) return send(res, 413, { error: \"body over 16 MiB\" });" } }, u: [3, 330, 16900, 700] },
          { at: 72, tool: { name: "Bash", input: { command: "npm test -- test/otel/receiver.test.ts", description: "Run the receiver tests" }, out: PASS(23), dur: 8 }, u: [3, 70, 17800, 300] },
        ],
        final: { at: 90, text: "OTLP bodies over 16 MiB now get a 413 instead of a 500. 23 receiver tests pass.", u: [3, 150, 18200, 200] },
      },
      {
        seed: "bob-hook-windows", t0: NOW - 140 * MIN, model: "claude-opus-4-8", prompt: "Fix the Windows path in the hook installer",
        steps: [
          { at: 4, tool: { name: "Read", input: { file_path: P("src/adapters/claude-code/install.ts") }, out: "const hook = `/bin/sh ${join(bin, \"hook.sh\")}`;" }, u: [3, 200, 15200, 6800] },
          { at: 27, tool: { name: "Edit", input: { file_path: P("src/adapters/claude-code/install.ts"), old_string: "const hook = `/bin/sh ${join(bin, \"hook.sh\")}`;", new_string: "const hook = process.platform === \"win32\" ? `node \"${join(bin, \"hook.mjs\")}\"` : `/bin/sh ${join(bin, \"hook.sh\")}`;" } }, u: [3, 410, 17400, 1500] },
          { at: 44, tool: { name: "Bash", input: { command: "npm test -- test/adapters/claude-code.test.ts", description: "Run the adapter tests" }, out: PASS(64), dur: 12 }, u: [3, 90, 18900, 500] },
        ],
        final: { at: 61, text: "On Windows the hook command is now node with the quoted hook.mjs path. 64 adapter tests pass.", u: [3, 160, 19300, 200] },
      },
      {
        seed: "bob-explain-sinks", t0: NOW - 190 * MIN, model: "claude-haiku-4-5", prompt: "Explain when a sink sends a session",
        steps: [
          { at: 3, tool: { name: "Read", input: { file_path: P("src/core/ingest.ts") }, out: "// Sinks replay from their own cursors…" }, u: [6, 110, 9600, 4900] },
        ],
        final: { at: 18, text: "Each sink keeps its own cursor into the spool, so an offline server catches up on the next ingest.", u: [6, 260, 14800, 300] },
      },
    ],
  },
];

const report = [];
for (const person of PEOPLE) {
  const base = join(TEAM, person.name);
  const env = homeEnv(base, join(base, "cs"));
  const cwd = join(env.HOME, "coding.sh");
  mkdirSync(cwd, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "README.md"), "# coding.sh\n");
  git("add", ".");
  git("-c", `user.name=${person.name}`, "-c", "user.email=dev@coding.sh.invalid", "commit", "-q", "-m", "init");
  // Connect first (as a new team member does), then the sessions land and are imported.
  const init = run(env, ["init", "--agent", "claude-code", "--yes", "--no-import", "--no-mcp", "--remote", team.url, "--key", person.key, "--remote-mode", "full"], cwd);
  for (const s of person.sessions((rel) => join(cwd, rel))) claude(env, cwd, s);
  const ingest = run(env, ["ingest", "--backfill", "--json"], cwd);
  const sent = JSON.parse(ingest).backfill?.sinks?.find((s) => s.name === "team");
  if (!sent || !sent.ok || !sent.sent) throw new Error(`${person.name}: nothing sent to the team server: ${ingest}`);
  report.push(`${person.name}: ${sent.sent} events sent`);
  if (person.name === "alice") writeFileSync(join(TEAM, "init-alice.txt"), init);
}

// ================================================================== 3. the quickstart's own run
const SDK = join(ROOT, "sdk");
const sdkEnv = homeEnv(SDK, join(SDK, "cs"));
const sdkServe = await start(["serve", "--port", "0"], sdkEnv);
// A two-message prompt is about 34 tokens; gpt-5-mini reasons before its three-token answer,
// and the answer takes about 2 s (near 100 tokens a second), as a real call does.
const stub = await startStub({
  decide: () => ({ text: TRIAGE_ANSWER, model: TRIAGE_MODEL, delayMs: 1900, usage: { prompt_tokens: 34, completion_tokens: 195, total_tokens: 229, completion_tokens_details: { reasoning_tokens: 192 } } }),
});
const app = join(SDK, "app");
mkdirSync(app, { recursive: true });
writeFileSync(join(app, "triage.mjs"), TRIAGE_TS + "\n");
// The repo's own openai and @codingdotsh/sdk (a workspace link to packages/sdk).
symlinkSync(join(repoRoot, "node_modules"), join(app, "node_modules"), "junction");
// Async: the stub answers from this process, so a sync child would wait on it forever.
const { stdout: answerOut } = await promisify(execFile)(process.execPath, [join(app, "triage.mjs"), TRIAGE_ISSUE], {
  cwd: app,
  env: { ...sdkEnv, OPENAI_BASE_URL: stub.url + "/v1", OPENAI_API_KEY: "stub", CODING_SH_URL: sdkServe.url, CODING_SH_SERVICE: "coding-sh-triage" },
  encoding: "utf8",
  timeout: 60_000,
});
const answer = answerOut.trim();
await stub.close();
if (answer !== TRIAGE_ANSWER) throw new Error(`triage.mjs printed ${JSON.stringify(answer)}, not ${JSON.stringify(TRIAGE_ANSWER)}`);
const triage = JSON.parse(run(sdkEnv, ["sessions", "--fresh", "--json"])).sessions?.find((x) => x.title === TRIAGE_ISSUE);
if (!triage) throw new Error("the triage run did not reach the sdk server");
report.push(`sdk: ${triage.agent} ${triage.id} "${triage.title}"`);

console.log(`compare  #/experiments/${encodeURIComponent(expIds["agents-md-today"])}/vs/${encodeURIComponent(expIds["agents-md-rewrite"])}`);
console.log(`team     ${new URL("/?t=" + reader.key, team.url)}`);
console.log(`sdk      ${sdkServe.url}`);
console.log(report.join("\n"));
console.log("Ctrl-C to stop.");
const stop = () => { team.proc.kill(); sdkServe.proc.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
