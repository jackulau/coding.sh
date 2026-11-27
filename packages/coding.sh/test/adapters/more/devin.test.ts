// Devin CLI (src/adapters/more/devin.ts): hook payloads to events, install into the user config
// or the project's .devin/config.local.json, `devin -p` runs, and eval overlays. The synthetic
// spool (devin/hooks.spool.jsonl) uses the payload shapes recorded live from v3000.14.30821
// (devin/real/hooks.spool.jsonl, scripts/e2e/devin-capture.mjs) and the hook docs for the events
// a capture without a login cannot reach (tool calls, Stop, PostCompaction).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildHookCommand } from "../../../src/adapters/_shared/hooks.ts";
import { parseJsonc } from "../../../src/adapters/more/_util.ts";
import { DEVIN_HOOK_EVENTS, devinAdapter, devinExport, devinHookTarget } from "../../../src/adapters/more/devin.ts";
import { paths } from "../../../src/core/paths.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { devinConfigDir } from "../../../src/spool/devin.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertRunOk, assertWellFormed, fakeBinary, HOOK, loadSpool, moreEnv, normalizeFixture, readArgv, runSpec, summarize, testCtx, writeFile } from "./_helpers.ts";

const SPOOL = "devin/hooks.spool.jsonl";
const PROMPT_1 = "5f0c2a8e-1d7b-4c2e-9a51-3e6f0b9d2c11";
const PROMPT_2 = "8a3d71c4-6e2f-4b90-8c1a-d47e5f203b68";
const ASK = "Devin needs your permission to use exec: echo ok > notes.txt && python -m pytest";

describe("devin normalize", () => {
  let events: AgentEvent[];
  before(async () => {
    events = await normalizeFixture(devinAdapter, SPOOL);
  });

  it("maps hook payloads to golden events", () => {
    assertWellFormed(events);
    assertGolden("devin/golden/hooks.golden.json", summarize(events));
    assert.ok(events.every((e) => e.agent === "devin" && e.sessionId === "brave-otter" && e.cwd === "/work/demo"));
  });

  it("keys each prompt's events on its prompt_id", () => {
    const { ctx } = testCtx();
    const turn = (promptId: string) => ctx.id("devin", "brave-otter", "turn", promptId);
    assert.equal(events[0]!.kind, "session.start");
    assert.equal(events[0]!.turnId, undefined, "SessionStart comes before the first prompt_id");
    assert.deepEqual([...new Set(events.slice(1).map((e) => e.turnId))], [turn(PROMPT_1), turn(PROMPT_2)]);
    assert.equal(events.find((e) => e.kind === "user.message" && e.payload.text === "now delete notes.txt")!.turnId, turn(PROMPT_2));
  });

  it("maps tool calls, their results, file writes and the test run", () => {
    assert.ok(events.filter((e) => e.kind === "tool.start").every((e) => e.payload.toolUseId === undefined), "Devin's hooks name no call id");
    const read = events.find((e) => e.kind === "tool.end" && e.payload.tool === "read")!;
    assert.equal(read.payload.ok, false);
    assert.equal(read.payload.error, "File not found: /work/demo/missing.py");
    assert.deepEqual(
      events.filter((e) => e.kind === "file.change").map((e) => [e.payload.path, e.payload.op, e.payload.tool]),
      [["hello.py", "modify", "write"]],
    );
    const exec = events.find((e) => e.kind === "tool.start" && e.payload.tool === "exec")!;
    assert.equal(exec.payload.verify, true, "a pytest run is a verify call");
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["pytest", 2, 0]);
  });

  it("a Stop that a Stop hook blocked continues the turn; the next Stop ends it", () => {
    const ends = events.filter((e) => e.kind === "turn.end");
    assert.deepEqual(
      ends.map((e) => e.payload.stopHookActive === true),
      [false, true, false],
    );
    assert.equal(events.filter((e) => e.kind === "assistant.message").length, 3, "each Stop's last_assistant_message");
    assert.equal(events.filter((e) => e.kind === "context.compact").length, 1);
  });

  it("builds the session: two turns, the exec's write counted, tests and a compaction", () => {
    const s = buildSession(events);
    assert.equal(s.agent, "devin");
    assert.equal(s.title, "Create hello.py, then run the tests");
    assert.equal(s.stats.turns, 2);
    assert.equal(s.stats.toolCalls, 5);
    assert.equal(s.stats.toolErrors, 1);
    assert.equal(s.stats.filesChanged, 2, "hello.py from write, notes.txt from the exec's redirect");
    assert.equal(s.stats.testsPassed, 2);
    assert.equal(s.stats.testsFailed, 0);
    assert.ok(s.flags.includes("compaction"), s.flags.join(","));
    assert.equal(s.endedAt, 1790000021000);
    assert.equal(s.stats.waiting, undefined, "the session ended");
  });

  it("a PermissionRequest blocks the session until the exec ends", () => {
    const at = events.findIndex((e) => e.kind === "notification");
    const note = events[at]!;
    assert.deepEqual([note.payload.kind, note.payload.tool, note.payload.message], ["permission_prompt", "exec", ASK]);
    assert.deepEqual(buildSession(events.slice(0, at + 1)).stats.waiting, { kind: "permission", at: 1790000004100, text: ASK });
    const ran = events.findIndex((e) => e.kind === "tool.end" && e.payload.tool === "exec");
    assert.equal(buildSession(events.slice(0, ran + 1)).stats.waiting, undefined);
  });
});

