// Seeds a throwaway coding.sh home with coding.sh working on its own repo, then
// starts the real viewer (`coding.sh ui`) and the real production server
// (`coding.sh serve`) on it, for the landing page screenshots.
//
//   npm run shots:seed        (from apps/site)
//
// Everything lives under one temp root: HOME, CODING_SH_HOME and every agent
// config dir point inside it. It never runs `coding.sh init` and never reads
// ~/.claude, ~/.codex, ~/.gemini or the real ~/.coding.sh. The sessions are
// synthetic transcripts in each agent's own format, ingested by the real
// adapters, so tokens and cost come from the product.
//
// Set CODING_SH_CLI to use a CLI build other than packages/coding.sh/dist/cli.mjs.
// Set SHOTS_NO_SERVE=1 to seed and exit without starting the servers.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { TASKS } from "../../src/data/compare.ts";
import { SqliteIndexStore } from "../../../../packages/coding.sh/src/store/sqlite.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const CLI = process.env.CODING_SH_CLI || join(repoRoot, "packages/coding.sh/dist/cli.mjs");

// ------------------------------------------------------------------ the temp root
const ROOT = join(realpathSync(mkdtempSync(join(tmpdir(), "cs-shots-"))), "cs-shots");
const HOME = join(ROOT, "home");
const CS = join(ROOT, "cs");
const PROD = join(ROOT, "prod");
const env = {
  PATH: process.env.PATH,
  HOME,
  USERPROFILE: HOME,
  CODING_SH_HOME: CS,
  CLAUDE_CONFIG_DIR: join(ROOT, "claude"),
  CODEX_HOME: join(ROOT, "codex"),
  CURSOR_CONFIG_DIR: join(ROOT, "cursor"),
  XDG_DATA_HOME: join(ROOT, "xdg"),
  XDG_CONFIG_HOME: join(ROOT, "xdg-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  CODING_SH_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
  TZ: process.env.TZ || "America/Chicago",
};
for (const d of [HOME, CS, PROD, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.CURSOR_CONFIG_DIR, env.XDG_DATA_HOME]) mkdirSync(d, { recursive: true });

// The repo every session ran in: a real git work tree named coding.sh, so the
// product resolves `repo` the way it does for a real checkout.
const CWD = join(HOME, "coding.sh");
mkdirSync(CWD, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: CWD, env, stdio: "pipe" });
git("init", "-q", "-b", "main");
writeFileSync(join(CWD, "README.md"), "# coding.sh\n");
git("add", ".");
git("-c", "user.name=coding.sh", "-c", "user.email=dev@coding.sh.invalid", "commit", "-q", "-m", "init");

const NOW = Date.now();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const uuid = (seed) => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const P = (rel) => join(CWD, rel);
let written = 0;

