// Real Claude Code 2.1.319 sessions with hook-injected context
// (scripts/e2e/hook-context-capture.mjs): project hooks in .claude/settings.json
// (SessionStart plain stdout, UserPromptSubmit additionalContext) in every
// session, plus the "terse" plugin's SessionStart and PostToolUse(Read)
// additionalContext, loaded with --plugin-dir in one session and installed
// from a marketplace in another. The fixture config dir holds the install
// record and the installed plugin, so its hooks are named after it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { ClaudeTranscriptConverter } from "../../src/adapters/_shared/claude-transcript.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { toMetadata } from "../../src/core/redact.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { assertWellFormed, collect, FIXTURES, testCtx, tmpEnv, type TmpEnv } from "./_helpers.ts";

const CONFIG = join(FIXTURES, "claude-code", "hooks-real", "config");
const PLAIN = "fd08f71c-fbd8-4bb1-a1aa-114160e07141";
const PLUGIN_DIR = "3bcbc506-9513-4a2a-9315-96d125d275ff";
const INSTALLED = "cad8f087-2e7c-410b-92a2-6df89bb5fa57";
const PROJECT_START = "PROJECT-START: build with make, never npm.";
const PROJECT_PROMPT = "PROJECT-PROMPT: the user prefers short answers.";
const TERSE_START = "TERSE-MODE: answer in as few words as possible. Drop articles and filler.";
const TERSE_READ = "TERSE-READ: summarize files in one line.";

const hookEvents = (events: AgentEvent[], sid: string) => events.filter((e) => e.sessionId === sid && e.kind === "notification" && e.payload.kind === "hook.context");
const brief = (e: AgentEvent) => [e.payload.hookEvent, e.payload.hookSource, e.payload.text, e.payload.tokens];
const tok = (s: string) => Math.ceil(s.length / 4);

async function backfillFrom(config: string): Promise<AgentEvent[]> {
  process.env.CLAUDE_CONFIG_DIR = config;
  const events = await collect(claudeCode.backfill!(testCtx().ctx));
  assertWellFormed(events);
  return events;
}