describe("devin copies", () => {
  it("one firing that two hook files run gives one set of ids", async () => {
    // Live: with coding.sh hooks in the user config and in a project file, each event runs both, about 90 ms apart.
    const line = loadSpool(SPOOL)[2]!;
    const { ctx } = testCtx();
    const first = (await devinAdapter.normalize(line, ctx)).map((e) => e.id);
    const copy = (await devinAdapter.normalize({ ...line, ts: line.ts + 90, pid: line.pid + 1000 }, ctx)).map((e) => e.id);
    assert.deepEqual(copy, first);
    const later = (await devinAdapter.normalize({ ...line, ts: line.ts + 60_000 }, ctx)).map((e) => e.id);
    assert.notDeepEqual(later, first, "the same payload a minute later is another call");
  });
});

describe("devin install", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  /** The user config under HOME: %APPDATA%\devin (APPDATA unset: HOME\AppData\Roaming) on Windows, ~/.config/devin elsewhere. */
  const userConfig = process.platform === "win32" ? "AppData/Roaming/devin/config.json" : ".config/devin/config.json";
  const entry = (event: string, hookPath = HOOK) => ({ type: "command", command: buildHookCommand(hookPath, "devin", event), timeout: 10 });

  it("adds every event to the user config's hooks and round-trips", async () => {
    assert.equal(devinHookTarget({ scope: "user" }), join(env.home, ...userConfig.split("/")));
    const { installed } = await assertInstallRoundTrip(devinAdapter, env.root);
    const c = JSON.parse(installed[userConfig]!);
    assert.deepEqual(Object.keys(c.hooks), [...DEVIN_HOOK_EVENTS]);
    assert.deepEqual(c.hooks.PostToolUse, [{ matcher: "", hooks: [entry("PostToolUse")] }], 'a tool event matches every tool ("")');
    assert.deepEqual(c.hooks.Stop, [{ hooks: [entry("Stop")] }], "other events take no matcher");
  });

  it("keeps the user's settings, hooks and comments, and uninstall gives the file back", async () => {
    const file = devinHookTarget({ scope: "user" });
    const original = '{\n  // my settings\n  "model": "swe-1.5",\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]\n  }\n}\n';
    writeFile(file, original);
    await devinAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false });
    const text = readFileSync(file, "utf8");
    assert.match(text, /\/\/ my settings/);
    const c = parseJsonc(text) as { model: string; hooks: Record<string, unknown[]> };
    assert.equal(c.model, "swe-1.5");
    assert.deepEqual(c.hooks.Stop, [{ hooks: [{ type: "command", command: "say done" }] }, { hooks: [entry("Stop")] }]);
    const path = process.env.PATH;
    process.env.PATH = join(env.root, "no-bin");
    try {
      assert.equal((await devinAdapter.detect()).hooked, true);
    } finally {
      process.env.PATH = path;
    }
    await devinAdapter.uninstall({ scope: "user", dryRun: false });
    assert.equal(readFileSync(file, "utf8"), original);
  });

  it("follows DEVIN_CONFIG_HOME", async () => {
    process.env.DEVIN_CONFIG_HOME = join(env.home, "xdg");
    try {
      assert.equal(devinHookTarget({ scope: "user" }), join(env.home, "xdg", "devin", "config.json"));
      const { installed } = await assertInstallRoundTrip(devinAdapter, env.root);
      assert.ok(installed["xdg/devin/config.json"]);
    } finally {
      delete process.env.DEVIN_CONFIG_HOME;
    }
  });

  it("project scope writes the git-ignored .devin/config.local.json", async () => {
    const project = join(env.root, "project");
    mkdirSync(project, { recursive: true });
    const { installed } = await assertInstallRoundTrip(devinAdapter, env.root, { scope: "project", projectDir: project });
    assert.deepEqual(
      Object.keys(installed).filter((k) => k.startsWith("project/")),
      ["project/.devin/config.local.json"],
    );
  });

  it("project uninstall takes ours out of every hooks file Devin reads there and leaves the rest", async () => {
    const project = join(env.root, "project2");
    const dir = join(project, ".devin");
    const theirs = { matcher: "exec", hooks: [{ type: "command", command: "./guard.sh" }] };
    // hooks.v1.json is the event map itself; config.json and config.local.json hold it under "hooks".
    writeFile(join(dir, "hooks.v1.json"), JSON.stringify({ PreToolUse: [theirs, { matcher: "", hooks: [entry("PreToolUse")] }], Stop: [{ hooks: [entry("Stop")] }] }, null, 2));
    writeFile(join(dir, "config.json"), JSON.stringify({ model: "swe-1.5", hooks: { SessionStart: [{ hooks: [entry("SessionStart")] }] } }, null, 2));
    writeFile(join(dir, "config.local.json"), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [entry("SessionEnd")] }] } }, null, 2));
    const changes = await devinAdapter.uninstall({ scope: "project", projectDir: project, dryRun: false });
    assert.equal(changes.length, 3);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "hooks.v1.json"), "utf8")), { PreToolUse: [theirs] });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { model: "swe-1.5" });
    assert.equal(existsSync(join(dir, "config.local.json")), false, "a file left empty is removed");
  });
});