// ------------------------------------------------------------------ claude code
// Transcript JSONL in CLAUDE_CONFIG_DIR/projects/<slug>/<sid>.jsonl (backfill path).
const claudeProject = join(env.CLAUDE_CONFIG_DIR, "projects", CWD.replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(claudeProject, { recursive: true });

/**
 * steps: { at: s, text?, tool?: { name, input, out, error?, dur? }, u: [in, out, cacheRead, cacheWrite] }
 * Each step is one assistant message; a tool step gets its result `dur` seconds later.
 */
function claude({ seed, t0, model, prompt, steps, final, sub }) {
  const sid = uuid("cc:" + seed);
  const base = { sessionId: sid, cwd: CWD, version: "2.1.300", gitBranch: "main", userType: "external", entrypoint: "cli" };
  const ts = (s) => iso(t0 + Math.round(s * 1000));
  let n = 0;
  const id = (p) => `${p}${seed.replace(/[^a-z0-9]/gi, "").slice(0, 6)}${String(++n).padStart(3, "0")}`;
  const usage = ([i, o, cr = 0, cw = 0]) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  const lines = [{ type: "mode", mode: "default", sessionId: sid }];
  lines.push({ ...base, type: "user", uuid: id("u"), parentUuid: null, timestamp: ts(0), promptId: "p1", message: { role: "user", content: prompt } });
  let last = 0;
  for (const st of steps) {
    if (st.user) {
      lines.push({ ...base, type: "user", uuid: id("u"), parentUuid: null, timestamp: ts(st.at), promptId: id("p"), message: { role: "user", content: st.user } });
      continue;
    }
    const mid = id("msg_");
    const content = [];
    if (st.text) content.push({ type: "text", text: st.text });
    let tid;
    if (st.tool) {
      tid = id("toolu_");
      content.push({ type: "tool_use", id: tid, name: st.tool.name, input: st.tool.input });
    }
    lines.push({
      ...base, type: "assistant", uuid: id("a"), parentUuid: null, timestamp: ts(st.at), requestId: "req_" + mid,
      message: { id: mid, type: "message", role: "assistant", model, content, stop_reason: st.tool ? "tool_use" : "end_turn", usage: usage(st.u) },
    });
    last = st.at;
    if (st.tool) {
      const end = st.at + (st.tool.dur ?? 0.4);
      const result = st.tool.error ? "Error: Exit code 1\n" + st.tool.out : st.tool.out;
      lines.push({
        ...base, type: "user", uuid: id("u"), parentUuid: null, timestamp: ts(end),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: result, is_error: !!st.tool.error }] },
        toolUseResult: st.tool.result ?? result,
      });
      last = end;
      if (st.tool.name === "Agent" && sub) sub.toolUseId = tid;
    }
  }
  if (final) {
    const mid = id("msg_");
    lines.push({
      ...base, type: "assistant", uuid: id("a"), parentUuid: null, timestamp: ts(final.at), requestId: "req_" + mid,
      message: { id: mid, type: "message", role: "assistant", model, content: [{ type: "text", text: final.text }], stop_reason: "end_turn", usage: usage(final.u) },
    });
    lines.push({ ...base, type: "system", subtype: "turn_duration", uuid: id("s"), timestamp: ts(final.at + 0.1), durationMs: Math.round((final.at + 0.1) * 1000), isMeta: true });
    last = final.at;
  }
  writeFileSync(join(claudeProject, sid + ".jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  if (sub) {
    const dir = join(claudeProject, sid, "subagents");
    mkdirSync(dir, { recursive: true });
    const sb = { ...base, isSidechain: true, agentId: sub.agentId };
    const sl = [{ ...sb, type: "user", uuid: id("su"), timestamp: ts(sub.at), promptId: "p1", message: { role: "user", content: sub.prompt } }];
    for (const st of sub.steps) {
      const mid = id("msg_s");
      const tid = id("toolu_s");
      sl.push({ ...sb, type: "assistant", uuid: id("sa"), timestamp: ts(st.at), message: { id: mid, role: "assistant", model: sub.model, content: [{ type: "tool_use", id: tid, name: st.tool.name, input: st.tool.input }], stop_reason: "tool_use", usage: usage(st.u) } });
      sl.push({ ...sb, type: "user", uuid: id("su"), timestamp: ts(st.at + 0.3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: st.tool.out }] } });
    }
    sl.push({ ...sb, type: "assistant", uuid: id("sa"), timestamp: ts(sub.end), message: { id: id("msg_s"), role: "assistant", model: sub.model, content: [{ type: "text", text: sub.answer }], stop_reason: "end_turn", usage: usage(sub.u) } });
    writeFileSync(join(dir, `agent-${sub.agentId}.jsonl`), sl.map((l) => JSON.stringify(l) + "\n").join(""));
    writeFileSync(join(dir, `agent-${sub.agentId}.meta.json`), JSON.stringify({ agentType: "Explore", description: sub.description, toolUseId: sub.toolUseId, finished: true }));
  }
  written++;
  return { sid, end: t0 + last * 1000 };
}