describe("hook context: real Claude Code 2.1.319 transcripts", () => {
  let env: TmpEnv;
  let events: AgentEvent[];
  before(async () => {
    env = tmpEnv();
    events = await backfillFrom(CONFIG);
  });
  after(() => env.restore());

  it("records each text a hook added, with its hook event, source and size", () => {
    const project = [
      ["SessionStart", "settings", PROJECT_START, tok(PROJECT_START)],
      ["UserPromptSubmit", "unknown", PROJECT_PROMPT, tok(PROJECT_PROMPT)],
    ];
    assert.deepEqual(hookEvents(events, PLAIN).map(brief), project);
    const withPlugin = [
      ["SessionStart", "settings", PROJECT_START, tok(PROJECT_START)],
      ["SessionStart", "plugin:terse", TERSE_START, tok(TERSE_START)],
      ["UserPromptSubmit", "unknown", PROJECT_PROMPT, tok(PROJECT_PROMPT)],
      ["PostToolUse", "plugin:terse", TERSE_READ, tok(TERSE_READ)],
    ];
    // --plugin-dir and an installed copy run the same commands: both are terse's.
    assert.deepEqual(hookEvents(events, PLUGIN_DIR).map(brief), withPlugin);
    assert.deepEqual(hookEvents(events, INSTALLED).map(brief), withPlugin);
    const start = hookEvents(events, INSTALLED).find((e) => e.payload.text === TERSE_START)!;
    assert.equal(start.payload.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/start.js"');
    assert.equal(start.payload.hookName, "SessionStart");
    assert.equal(start.turnId, undefined, "a SessionStart's context belongs to no turn");
    const read = hookEvents(events, INSTALLED).find((e) => e.payload.text === TERSE_READ)!;
    assert.ok(read.turnId, "a PostToolUse's context belongs to its turn");
  });

  it("the JSON stdout of an additionalContext hook is not counted a second time", () => {
    for (const sid of [PLUGIN_DIR, INSTALLED]) assert.equal(hookEvents(events, sid).filter((e) => String(e.payload.text).includes("hookSpecificOutput")).length, 0);
  });

  it("sessions: hookContext stats and hook:<source> tags; none without hook context", () => {
    const sessionOf = (sid: string) => buildSession(events.filter((e) => e.sessionId === sid));
    const plain = sessionOf(PLAIN);
    assert.deepEqual(plain.stats.hookContext, {
      count: 2,
      tokens: tok(PROJECT_START) + tok(PROJECT_PROMPT),
      bySource: { settings: { count: 1, tokens: tok(PROJECT_START) }, unknown: { count: 1, tokens: tok(PROJECT_PROMPT) } },
    });
    assert.deepEqual(plain.flags.filter((f) => f.startsWith("hook:")), ["hook:settings", "hook:unknown"]);
    const installed = sessionOf(INSTALLED);
    assert.deepEqual(installed.stats.hookContext?.bySource["plugin:terse"], { count: 2, tokens: tok(TERSE_START) + tok(TERSE_READ) });
    assert.deepEqual(installed.flags.filter((f) => f.startsWith("hook:")), ["hook:settings", "hook:plugin:terse", "hook:unknown"]);
    const none = buildSession(events.filter((e) => e.sessionId === PLAIN && !(e.kind === "notification" && e.payload.kind === "hook.context")));
    assert.equal(none.stats.hookContext, undefined);
    assert.ok(!none.flags.some((f) => f.startsWith("hook:")));
  });

  it("metadata mode keeps the hook event, source and size, never the text or command", () => {
    const m = toMetadata(hookEvents(events, INSTALLED).find((e) => e.payload.text === TERSE_START)!);
    assert.deepEqual(m.payload, { kind: "hook.context", hookEvent: "SessionStart", hookSource: "plugin:terse", chars: TERSE_START.length, tokens: tok(TERSE_START) });
  });
});

describe("hook context without the plugin installed", () => {
  let env: TmpEnv;
  let root: string;
  before(() => {
    env = tmpEnv();
    root = mkdtempSync(join(tmpdir(), "csh-hookctx-"));
  });
  after(() => {
    env.restore();
    rmSync(root, { recursive: true, force: true });
  });

  it("a plugin hook whose plugin is not installed is source 'plugin'", async () => {
    const config = join(root, "config");
    mkdirSync(config);
    cpSync(join(CONFIG, "projects"), join(config, "projects"), { recursive: true });
    const events = await backfillFrom(config);
    assert.deepEqual(
      hookEvents(events, PLUGIN_DIR).map((e) => e.payload.hookSource),
      ["settings", "plugin", "unknown", "plugin"],
    );
  });
});

describe("hook context in a live Stop window", () => {
  it("the first turn's window carries the SessionStart context written before the prompt", async () => {
    const env = tmpEnv();
    try {
      const transcript = join(CONFIG, "projects", "-work-demo", `${INSTALLED}.jsonl`);
      const { ctx } = testCtx();
      const stop = { v: 1, agent: "claude-code", event: "Stop", ts: Date.parse("2026-11-08T05:00:00Z"), pid: 1, raw: { hook_event_name: "Stop", session_id: INSTALLED, transcript_path: transcript, cwd: "/work/demo" } };
      const live = await claudeCode.normalize(stop as never, ctx);
      const full = await backfillFrom(CONFIG);
      const ids = (es: AgentEvent[]) => hookEvents(es, INSTALLED).map((e) => e.id).sort();
      // Same ids as the backfill's, so the two copies store once.
      assert.deepEqual(ids(live), ids(full));
      assert.equal(ids(live).length, 4);
    } finally {
      env.restore();
    }
  });

  it("older transcripts without `rendered`: plain stdout of SessionStart and UserPromptSubmit only", async () => {
    const { ctx } = testCtx();
    const conv = new ClaudeTranscriptConverter(ctx, { agent: "claude-code", mode: "full", sessionId: "s1", source: "t.jsonl" });
    const ts = "2026-11-08T04:00:00.000Z";
    const success = (uuid: string, hookEvent: string, content: string) => ({ type: "attachment", uuid, timestamp: ts, attachment: { type: "hook_success", hookName: hookEvent, hookEvent, content, stdout: `${content}\n`, command: "./hook.sh" } });
    await conv.add(success("a", "SessionStart", "start text"), 0);
    await conv.add(success("b", "PostToolUse", "post text"), 1);
    await conv.add(success("c", "UserPromptSubmit", "   "), 2);
    const out = (await conv.finish(true)).filter((e) => e.payload.kind === "hook.context");
    assert.deepEqual(out.map((e) => [e.payload.hookEvent, e.payload.text, e.payload.hookSource]), [["SessionStart", "start text", "settings"]]);
  });
});

describe("hook context in the CLI", () => {
  const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  let root = "";
  let env: NodeJS.ProcessEnv;
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  before(() => {
    root = mkdtempSync(join(tmpdir(), "csh-hookctx-cli-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    env = {
      ...process.env,
      ["HO" + "ME"]: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      CLAUDE_CONFIG_DIR: CONFIG,
      CODEX_HOME: join(root, "codex"),
      T3CODE_HOME: join(root, "t3"),
      CODING_SH_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      TZ: "UTC",
    };
    cli("ingest", "--backfill", "--agent", "claude-code");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("sessions --where hook:plugin:terse splits the sessions the plugin added context to", () => {
    const ids = (where: string) => (JSON.parse(cli("sessions", "--where", where, "--json")) as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort();
    assert.deepEqual(ids("hook:plugin:terse"), [PLUGIN_DIR, INSTALLED].sort());
    assert.deepEqual(ids("-hook:plugin:*"), [PLAIN]);
    assert.deepEqual(ids("hook.tokens>30"), [PLUGIN_DIR, INSTALLED].sort());
  });

  it("sessions --facets hook counts sessions per source", () => {
    const rows = (JSON.parse(cli("sessions", "--facets", "hook", "--json")) as { facets: Record<string, { value: string; count: number }[]> }).facets.hook!;
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.value, r.count])), { settings: 3, unknown: 3, "plugin:terse": 2 });
  });

  it("show: the Hook context row and hook lines in the timeline", () => {
    const text = cli("show", INSTALLED);
    assert.match(text, /Hook context\s+4 texts, ~52 tokens: plugin:terse ~29 \(2\), unknown ~12 \(1\), settings ~11 \(1\)/);
    assert.doesNotMatch(text, /Phases/, "hook output before the prompt is no resume");
    assert.match(text, /hook\s+SessionStart plugin:terse ~\d+ tok\s+TERSE-MODE: answer in as few words/);
    const j = JSON.parse(cli("show", INSTALLED, "--json")) as { session: { stats: { hookContext?: { count: number } } } };
    assert.equal(j.session.stats.hookContext?.count, 4);
  });
});