describe("devin run", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  const work = (name: string) => {
    const cwd = join(env.root, name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  };

  it("drives `devin -p` and reads the session id and usage from its --export file", async () => {
    const bin = join(env.root, "bin");
    fakeBinary(
      bin,
      "devin",
      `const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("--export") + 1], JSON.stringify({ schema_version: "ATIF-v1.4", session_id: "brave-otter", final_metrics: { total_prompt_tokens: 1200, total_completion_tokens: 80, total_cached_tokens: 1000, total_cost_usd: 0.0123 } }));
console.log("Created hello.py.");`,
    );
    const cwd = work("work");
    const r = await devinAdapter.run!(runSpec(cwd, bin, { model: "swe-1.5" }));
    assertRunOk(r);
    assert.equal(r.sessionId, "brave-otter");
    assert.deepEqual(r.usage, { inputTokens: 200, cacheReadTokens: 1000, outputTokens: 80, costUsd: 0.0123 });
    const { argv } = readArgv(bin, "devin");
    const exported = argv[argv.indexOf("--export") + 1]!;
    assert.deepEqual(argv, ["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "--model", "swe-1.5", "--export", exported, "-p", "--", "fix the bug"]);
    assert.ok(!exported.startsWith(cwd), "the export is written outside the work tree");
    assert.equal(existsSync(exported), false, "and removed after the run");
  });

  it("the bundle's flags replace the defaults; an instruction that starts with - stays the prompt", async () => {
    const bin = join(env.root, "bin2");
    fakeBinary(bin, "devin", `console.log("ok");`);
    const r = await devinAdapter.run!(runSpec(work("work2"), bin, { flags: ["--permission-mode", "auto"], instruction: "-v prints nothing" }));
    assertRunOk(r);
    assert.equal(r.sessionId, undefined, "no export file, no session id");
    const { argv } = readArgv(bin, "devin");
    assert.deepEqual(argv, ["--respect-workspace-trust", "false", "--export", argv[3]!, "--permission-mode", "auto", "-p", "--", "-v prints nothing"]);
  });

  it("stops at the login prompt instead of waiting for the timeout", async () => {
    const bin = join(env.root, "bin3");
    // What `devin -p` printed live with no login (stdout, CR LF lines); then it waits for a key.
    fakeBinary(
      bin,
      "devin",
      `process.stdout.write("\\x1b[?2004h\\x1b[?2026h\\r How would you like to log in?\\r\\n\\r\\n 1 Log in with browser\\r\\n");
setTimeout(() => {}, 60_000);`,
    );
    const t0 = Date.now();
    const r = await devinAdapter.run!(runSpec(work("work3"), bin, { timeoutMs: 45_000 }));
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
    assert.equal(r.timedOut, false);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderrTail, /Devin CLI is not logged in/);
    assert.match(r.stderrTail, /devin auth login/);
    assert.doesNotMatch(r.stderrTail, /aborted/);
  });
});

describe("devinExport", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  const exported = (name: string, text: string) => {
    const p = join(env.root, name);
    writeFile(p, text);
    return devinExport(p);
  };

  it("reads what is there and nothing else", () => {
    assert.deepEqual(devinExport(join(env.root, "missing.json")), {});
    assert.deepEqual(exported("broken.json", "{ not json"), {});
    assert.deepEqual(exported("array.json", "[]"), {});
    assert.deepEqual(exported("id.json", JSON.stringify({ session_id: "brave-otter", final_metrics: {} })), { sessionId: "brave-otter" });
    assert.deepEqual(exported("prompt.json", JSON.stringify({ final_metrics: { total_prompt_tokens: 10 } })), { usage: { inputTokens: 10 } });
    assert.deepEqual(exported("cost.json", JSON.stringify({ final_metrics: { total_cost_usd: 0 } })), { usage: { costUsd: 0 } });
  });

  it("prompt tokens include the cached ones: input never goes below zero", () => {
    assert.deepEqual(exported("cached.json", JSON.stringify({ final_metrics: { total_prompt_tokens: 10, total_cached_tokens: 30 } })), { usage: { inputTokens: 0, cacheReadTokens: 30 } });
  });

  it("a cached count that is not a whole number from 0 to 2^53 - 1 reads as missing, so all the prompt tokens are input", () => {
    for (const [i, cached] of [1000.5, -1000, 2 ** 53].entries()) {
      const metrics = { total_prompt_tokens: 1200, total_completion_tokens: 80, total_cached_tokens: cached, total_cost_usd: 0.0123 };
      const x = exported(`cached-${i}.json`, JSON.stringify({ session_id: "brave-otter", final_metrics: metrics }));
      assert.deepEqual(x.usage, { inputTokens: 1200, outputTokens: 80, costUsd: 0.0123 }, `cached ${cached}`);
    }
  });
});