// ------------------------------------------------------------------ codex
// Rollouts in CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
function codex({ seed, t0, model = "gpt-5", prompt, steps, final }) {
  const sid = uuid("cx:" + seed);
  let turn = "turn-" + seed.slice(0, 8);
  const at = (s) => t0 + Math.round(s * 1000);
  const recs = [];
  const R = (s, type, payload) => recs.push({ timestamp: iso(at(s)), type, payload, ordinal: recs.length });
  const item = (s, it, s0 = s) => R(s, "event_msg", { type: "item_completed", thread_id: sid, turn_id: turn, item: it, started_at_ms: at(s0), completed_at_ms: at(s) });
  const usage = ([i, c, o]) => ({ input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: Math.round(o / 3), total_tokens: i + o });
  R(0, "session_meta", { id: sid, session_id: sid, timestamp: iso(t0), cwd: CWD, originator: "codex_cli_rs", cli_version: "0.166.0", source: "cli", thread_source: "user", model_provider: "openai", git: { branch: "main" } });
  R(0.01, "turn_context", { turn_id: turn, cwd: CWD, model, effort: "medium" });
  R(0.02, "event_msg", { type: "task_started", turn_id: turn });
  item(0.05, { type: "UserMessage", id: "um-" + seed, content: [{ type: "text", text: prompt, text_elements: [] }] });
  let k = 0;
  let total = [0, 0, 0];
  for (const st of steps) {
    const cid = `call_${seed.slice(0, 4)}_${++k}`;
    if (st.user) {
      R(st.at - 0.01, "event_msg", { type: "task_complete", turn_id: turn, duration_ms: 1000 });
      turn = `turn-${seed.slice(0, 8)}-${k}`;
      R(st.at, "turn_context", { turn_id: turn, cwd: CWD, model, effort: "medium" });
      R(st.at, "event_msg", { type: "task_started", turn_id: turn });
      item(st.at + 0.01, { type: "UserMessage", id: "um-" + cid, content: [{ type: "text", text: st.user, text_elements: [] }] });
      continue;
    }
    if (st.cmd) {
      R(st.at, "response_item", { type: "function_call", status: "completed", id: "fc_" + cid, name: "exec_command", arguments: JSON.stringify({ cmd: st.cmd }), call_id: cid });
      item(st.at + st.dur, { type: "CommandExecution", id: cid, command: ["/bin/zsh", "-lc", st.cmd], cwd: CWD, status: "completed", exit_code: st.exit ?? 0, aggregated_output: st.out }, st.at);
      R(st.at + st.dur, "response_item", { type: "function_call_output", call_id: cid, output: st.out });
    } else if (st.patch) {
      const patch = `*** Begin Patch\n*** Update File: ${st.patch.file}\n@@\n-${st.patch.old}\n+${st.patch.new}\n*** End Patch\n`;
      R(st.at, "response_item", { type: "custom_tool_call", status: "completed", id: "ctc_" + cid, name: "apply_patch", input: patch, call_id: cid });
      item(st.at + 0.1, { type: "FileChange", id: cid, changes: { [P(st.patch.file)]: { type: "update", unified_diff: `@@ -1 +1 @@\n-${st.patch.old}\n+${st.patch.new}\n`, move_path: null } }, status: "completed" }, st.at);
      R(st.at + 0.15, "response_item", { type: "custom_tool_call_output", call_id: cid, output: [{ type: "input_text", text: "Success. Updated the following files:\nM " + st.patch.file }] });
    }
    R(st.at + 0.01, "token_usage_record", { thread_id: sid, turn_id: turn, session_id: sid, response_id: "resp_" + cid, usage: usage(st.u) });
    total = total.map((v, i) => v + st.u[i]);
  }
  item(final.at, { type: "AgentMessage", id: "am-" + seed, content: [{ type: "Text", text: final.text }], phase: "final_answer" });
  R(final.at + 0.05, "event_msg", { type: "task_complete", turn_id: turn, last_agent_message: final.text, duration_ms: Math.round(final.at * 1000) });
  R(final.at + 0.1, "event_msg", { type: "token_count", info: { total_token_usage: usage(total), last_token_usage: usage(steps.filter((x) => x.u).at(-1).u) } });
  const d = new Date(t0);
  const dir = join(env.CODEX_HOME, "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const stamp = iso(t0).slice(0, 19).replace(/:/g, "-");
  writeFileSync(join(dir, `rollout-${stamp}-${sid}.jsonl`), recs.map((r) => JSON.stringify(r) + "\n").join(""));
  written++;
  return { sid };
}

// ------------------------------------------------------------------ opencode
// 1.x JSON storage under XDG_DATA_HOME/opencode/storage (backfill path).
const ocStore = join(env.XDG_DATA_HOME, "opencode", "storage");
const W = (p, o) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, JSON.stringify(o, null, 1)));
function opencode({ seed, t0, model = "claude-sonnet-4-6", provider = "anthropic", prompt, steps, final }) {
  const sid = "ses_" + createHash("sha256").update("oc:" + seed).digest("hex").slice(0, 20);
  const at = (s) => t0 + Math.round(s * 1000);
  const end = at(final.at);
  W(join(ocStore, "session", "prj_codingsh", sid + ".json"), { id: sid, projectID: "prj_codingsh", directory: CWD, title: prompt, version: "1.0.150", time: { created: t0, updated: end } });
  const mu = "msg_u" + sid.slice(4, 12);
  W(join(ocStore, "message", sid, mu + ".json"), { id: mu, sessionID: sid, role: "user", time: { created: at(0.01) } });
  W(join(ocStore, "part", mu, "prt_u.json"), { id: "prt_u" + sid.slice(4, 10), messageID: mu, sessionID: sid, type: "text", text: prompt });
  steps.forEach((st, i) => {
    const ma = `msg_a${sid.slice(4, 12)}${String(i).padStart(2, "0")}`;
    const [inp, out, cr] = st.u;
    W(join(ocStore, "message", sid, ma + ".json"), { id: ma, sessionID: sid, role: "assistant", modelID: model, providerID: provider, time: { created: at(st.at - 2), completed: at(st.at + (st.dur ?? 0.3)) }, tokens: { input: inp, output: out, reasoning: 0, cache: { read: cr, write: 0 } }, finish: "tool-calls" });
    W(join(ocStore, "part", ma, `prt_${String(i).padStart(2, "0")}t.json`), {
      id: `prt_${sid.slice(4, 10)}${i}t`, messageID: ma, sessionID: sid, type: "tool", callID: `call_${sid.slice(4, 8)}_${i}`, tool: st.tool,
      state: { status: st.error ? "error" : "completed", input: st.input, output: st.out ?? "", ...(st.error ? { error: st.error } : {}), time: { start: at(st.at), end: at(st.at + (st.dur ?? 0.3)) } },
    });
  });
  const mf = `msg_a${sid.slice(4, 12)}zz`;
  W(join(ocStore, "message", sid, mf + ".json"), { id: mf, sessionID: sid, role: "assistant", modelID: model, providerID: provider, time: { created: at(final.at - 3), completed: end }, tokens: { input: final.u[0], output: final.u[1], reasoning: 0, cache: { read: final.u[2], write: 0 } }, finish: "stop" });
  W(join(ocStore, "part", mf, "prt_zz.json"), { id: "prt_zz" + sid.slice(4, 10), messageID: mf, sessionID: sid, type: "text", text: final.text, time: { start: end - 1500, end } });
  written++;
  return { sid };
}

