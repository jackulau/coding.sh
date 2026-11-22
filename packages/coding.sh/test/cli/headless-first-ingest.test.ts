// A fresh `claude -p` session is whole after its first ingest. The hook's background ingest
// runs at Stop, before SessionEnd is written: what that ingest stores (the headless launch,
// the flags) matches a single ingest of the finished spool. Hook lines shaped like a capture of
// the pinned Claude Code against scripts/e2e/stub-model.mjs (paths scrubbed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { removeTestDir } from "../_rm.ts";
import { CLI } from "../_cli.ts";

const root = mkdtempSync(join(tmpdir(), "csh-headless-first-"));
after(() => removeTestDir(root));

const ID = "e1a0d95d-51ab-4bc7-908d-6a53dc8d254c";
const T0 = 1_795_334_690_865;
const raw = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: ID, transcript_path: join(root, "claude", "projects", "-work-demo", `${ID}.jsonl`), cwd: "/work/demo", hook_event_name: event, ...extra });
const line = (event: string, dt: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 0, agent: "claude-code", event, ts: T0 + dt, pid: 1, ppid: 2, cwd: "/work/demo", raw: raw(event, extra), entrypoint: "sdk-cli" }) + "\n";
const tool = { tool_name: "Read", tool_input: { file_path: "/work/demo/notes.txt" }, tool_use_id: "toolu_1" };
const LINES = [
  line("SessionStart", 0, { source: "startup" }),
  line("UserPromptSubmit", 243, { prompt: "Read notes.txt", permission_mode: "bypassPermissions" }),
  line("PreToolUse", 508, tool),
  line("PostToolUse", 697, { ...tool, tool_response: { type: "text", file: { content: "alpha\n" } } }),
  line("Stop", 910, { stop_hook_active: false, last_assistant_message: "Done." }),
];
const END = line("SessionEnd", 1096, { reason: "other" });

function home(name: string) {
  const dir = join(root, name);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "user"), USERPROFILE: join(dir, "user"), CODING_SH_HOME: join(dir, "csh"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(dir, "codex"), CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_URL", "CODING_SH_FORWARD_URL", "CODING_SH_DEV_REAL_STORE", "CODING_SH_RUN_ID"]) delete env[k];
  const spool = join(dir, "csh", "spool", "claude-code", "2026-11-22.jsonl");
  mkdirSync(join(dir, "csh", "spool", "claude-code"), { recursive: true });
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const session = () => {
    const doc = JSON.parse(cli(["sessions", "--json", "--empty", "--include-runs"])) as { sessions: { id: string; flags: string[]; title?: string }[] };
    const s = doc.sessions.find((x) => x.id === ID)!;
    assert.ok(s, "the session is listed");
    const shown = JSON.parse(cli(["show", ID, "--json"])) as { session: { flags: string[]; stats: { launch?: string; turns: number; toolCalls: number } } };
    return { flags: s.flags, title: s.title, launch: shown.session.stats.launch, turns: shown.session.stats.turns, toolCalls: shown.session.stats.toolCalls };
  };
  return { spool, cli, session };
}

it("the ingest the Stop hook starts already stores the headless launch and the flags a later ingest would", () => {
  const staged = home("staged");
  writeFileSync(staged.spool, LINES.join(""));
  staged.cli(["ingest"]); // what the background ingest at Stop sees
  const first = staged.session();
  assert.equal(first.launch, "headless", "headless from the first ingest");
  appendFileSync(staged.spool, END);
  staged.cli(["ingest"]);
  const later = staged.session();

  const once = home("once");
  writeFileSync(once.spool, LINES.join("") + END);
  once.cli(["ingest"]);
  const whole = once.session();

  assert.deepEqual(first, whole, "the first ingest misses nothing a later one adds");
  assert.deepEqual(later, whole);
  assert.equal(whole.title, "Read notes.txt");
});