describe("devin overlay", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("gives the run its bundle's config with our hooks, no other tool's files, its own process and the login", async () => {
    const runDir = join(env.root, "run1", "work");
    const home = join(env.root, "run1", "home");
    mkdirSync(runDir, { recursive: true });
    // The runner wrote the bundle's "~/" files into the run's home; a bundle made on Windows holds %APPDATA%\devin.
    const bundled = { model: "swe-1.5", read_config_from: { claude: true, cursor: true, custom_tool: true }, process_model: "daemon", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFile(join(home, "AppData", "Roaming", "devin", "config.json"), JSON.stringify(bundled));
    writeFile(join(home, "AppData", "Roaming", "devin", "skills", "review", "SKILL.md"), "# review\n");
    // The user's login, where `devin auth login` keeps it.
    writeFile(join(devinConfigDir(), "credentials.toml"), 'token = "placeholder"\n');
    const bundle = { files: { "~/AppData/Roaming/devin/config.json": "a", "~/AppData/Roaming/devin/skills/review/SKILL.md": "b" }, flags: [] };
    const r = await devinAdapter.overlay!(bundle as never, runDir);
    const cfg = join(home, ".config");
    assert.deepEqual(r, { env: { DEVIN_CONFIG_HOME: cfg, DEVIN_SESSIONS_DIR: join(home, "devin-sessions") }, flags: [] });
    const dir = join(cfg, "devin");
    const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(c.model, "swe-1.5");
    assert.deepEqual(c.read_config_from, { claude: false, cursor: false, custom_tool: true, windsurf: false, copilot: false, codex: false, kiro: false, opencode: false, zed: false });
    assert.equal(c.process_model, "in-process");
    assert.deepEqual(Object.keys(c.hooks).sort(), [...DEVIN_HOOK_EVENTS].sort());
    assert.deepEqual(c.hooks.Stop, [{ hooks: [{ type: "command", command: "say done" }] }, { hooks: [{ type: "command", command: buildHookCommand(paths().hook, "devin", "Stop"), timeout: 10 }] }]);
    assert.equal(readFileSync(join(dir, "skills", "review", "SKILL.md"), "utf8"), "# review\n");
    assert.equal(readFileSync(join(dir, "credentials.toml"), "utf8"), 'token = "placeholder"\n');
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(runDir, ".devin")), false, "nothing is written into the work tree");
  });
});