// ================================================================== the sessions
const TEST_FAIL = `
> coding.sh@0.1.0 test
> node --no-warnings --test test/store/sqlite.test.ts

▶ SqliteIndexStore
  ✔ opens a new index at the current schema (7.9ms)
  ✔ upgrades a v2 index in place (12.4ms)
  ✔ keeps events when a session is re-ingested (5.1ms)
  ✖ applies each migration once
    SqliteError: duplicate column name: cost_usd
        at SqliteIndexStore.migrate (src/store/sqlite.ts:428:17)
        at SqliteIndexStore.open (src/store/sqlite.ts:392:11)
▶ SqliteIndexStore (41 more)
ℹ tests 42
ℹ suites 3
ℹ pass 41
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 914.2
`;
const TEST_OK = `
> coding.sh@0.1.0 test
> node --no-warnings --test test/store/sqlite.test.ts

▶ SqliteIndexStore
  ✔ opens a new index at the current schema (7.6ms)
  ✔ upgrades a v2 index in place (11.9ms)
  ✔ keeps events when a session is re-ingested (5.3ms)
  ✔ applies each migration once (41.2ms)
▶ SqliteIndexStore (41 more)
ℹ tests 42
ℹ suites 3
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 903.7
`;

// 1. The hero and Record session: Claude Code (Opus) fixes the migration race.
const s1t0 = NOW - 11 * MIN;
const hero = claude({
  seed: "sqlite-migrate-once",
  t0: s1t0,
  model: "claude-opus-4-8",
  prompt: "Apply each SQLite migration once when two processes open the index",
  steps: [
    { at: 4, text: "I'll start with how the store opens the index and runs migrations.", tool: { name: "Read", input: { file_path: P("src/store/sqlite.ts") }, out: "  380\t  static async open(path: string, opts: SqliteIndexOptions = {}) {\n  381\t    const db = new DatabaseSync(path);\n  …" }, u: [3, 310, 18200, 9400] },
    { at: 11, tool: { name: "Agent", input: { description: "Find user_version reads", prompt: "Find every place that reads or writes PRAGMA user_version or the migrations table", subagent_type: "Explore" }, out: "Two places: SqliteIndexStore.migrate reads MAX(version) from migrations before BEGIN IMMEDIATE, and writes it inside the transaction.", dur: 52 }, u: [4, 180, 27600, 1900] },
    { at: 68, text: "The version is read before the write lock, so the hook's background ingest and the CLI can both run migration 3. I'll add a test that opens a new index from two processes.", tool: { name: "Edit", input: { file_path: P("test/store/sqlite.test.ts"), old_string: "describe(\"SqliteIndexStore\", () => {", new_string: "describe(\"SqliteIndexStore\", () => {\n  it(\"applies each migration once\", async () => {\n    const path = join(await tmp(), \"index.db\");\n    await Promise.all([openInChild(path), openInChild(path)]);\n    assert.equal(await schemaVersion(path), SQLITE_SCHEMA_VERSION);\n  });" } }, u: [5, 640, 29800, 2400] },
    { at: 82, tool: { name: "Bash", input: { command: "npm test -- test/store/sqlite.test.ts", description: "Run the store tests" }, out: TEST_FAIL, error: true, dur: 21 }, u: [3, 120, 32400, 800] },
    { at: 112, text: "Reproduced: the second process fails with duplicate column name: cost_usd. I'll re-check the version inside the transaction.", tool: { name: "Edit", input: { file_path: P("src/store/sqlite.ts"), old_string: "      this.tx(() => {\n        this.db.exec(m.sql);", new_string: "      this.tx(() => {\n        // Another process may have applied this version between the read above and taking the write lock.\n        if (applied.get(m.version)) return;\n        this.db.exec(m.sql);" } }, u: [4, 520, 33900, 1600] },
    { at: 131, tool: { name: "Edit", input: { file_path: P("src/store/sqlite.ts"), old_string: "    for (const m of MIGRATIONS) {", new_string: "    const applied = this.db.prepare(\"SELECT 1 FROM migrations WHERE version = ?\");\n    for (const m of MIGRATIONS) {" } }, u: [3, 210, 35100, 700] },
    { at: 140, tool: { name: "Bash", input: { command: "npm test -- test/store/sqlite.test.ts", description: "Run the store tests" }, out: TEST_OK, dur: 20 }, u: [3, 110, 35900, 500] },
    { at: 166, tool: { name: "Bash", input: { command: "npm run typecheck", description: "Typecheck the package" }, out: "\n> coding.sh@0.1.0 typecheck\n> tsc -p tsconfig.json --noEmit\n", dur: 38 }, u: [3, 90, 36400, 300] },
    { at: 210, tool: { name: "Bash", input: { command: "git diff --stat", description: "Show the change" }, out: " src/store/sqlite.ts       |  4 ++++\n test/store/sqlite.test.ts | 22 +++++++++++++++++++++-\n 2 files changed, 25 insertions(+), 1 deletion(-)\n" }, u: [3, 80, 36900, 200] },
  ],
  final: { at: 318, text: "Each migration now re-checks the migrations table inside BEGIN IMMEDIATE, so a second process skips a version the first one already applied. The new test opens a fresh index from two processes, and all 42 store tests pass.", u: [3, 260, 37300, 400] },
  sub: {
    agentId: "a8f20c41e7", at: 11.5, end: 61, model: "claude-haiku-4-5", description: "Find user_version reads",
    prompt: "Find every place that reads or writes PRAGMA user_version or the migrations table",
    steps: [
      { at: 14, tool: { name: "Grep", input: { pattern: "user_version|FROM migrations", path: P("src") }, out: "src/store/sqlite.ts:414:    const current = this.version();\nsrc/store/sqlite.ts:431:        this.db.prepare(\"INSERT INTO migrations (version, applied_at) VALUES (?, ?)\")" }, u: [1800, 60, 0, 0] },
      { at: 22, tool: { name: "Read", input: { file_path: P("src/store/sqlite.ts") }, out: "  410\t  private migrate() {\n  …" }, u: [5200, 90, 0, 0] },
    ],
    answer: "Two places: SqliteIndexStore.migrate reads MAX(version) from migrations before BEGIN IMMEDIATE, and writes it inside the transaction.",
    u: [6100, 120, 0, 0],
  },
});

// 2. Codex adds --since to usage.
codex({
  seed: "usage-since-flag", t0: NOW - 34 * MIN, prompt: "Add --since to coding.sh usage",
  steps: [
    { at: 6, cmd: "rg -n \"since\" src/cli/commands/usage.ts src/cli/args.ts", out: "src/cli/args.ts:41:export function parseSince(v: string): number {\n", dur: 0.4, u: [21000, 14000, 380] },
    { at: 31, patch: { file: "src/cli/commands/usage.ts", old: "  const by = str(c.flags.by) ?? \"agent\";", new: "  const by = str(c.flags.by) ?? \"agent\";\n  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;" }, u: [26000, 21000, 920] },
    { at: 58, cmd: "npm test -- test/cli/usage.test.ts", out: "ℹ tests 18\nℹ pass 18\nℹ fail 0\n", dur: 9, u: [29000, 26000, 210] },
  ],
  final: { at: 84, text: "coding.sh usage now takes --since (7d, 24h or a date) and filters sessions by start time. 18 usage tests pass." },
});

// 3. OpenCode fixes the Antigravity adapter's session title.
opencode({
  seed: "antigravity-title", t0: NOW - 58 * MIN, prompt: "Fix the Antigravity adapter's session title",
  steps: [
    { at: 3, tool: "read", input: { filePath: P("src/adapters/more/antigravity.ts") }, out: "…", u: [3900, 140, 16400] },
    { at: 41, tool: "edit", input: { filePath: P("src/adapters/more/antigravity.ts"), oldString: "title: str(meta.summary),", newString: "title: makeTitle(str(meta.firstPrompt) ?? str(meta.summary))," }, out: "Edit applied", u: [4100, 380, 18900] },
    { at: 66, tool: "bash", input: { command: "npm test -- test/adapters/antigravity.test.ts", description: "Run adapter tests" }, out: "ℹ tests 9\nℹ pass 9\nℹ fail 0\n", dur: 6, u: [2400, 90, 20100] },
  ],
  final: { at: 92, text: "Sessions now take their title from the first prompt, falling back to Antigravity's summary.", u: [1900, 120, 21000] },
});

// 4. Claude Code (Sonnet) skips the site deploy without a token.
claude({
  seed: "site-deploy-skip", t0: NOW - 2 * 60 * MIN, model: "claude-sonnet-4-6",
  prompt: "Skip the site deploy when CLOUDFLARE_API_TOKEN is unset",
  steps: [
    { at: 3, tool: { name: "Read", input: { file_path: P(".github/workflows/site.yml") }, out: "    - run: npx wrangler deploy\n" }, u: [3, 140, 14100, 6200] },
    { at: 19, text: "I'll gate the deploy step on the secret and print a notice when it's missing.", tool: { name: "Edit", input: { file_path: P(".github/workflows/site.yml"), old_string: "    - run: npx wrangler deploy", new_string: "    - if: env.CLOUDFLARE_API_TOKEN == ''\n      run: echo \"::notice::CLOUDFLARE_API_TOKEN is not set, skipping deploy\"\n    - if: env.CLOUDFLARE_API_TOKEN != ''\n      run: npx wrangler deploy" } }, u: [3, 380, 15800, 900] },
    { at: 37, tool: { name: "Bash", input: { command: "actionlint .github/workflows/site.yml", description: "Lint the workflow" }, out: "", dur: 1.2 }, u: [3, 70, 16500, 300] },
  ],
  final: { at: 52, text: "The deploy step now runs only when CLOUDFLARE_API_TOKEN is set, and forks get a notice instead of a red build.", u: [3, 120, 16800, 200] },
});

// 5. OpenCode speeds up the viewer's session list (2 failed tool calls).
opencode({
  seed: "viewer-list-speed", t0: NOW - 3 * 60 * MIN - 12 * MIN, prompt: "Speed up the viewer's session list",
  steps: [
    { at: 5, tool: "read", input: { filePath: P("src/viewer/ui/index.html") }, out: "…", u: [4200, 160, 18000] },
    { at: 24, tool: "bash", input: { command: "npm run bench -- viewer-list", description: "Benchmark the list" }, error: "npm error Missing script: \"bench\"", u: [3100, 90, 22100] },
    { at: 40, tool: "bash", input: { command: "node scripts/bench-viewer.mjs --sessions 5000", description: "Benchmark the list" }, error: "Error: Cannot find module 'scripts/bench-viewer.mjs'", u: [2900, 80, 23300] },
    { at: 71, tool: "edit", input: { filePath: P("src/viewer/ui/index.html"), oldString: "rows.forEach((s) => ul.append(row(s)));", newString: "ul.replaceChildren(...rows.map(row));" }, out: "Edit applied", u: [3800, 420, 24600] },
    { at: 96, tool: "bash", input: { command: "npm test -- test/viewer/ui.test.ts", description: "Run viewer tests" }, out: "ℹ tests 31\nℹ pass 31\nℹ fail 0\n", dur: 7, u: [2600, 110, 25900] },
  ],
  final: { at: 121, text: "The list now renders in one replaceChildren call instead of 5,000 appends. 31 viewer tests pass.", u: [2200, 140, 26800] },
});

// 6. Codex commits the eval task fixtures.
codex({
  seed: "eval-fixtures-commit", t0: NOW - 5 * 60 * MIN, prompt: "Commit the eval task fixtures",
  steps: [
    { at: 4, cmd: "git status --short", out: "?? evals/cli/tasks/\n", dur: 0.2, u: [16000, 11000, 150] },
    { at: 18, patch: { file: ".gitignore", old: "tasks/", new: "/tasks/" }, u: [18500, 15000, 340] },
    { at: 29, cmd: "git status --short", out: " M .gitignore\n?? evals/cli/tasks/retry-locked-index/\n", dur: 0.2, u: [19800, 17000, 120] },
  ],
  final: { at: 44, text: "The ignore rule is now anchored to the repo root, so evals/cli/tasks shows up and can be committed." },
});

// 7. Claude Code (Sonnet) declares the desk runner label.
claude({
  seed: "desk-runner-label", t0: NOW - 7 * 60 * MIN, model: "claude-sonnet-4-6",
  prompt: "Declare the desk runner label for actionlint",
  steps: [
    { at: 4, tool: { name: "Edit", input: { file_path: P(".github/actionlint.yaml"), old_string: "self-hosted-runner:\n  labels: []", new_string: "self-hosted-runner:\n  labels: [desk]" } }, u: [3, 160, 12600, 4800] },
  ],
  final: { at: 15, text: "actionlint now knows the desk label, so the self-hosted jobs stop failing lint.", u: [3, 60, 13100, 200] },
});

// 8. Claude Code (Haiku) explains the locked spool, read only.
claude({
  seed: "explain-locked-spool", t0: NOW - 9 * 60 * MIN, model: "claude-haiku-4-5",
  prompt: "Explain how ingest handles a locked spool",
  steps: [
    { at: 3, tool: { name: "Read", input: { file_path: P("src/core/lock.ts") }, out: "export async function withIngestLock…" }, u: [6, 120, 9800, 5100] },
    { at: 9, tool: { name: "Read", input: { file_path: P("src/core/ingest.ts") }, out: "…" }, u: [6, 90, 15200, 3400] },
  ],
  final: { at: 26, text: "Ingest takes spool/.ingest.lock first. If another process holds it, the hook's background ingest exits at once and the next run picks up the new lines from the saved byte offset.", u: [6, 340, 18900, 300] },
});
const RECENT = written;

// ------------------------------------------------------------------ older days, same repo
const OLD = {
  claude: [
    "Add a --json flag to coding.sh show", "Retry the OTLP export on 503", "Stream large blobs instead of buffering them",
    "Paginate the sessions API", "Debounce the viewer search box", "Fix the flaky hook test on Windows",
    "Cap the OTLP request body at 16 MiB", "Rename the TOK/TURN column", "Evict old blobs from the cache",
    "Handle an empty spool in ingest", "Redact bearer tokens in tool output", "Make ingest idempotent across restarts",
    "Fix the N+1 query for subagents", "Show the timezone in usage --by day", "Add a plural helper to the viewer",
    "Fix the memory leak in the viewer's event pane", "Read Codex token counts from token_usage_record",
    "Upgrade esbuild", "Add coding.sh sessions --json", "Group usage by repo",
  ],
  codex: [
    "Parse --since as a date", "Add usage --by repo", "Write tests for the redaction rules", "Speed up search over 10k sessions",
    "Fix the Windows path in the hook installer", "Add a healthcheck to coding.sh serve", "Port the Goose adapter to the new emitter",
    "Bump the Postgres store's pool size",
  ],
  opencode: ["Add a Python SDK example", "Fix the Aider adapter's cost", "Explain the experiment store schema"],
};
const seqs = { claude: 0, codex: 0, opencode: 0 };
let seq = 0;
const FOLLOW_UPS = ["Run the full suite too", "Add a test for the empty case", "Rename it to match the docs", "Now update the changelog", "Check the Windows path as well"];
/** Splits a session into turns: follow-up prompts between its steps. */
const withTurns = (steps, turns) => {
  for (let t = turns - 1; t > 0; t--) {
    const k = Math.round((t * steps.length) / turns);
    steps.splice(k, 0, { at: steps[k - 1].at + 5, user: FOLLOW_UPS[(t + seq) % FOLLOW_UPS.length] });
  }
};
const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
const pick = (lo, hi) => Math.round(lo + rnd() * (hi - lo));
for (let day = 1; day <= 6; day++) {
  const perDay = { claude: 4, codex: 2, opencode: day % 2 ? 1 : 0 };
  for (const [agent, count] of Object.entries(perDay)) {
    for (let i = 0; i < count; i++) {
      const list = OLD[agent];
      const prompt = list[seqs[agent]++ % list.length];
      seq++;
      const t0 = NOW - day * DAY - pick(1, 9) * 60 * MIN - pick(0, 59) * MIN;
      const nSteps = pick(4, 12);
      const file = ["src/cli/commands/show.ts", "src/otel/receiver.ts", "src/store/fs-blobs.ts", "src/viewer/server.ts", "src/core/ingest.ts", "test/cli/show.test.ts"][seq % 6];
      if (agent === "claude") {
        const model = i === 0 && day % 2 ? "claude-opus-4-8" : "claude-sonnet-4-6";
        let clock = 4;
        const steps = Array.from({ length: nSteps }, (_, k) => ({
          at: (clock += pick(8, 30)),
          tool: k % 3 === 2 ? { name: "Bash", input: { command: "npm test" }, out: "ℹ tests 1204\nℹ pass 1204\nℹ fail 0\n", dur: 30 } : k % 3 === 1 ? { name: "Edit", input: { file_path: P(file), old_string: "a", new_string: "b" } } : { name: "Read", input: { file_path: P(file) }, out: "…" },
          u: [4, pick(150, 700), pick(20000, 60000), pick(500, 6000)],
        }));
        withTurns(steps, pick(2, 6));
        claude({ seed: `old-${day}-${agent}-${i}`, t0, model, prompt, steps, final: { at: steps.at(-1).at + 20, text: "Done.", u: [3, 120, 40000, 300] } });
      } else if (agent === "codex") {
        let clock = 4;
        const steps = Array.from({ length: nSteps }, (_, k) => ({
          at: (clock += pick(8, 25)),
          ...(k % 2 ? { patch: { file, old: "a", new: "b" } } : { cmd: "npm test", out: "ℹ tests 1204\nℹ pass 1204\nℹ fail 0\n", dur: 25 }),
          u: [pick(20000, 60000), pick(15000, 50000), pick(200, 900)],
        }));
        withTurns(steps, pick(2, 4));
        codex({ seed: `old-${day}-${agent}-${i}`, t0, prompt, steps, final: { at: steps.at(-1).at + 15, text: "Done." } });
      } else {
        const steps = Array.from({ length: nSteps }, (_, k) => ({ at: 4 + k * 15, tool: k % 2 ? "edit" : "read", input: { filePath: P(file), oldString: "a", newString: "b" }, out: "ok", u: [pick(2000, 6000), pick(100, 500), pick(15000, 40000)] }));
        opencode({ seed: `old-${day}-${agent}-${i}`, t0, prompt, steps, final: { at: steps.at(-1).at + 20, text: "Done.", u: [2000, 150, 30000] } });
      }
    }
  }
}

// ------------------------------------------------------------------ ingest through the real adapters
const cli = (args, opts = {}) => execFileSync(process.execPath, [CLI, ...args], { cwd: CWD, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
cli(["ingest", "--backfill"]);

const listed = JSON.parse(cli(["sessions", "--json", "--limit", "500"])).sessions;
const repos = new Set(listed.map((s) => (s.repo ? s.repo.split("/").pop() : "(none)")));
if (listed.length !== written || repos.size !== 1 || !repos.has("coding.sh")) {
  console.error(`seed check failed: wrote ${written} sessions, listed ${listed.length}, repos ${[...repos].join(", ")}`);
  console.error(listed.map((s) => `${s.agent}\t${s.title}`).join("\n"));
  process.exit(1);
}

// ------------------------------------------------------------------ the experiment (Compare)
// 2 bundles, 20 tasks, 200 runs, written with the product's own store code.
const store = await SqliteIndexStore.open(join(CS, "index.db"));
const EXP = "claude-md-rewrite";
const bundle = (name, note) => ({ id: createHash("sha256").update("bundle:" + name).digest("hex"), name, agent: "claude-code", model: "claude-sonnet-4-6", flags: [], env: {}, files: {}, remove: [], createdAt: NOW - 3 * 60 * MIN, note });
const before = bundle("before", "CLAUDE.md as it is today");
const after = bundle("after", "the rewritten CLAUDE.md");
await store.putBundle(before);
await store.putBundle(after);
const expT0 = NOW - 2 * 60 * MIN - 40 * MIN;
let r = 0;
const rr = (() => { let s = 1842; return () => ((s = (s * 48271) % 2147483647) / 2147483647); })();
for (const [ti, t] of TASKS.entries()) {
  await store.putTask({
    id: t.task, name: t.task, status: "validated", start: { repoRoot: CWD, snapshot: "", head: "" }, instruction: t.task,
    setup: ["npm ci"], verifier: { command: "npm test", hiddenFiles: {}, timeoutMs: 600_000 }, tags: ["coding.sh"], createdAt: NOW - 2 * DAY + ti * MIN,
  });
  for (const [arm, b] of [["base", before], ["cand", after]]) {
    for (let k = 0; k < t[arm].length; k++) {
      const started = expT0 + r * 9_000;
      const dur = Math.round(60_000 + rr() * 180_000);
      const pass = t[arm][k] === "1";
      await store.putRun({
        id: `run_${EXP}_${b.name}_${t.task}_${k}`, experimentId: EXP, taskId: t.task, bundleId: b.id, attempt: k, pass, verifierExit: pass ? 0 : 1,
        agent: { exitCode: 0, timedOut: false, durationMs: dur, usage: { costUsd: Math.round((0.05 + rr() * 0.25) * 10000) / 10000 }, stdoutTail: "", stderrTail: "" },
        startedAt: started, endedAt: started + dur,
      });
      r++;
    }
  }
}
await store.close?.();

// ------------------------------------------------------------------ usage output (for the Measure section)
const usage = cli(["usage", "--since", "7d"]);

console.log(`root     ${ROOT}`);
console.log(`sessions ${written} (${RECENT} today), ${r} experiment runs`);
console.log(`hero     ${hero.sid}`);
console.log(`\n$ coding.sh usage --since 7d\n${usage}`);

if (process.env.SHOTS_NO_SERVE === "1") process.exit(0);

// ------------------------------------------------------------------ servers
function start(args, extraEnv) {
  return new Promise((resolveUrl, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: CWD, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const m = /https?:\/\/\S+/.exec(buf);
      if (m) resolveUrl({ url: m[0], proc: p });
    });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("exit", (code) => reject(new Error(`${args[0]} exited ${code}: ${buf}`)));
  });
}
const ui = await start(["ui", "--port", process.env.SHOTS_UI_PORT || "4319", "--no-open"]);
const serve = await start(["serve", "--port", "0"], { CODING_SH_HOME: PROD });

// Production: 8 runs of a bot that labels issues on jackulau/coding.sh, as
// OTLP/JSON gen_ai spans: one chat request per issue, the way the SDK's
// observe() records it. The prompt is the issue title (the instructions are the
// system message), so each run is titled by its issue. One request fails: the
// provider rate-limited it (429), so it has no tokens, no cost and no answer.
const SYSTEM = "Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.";
const ISSUES = [
  ["gpt-5-mini", "coding.sh usage shows $0.00 for Cursor sessions", "question, usage", 1620, 31, 1.4],
  ["claude-haiku-4-5", "Viewer search misses tool output", "bug, viewer", 2210, 38, 2.2],
  ["gpt-5-mini", "Add a Kiro CLI adapter", "enhancement, adapters", 1490, 29, 1.2],
  ["claude-haiku-4-5", "serve returns 413 for large OTLP batches", "bug, serve", 2650, 33, 1.9],
  ["gpt-5-mini", "Docs link to /docs/otel is broken", "docs", 1310, 22, 1.1],
  ["claude-haiku-4-5", "eval new fails on a detached HEAD", "bug, evals", 2380, 41, 2.6],
  ["gpt-5-mini", "Hook exits 1 on Windows", "", 0, 0, 0.3, "429 Rate limit exceeded"],
  ["gpt-5-mini", "Support Postgres 17", "enhancement, store", 1550, 27, 1.3],
];
const hex = (n, seed) => createHash("sha256").update(seed).digest("hex").slice(0, n);
const attr = (key, v) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: String(v) } });
const spans = [];
ISSUES.forEach(([model, issue, labels, inTok, outTok, secs, error], i) => {
  const t0 = BigInt(NOW - (ISSUES.length - i) * 7 * MIN) * 1_000_000n;
  const t1 = t0 + BigInt(Math.round(secs * 1e9));
  const provider = model.startsWith("gpt") ? "openai" : "anthropic";
  spans.push({
    traceId: hex(32, "trace" + i), spanId: hex(16, "chat" + i), name: `chat ${model}`, kind: 3, startTimeUnixNano: String(t0), endTimeUnixNano: String(t1),
    attributes: [
      attr("gen_ai.operation.name", "chat"), attr("gen_ai.provider.name", provider), attr("gen_ai.request.model", model),
      attr("gen_ai.input.messages", JSON.stringify([{ role: "system", parts: [{ type: "text", content: SYSTEM }] }, { role: "user", parts: [{ type: "text", content: issue }] }])),
      ...(error
        ? [attr("error.type", "429")]
        : [
          attr("gen_ai.response.model", model), attr("gen_ai.usage.input_tokens", inTok), attr("gen_ai.usage.output_tokens", outTok),
          attr("gen_ai.output.messages", JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: labels }], finish_reason: "stop" }])),
        ]),
    ],
    status: error ? { code: 2, message: error } : { code: 1 },
  });
});
const body = { resourceSpans: [{ resource: { attributes: [attr("service.name", "coding-sh-triage"), attr("service.version", "0.4.2")] }, scopeSpans: [{ scope: { name: "@coding.sh/sdk", version: "0.1.0" }, spans }] }] };
const base = new URL(serve.url);
const res = await fetch(new URL("/v1/traces", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
if (!res.ok) {
  console.error(`POST /v1/traces: ${res.status} ${await res.text()}`);
  process.exit(1);
}

console.log(`ui       ${ui.url}`);
console.log(`serve    ${serve.url}`);
console.log("Ctrl-C to stop.");
const stop = () => { ui.proc.kill(); serve.proc.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
