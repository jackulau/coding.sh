// End-to-end CLI tests against a fresh esbuild bundle (never a stale dist/).
// Every run gets a temp HOME / CODING_SH_HOME and a PATH holding only node's
// directory, so no real agent binary runs and no real config is touched.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";
import { assertStartupBudget } from "../helpers-timing.ts";
import { which } from "../../src/adapters/_shared/detect.ts";
import { hookPathForCommand } from "../../src/adapters/_shared/hooks.ts";
import { pathOf, printBin } from "../_bin.ts";

let distDir = "";
let CLI = "";
let HOOK = "";

before(async () => {
  distDir = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-dist-")));
  const b = await bundle(distDir);
  CLI = b.cli;
  HOOK = b.hook;
});
after(() => rmSync(distDir, { recursive: true, force: true }));

interface Home {
  root: string;
  home: string;
  data: string;
  env: NodeJS.ProcessEnv;
}

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function tmpHome(): Home {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-home-")));
  homes.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const data = join(home, ".coding.sh");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: data,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: dirname(process.execPath),
    TMPDIR: join(root, "tmp"),
    CODING_SH_HOOK_SOURCE: HOOK,
    // Never inherit the developer's agent config locations or color settings.
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    CURSOR_CONFIG_DIR: undefined,
    OPENCODE_CONFIG_DIR: undefined,
    OPENCODE_DB: undefined,
  };
  mkdirSync(env.TMPDIR!);
  return { root, home, data, env };
}

function cli(h: Home, args: string[], extra: NodeJS.ProcessEnv = {}, input?: string): SpawnSyncReturns<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...h.env, ...extra })) if (v !== undefined) env[k] = v;
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd: h.home, encoding: "utf8", timeout: 30_000, ...(input !== undefined ? { input } : {}) });
}

function parseJson(s: string, label: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    assert.fail(`${label}: stdout is not one JSON document:\n${s}`);
  }
}

/** Every file and dir under root, with content for files, to prove nothing changed. */
function snapshot(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const key = relative(root, p);
      if (st.isDirectory()) {
        m.set(key + "/", "");
        walk(p);
      } else m.set(key, `${st.size}:${st.mtimeMs}:${readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return m;
}

const ANSI = /\x1b\[/;

describe("cli help", () => {
  it("prints root help in under 200 ms from the bundle", () => {
    const h = tmpHome();
    // Paired against bare node under the same load (see helpers-timing.ts). A real regression,
    // like the ~300 ms of module compile a monolithic bundle cost, fails on any machine.
    const res = assertStartupBudget("--help", () => cli(h, ["--help"]));
    assert.match(res.stdout, /coding\.sh/);
    assert.match(res.stdout, /init/);
  });

  it("keeps command code out of the entry bundle (code splitting)", () => {
    // Regression: one 1.5 MB cli.mjs cost ~300 ms of module compile on every
    // `--help`, even though commands load through dynamic import().
    const size = lstatSync(CLI).size;
    assert.ok(size < 150_000, `cli.mjs is ${size} bytes; command modules leaked into the entry`);
    assert.ok(readdirSync(dirname(CLI)).some((f) => /^chunk-.*\.mjs$/.test(f)), "command chunks sit next to cli.mjs");
    assert.doesNotMatch(readFileSync(CLI, "utf8"), /node:sqlite/, "the store is not loaded for help");
  });

  it("prints command help and help <cmd> the same way", () => {
    const h = tmpHome();
    const a = cli(h, ["init", "--help"]);
    const b = cli(h, ["help", "init"]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.match(a.stdout, /--dry-run/);
  });

  it("prints the version", () => {
    const h = tmpHome();
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
    const r = cli(h, ["--version"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
    const j = cli(h, ["version", "--json"]);
    assert.equal(j.status, 0, j.stderr);
    assert.equal((parseJson(j.stdout, "version") as { version: string }).version, pkg.version);
  });
});

describe("cli --json", () => {
  const cases: { args: string[]; key?: string }[] = [
    { args: ["version"], key: "version" },
    { args: ["status"] },
    { args: ["sessions"], key: "sessions" },
    { args: ["doctor"], key: "agents" },
    { args: ["config", "get"] },
    { args: ["config", "path"] },
    { args: ["eval", "list"], key: "tasks" },
    { args: ["dataset", "list"] },
    { args: ["exp", "list"], key: "experiments" },
    { args: ["harness", "list"] },
    { args: ["search", "anything"], key: "hits" },
    { args: ["ingest"] },
    { args: ["gc", "--dry-run"], key: "outcome" },
    { args: ["init", "--dry-run", "--agent", "claude-code"], key: "outcome" },
    { args: ["uninstall", "--dry-run"], key: "outcome" },
  ];
  for (const { args, key } of cases) {
    it(`${args.join(" ")} prints one JSON document and exits 0`, () => {
      const h = tmpHome();
      const r = cli(h, [...args, "--json"]);
      assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
      const v = parseJson(r.stdout, args.join(" "));
      assert.ok(v && typeof v === "object", "JSON object");
      if (key) assert.ok(key in (v as object), `has ${key}`);
      assert.doesNotMatch(r.stdout + r.stderr, ANSI);
    });
  }

  it("prints errors as one JSON line on stderr", () => {
    const h = tmpHome();
    const r = cli(h, ["show", "nope", "--json"]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines.length, 1, r.stderr);
    const e = JSON.parse(lines[0]!) as { status: string; reason: string; message: string };
    assert.equal(e.status, "error");
    assert.equal(e.reason, "not_found");
    assert.match(e.message, /nope/);
  });
});

describe("cli exit codes", () => {
  it("0 on success", () => {
    assert.equal(cli(tmpHome(), ["config", "path"]).status, 0);
  });

  it("2 on an unknown command, with a suggestion", () => {
    const r = cli(tmpHome(), ["sesions"]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /sessions/);
  });

  it("2 on an unknown option, with a suggestion", () => {
    const r = cli(tmpHome(), ["sessions", "--limt", "3"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--limit/);
  });

  it("2 on a missing required argument", () => {
    const r = cli(tmpHome(), ["show"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /session/i);
  });

  it("2 on a missing subcommand", () => {
    assert.equal(cli(tmpHome(), ["eval"]).status, 2);
  });

  it("2 when consent is required but stdin is not a terminal", () => {
    const h = tmpHome();
    const r = cli(h, ["init", "--agent", "claude-code", "--json"], {}, "");
    assert.equal(r.status, 2, r.stderr);
    const e = JSON.parse(r.stderr.trim().split("\n").at(-1)!) as { reason: string };
    assert.equal(e.reason, "confirmation_required");
    assert.equal(existsSync(join(h.home, ".claude", "settings.json")), false);
  });

  it("1 on a runtime failure", () => {
    const r = cli(tmpHome(), ["show", "missing-session"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing-session/);
  });

  it("passes through the wrapped command's exit code", () => {
    const r = cli(tmpHome(), ["run", "--", process.execPath, "-e", "process.exit(7)"]);
    assert.equal(r.status, 7, r.stderr);
  });

  it("run of a missing binary says command not found, with no success glyph", () => {
    const r = cli(tmpHome(), ["run", "--", "nonexistent-cmd-xyz"]);
    assert.equal(r.status, 127, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /✗ nonexistent-cmd-xyz: spawn nonexistent-cmd-xyz ENOENT \(command not found\)/);
    assert.doesNotMatch(r.stderr, /✓/);
  });

  it("run --json prints exactly one JSON document; the child's stdout goes to stderr", () => {
    const r = cli(tmpHome(), ["run", "--json", "--", process.execPath, "-e", "console.log('hi')"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = parseJson(r.stdout, "run --json") as { exitCode: number; sessionId: string; error: string | null };
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.error, null);
    assert.equal(typeof doc.sessionId, "string");
    assert.match(r.stderr, /^hi$/m);
  });

  it("run attributes a hookless agent (aider) by command name, anything else to the wrapper", () => {
    const h = tmpHome();
    const bin = join(h.root, "bin");
    printBin(bin, "aider", "");
    const path = { PATH: pathOf(bin, dirname(process.execPath)) };
    assert.equal(cli(h, ["run", "--", "aider", "--message", "hi"], path).status, 0);
    assert.equal(cli(h, ["run", "--", process.execPath, "-e", ""], path).status, 0);
    const spool = join(h.env.CODING_SH_HOME!, "spool");
    assert.deepEqual(readdirSync(spool).filter((d) => !d.includes(".")).sort(), ["aider", "wrapper"]);
  });

  it("run --json of a missing binary reports the error in the document", () => {
    const r = cli(tmpHome(), ["run", "--json", "--", "nonexistent-cmd-xyz"]);
    assert.equal(r.status, 127, r.stderr);
    const doc = parseJson(r.stdout, "run --json") as { exitCode: number; error: string | null };
    assert.equal(doc.exitCode, 127);
    assert.match(String(doc.error), /nonexistent-cmd-xyz: spawn nonexistent-cmd-xyz ENOENT/);
  });
});

describe("cli eval new from a `coding.sh run` session", () => {
  it("drafts a task with --instruction, or from the wrapped command's prompt argument", () => {
    const h = tmpHome();
    const gitBin = which("git") ?? "";
    if (!gitBin) return; // snapshots need git
    const extra = { PATH: pathOf(dirname(process.execPath), dirname(gitBin)), GIT_CONFIG_NOSYSTEM: "1" };
    const repo = join(h.root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "sum.js"), "module.exports = (a, b) => a - b;\n");
    writeFileSync(join(repo, "test.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.env, ...extra })) if (v !== undefined) env[k] = v;
    const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: repo, encoding: "utf8", timeout: 30_000 });
    const fix = 'require("fs").writeFileSync("sum.js","module.exports=(a,b)=>a+b;\\n")';

    assert.equal(run(["run", "--", process.execPath, "-e", fix]).status, 0);
    const bare = run(["eval", "new", "latest", "--verifier", "node test.js", "--json"]);
    assert.equal(bare.status, 1, bare.stdout + bare.stderr);
    assert.match(bare.stdout + bare.stderr, /--instruction/);

    writeFileSync(join(h.root, "prompt.md"), "sum() subtracts; make it add\n");
    const given = run(["eval", "new", "latest", "--verifier", "node test.js", "--instruction", `@${join(h.root, "prompt.md")}`, "--json"]);
    assert.equal(given.status, 0, given.stdout + given.stderr);
    const t = (parseJson(given.stdout, "eval new") as { task: { name: string } }).task;
    assert.equal(t.name, "sum-subtracts-make-it-add");

    git("checkout", "-q", "sum.js");
    assert.equal(run(["run", "--", process.execPath, "-e", fix, "make sum add its arguments"]).status, 0);
    const fromArgs = run(["eval", "new", "latest", "--verifier", "node test.js", "--json"]);
    assert.equal(fromArgs.status, 0, fromArgs.stdout + fromArgs.stderr);
    assert.equal((parseJson(fromArgs.stdout, "eval new") as { task: { name: string } }).task.name, "make-sum-add-its-arguments");
    const validated = run(["eval", "validate", "make-sum-add-its-arguments", "--k", "1", "--json"]);
    const steps = (parseJson(validated.stdout, "eval validate") as { steps: { kind: string; pass: boolean; outputTail: string }[] }).steps;
    assert.ok(steps.some((s) => s.kind === "noop" && !s.pass && typeof s.outputTail === "string"), "--json has each step and its output");

    const bad = run(["eval", "new", "latest", "--instruction", "@nope.md", "--json"]);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);

    // Regression: `eval validate <name>` said "Can't find task" for the name
    // `eval new` had just printed; tasks resolve by id or unique name.
    const out = join(h.root, "export");
    const byName = run(["eval", "export", "make-sum-add-its-arguments", "--out", out, "--json"]);
    assert.equal(byName.status, 0, byName.stdout + byName.stderr);
    assert.ok(existsSync(out));
    const missing = run(["eval", "export", "no-such-task", "--out", join(h.root, "x"), "--json"]);
    assert.equal(missing.status, 1);
    assert.equal((JSON.parse(missing.stderr) as { reason: string }).reason, "not_found");
  });
});

describe("cli color", () => {
  it("FORCE_COLOR colors stderr (control)", () => {
    const r = cli(tmpHome(), ["doctor"], { FORCE_COLOR: "1" });
    assert.match(r.stderr, ANSI);
  });

  it("NO_COLOR wins over FORCE_COLOR", () => {
    for (const args of [["doctor"], ["--help"], ["status"], ["sesions"]]) {
      const r = cli(tmpHome(), args, { NO_COLOR: "1", FORCE_COLOR: "1" });
      assert.doesNotMatch(r.stdout, ANSI, args.join(" "));
      assert.doesNotMatch(r.stderr, ANSI, args.join(" "));
    }
  });

  it("--no-color wins over FORCE_COLOR", () => {
    const r = cli(tmpHome(), ["doctor", "--no-color"], { FORCE_COLOR: "1" });
    assert.doesNotMatch(r.stderr, ANSI);
  });
});

describe("cli --dry-run", () => {
  it("writes nothing", () => {
    const h = tmpHome();
    // An agent config that init would edit, and a store that gc would prune.
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    writeFileSync(join(h.home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }, null, 2) + "\n");
    assert.equal(cli(h, ["status", "--json"]).status, 0);
    const before = snapshot(h.root);
    const runs = [
      ["init", "--dry-run", "--agent", "claude-code"],
      ["init", "--dry-run", "--agent", "claude-code", "--json"],
      ["uninstall", "--dry-run"],
      ["gc", "--dry-run"],
      ["config", "set", "capture.mode", "metadata", "--dry-run"],
    ];
    for (const args of runs) {
      const r = cli(h, args);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    }
    assert.deepEqual(snapshot(h.root), before);
  });

  it("shows the planned edit as a diff", () => {
    const h = tmpHome();
    const r = cli(h, ["init", "--dry-run", "--agent", "claude-code"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /settings\.json/);
    assert.match(r.stdout, /hook\.mjs/);
    assert.equal(existsSync(join(h.home, ".coding.sh")), false);
  });
});

describe("cli init/uninstall round trip", () => {
  it("installs claude-code hooks on a temp HOME and removes them again", () => {
    const h = tmpHome();
    const settings = join(h.home, ".claude", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    const original = { theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    writeFileSync(settings, JSON.stringify(original, null, 2) + "\n");

    const i = cli(h, ["init", "--agent", "claude-code", "--yes", "--json"]);
    assert.equal(i.status, 0, i.stderr);
    const res = parseJson(i.stdout, "init") as { outcome: string; hook: string };
    assert.equal(res.outcome, "installed");
    assert.ok(existsSync(res.hook), "hook bin copied");
    assert.ok(res.hook.startsWith(h.data), "hook bin under CODING_SH_HOME");
    const installed = readFileSync(settings, "utf8");
    assert.ok(installed.includes(hookPathForCommand(res.hook)), "settings point at the hook bin");
    assert.match(installed, /echo mine/);
    assert.ok(existsSync(join(h.data, "config.toml")), "default config written");

    // Second init is a no-op.
    const again = cli(h, ["init", "--agent", "claude-code", "--yes", "--json"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal((parseJson(again.stdout, "init again") as { outcome: string }).outcome, "unchanged");

    const d = cli(h, ["doctor", "--json", "--agent", "claude-code"]);
    const doc = parseJson(d.stdout, "doctor") as { agents: { id: string; hooked: boolean }[] };
    assert.equal(doc.agents.find((a) => a.id === "claude-code")?.hooked, true);

    const u = cli(h, ["uninstall", "--agent", "claude-code", "--yes", "--json"]);
    assert.equal(u.status, 0, u.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), original);

    const u2 = cli(h, ["uninstall", "--agent", "claude-code", "--yes", "--json"]);
    assert.equal(u2.status, 0, u2.stderr);
    assert.equal((parseJson(u2.stdout, "uninstall again") as { outcome: string }).outcome, "unchanged");
  });

  it("captures a hook event end to end", () => {
    const h = tmpHome();
    assert.equal(cli(h, ["init", "--agent", "claude-code", "--yes"]).status, 0);
    const hookBin = join(h.data, "bin", "hook.mjs");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(h.env)) if (v !== undefined) env[k] = v;
    const payload = { session_id: "cli-e2e", hook_event_name: "UserPromptSubmit", prompt: "hello from the cli test", cwd: h.home, transcript_path: join(h.home, "t.jsonl") };
    const hk = spawnSync(process.execPath, [hookBin, "claude-code", "UserPromptSubmit"], { env, input: JSON.stringify(payload), encoding: "utf8" });
    assert.equal(hk.status, 0, hk.stderr);
    const s = cli(h, ["sessions", "--json"]);
    assert.equal(s.status, 0, s.stderr);
    const list = parseJson(s.stdout, "sessions") as { sessions: { id: string }[] };
    assert.ok(list.sessions.some((x) => x.id === "cli-e2e"), s.stdout);
    const show = cli(h, ["show", "cli-e2e"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /hello from the cli test/);
  });

  it("sessions hides sessions with no turn, tool call or model call unless --empty", () => {
    const h = tmpHome();
    assert.equal(cli(h, ["init", "--agent", "claude-code", "--yes"]).status, 0);
    const hookBin = join(h.data, "bin", "hook.mjs");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(h.env)) if (v !== undefined) env[k] = v;
    const hook = (event: string, payload: Record<string, unknown>) => {
      const r = spawnSync(process.execPath, [hookBin, "claude-code", event], { env, input: JSON.stringify({ hook_event_name: event, cwd: h.home, transcript_path: join(h.home, "none.jsonl"), ...payload }), encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    hook("UserPromptSubmit", { session_id: "with-work", prompt: "do the thing" });
    // A process that started and stopped a session and did nothing (newest, so it would fill --limit 1).
    hook("SessionStart", { session_id: "no-work", source: "startup" });
    hook("SessionEnd", { session_id: "no-work", reason: "other" });
    const ids = (...args: string[]) => {
      const r = cli(h, ["sessions", "--json", ...args]);
      assert.equal(r.status, 0, r.stderr);
      return (parseJson(r.stdout, "sessions") as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    };
    assert.deepEqual(ids(), ["with-work"]);
    assert.deepEqual(ids("--limit", "1"), ["with-work"]);
    assert.deepEqual(ids("--empty"), ["no-work", "with-work"]);
  });
});

describe("cli zero setup", () => {
  const MCP_AGENTS = ["claude-code", "codex", "cursor", "opencode", "gemini-cli"];
  const agentArgs = MCP_AGENTS.flatMap((a) => ["--agent", a]);
  const mcpFiles = (h: Home) => ({
    "claude-code": join(h.home, ".claude.json"),
    codex: join(h.home, ".codex", "config.toml"),
    cursor: join(h.home, ".cursor", "mcp.json"),
    opencode: join(h.home, ".config", "opencode", "opencode.json"),
    "gemini-cli": join(h.home, ".gemini", "settings.json"),
  });

  it("no command: init first, then the viewer; help when not interactive", async () => {
    const { defaultCommand } = await import("../../src/cli/main.ts");
    const h = tmpHome();
    assert.equal(defaultCommand(h.env, false), undefined);
    assert.equal(defaultCommand(h.env, true), "init");
    mkdirSync(join(h.data, "bin"), { recursive: true });
    writeFileSync(join(h.data, "bin", "hook.mjs"), "");
    assert.equal(defaultCommand(h.env, true), "ui");
    assert.equal(defaultCommand(h.env, false), undefined);

    // Spawned without a terminal: plain help, nothing written.
    const fresh = tmpHome();
    const before = snapshot(fresh.root);
    const r = cli(fresh, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<command>/);
    assert.deepEqual(snapshot(fresh.root), before);
    assert.equal(cli(fresh, ["--help"]).stdout, r.stdout, "--help stays help");
  });

  it("lists mcp under Explore and update under Maintain", () => {
    const r = cli(tmpHome(), ["--help"]);
    const section = (name: string) => r.stdout.split(/\n(?=\S)/).find((s) => s.startsWith(name)) ?? "";
    assert.match(section("Explore"), /^\s+mcp\s/m);
    assert.match(section("Maintain"), /^\s+update\s/m);
    assert.equal(cli(tmpHome(), ["mcp", "--help"]).status, 0);
    assert.match(cli(tmpHome(), ["update", "--help"]).stdout, /--check/);
  });

  it("init plans hooks and the MCP server for every MCP agent in one plan; --no-mcp opts out", () => {
    const h = tmpHome();
    const r = cli(h, ["init", "--dry-run", "--json", ...agentArgs]);
    assert.equal(r.status, 0, r.stderr);
    const plan = parseJson(r.stdout, "init plan") as { mcpServer: { name: string; args: string[] }; agents: { id: string; changes: unknown[]; mcp: { error: string | null; changes: { path: string; after: string }[] } | null }[] };
    assert.equal(plan.mcpServer.name, "coding-sh");
    // INS-7: the stable launcher, not the bundle path that ran init (npx cache, nvm dir).
    assert.equal((plan.mcpServer as { command?: string }).command, "node");
    assert.deepEqual(plan.mcpServer.args, [join(h.data, "bin", "mcp.mjs")], "launches the stable ~/.coding.sh launcher");
    const files = mcpFiles(h);
    for (const id of MCP_AGENTS) {
      const a = plan.agents.find((x) => x.id === id)!;
      assert.ok(a.changes.length >= 1, `${id} hooks planned`);
      assert.equal(a.mcp?.error, null, id);
      assert.equal(a.mcp?.changes[0]?.path, files[id as keyof typeof files], `${id} MCP config`);
      assert.match(a.mcp!.changes[0]!.after, /coding-sh/);
    }
    const no = parseJson(cli(h, ["init", "--dry-run", "--json", "--no-mcp", ...agentArgs]).stdout, "no-mcp") as { mcpServer: unknown; agents: { mcp: unknown }[] };
    assert.equal(no.mcpServer, null);
    assert.ok(no.agents.every((a) => a.mcp === null));
    assert.equal(existsSync(h.data), false, "dry run wrote nothing");
  });

  it("init ends in three lines, and uninstall restores every MCP config byte-for-byte", () => {
    const h = tmpHome();
    const files = mcpFiles(h);
    const originals: Record<string, string> = {
      "claude-code": '{\n  "numStartups": 3,\n  "projects": {}\n}\n',
      codex: '# mine\nmodel = "gpt-5"  # pinned\n\n[mcp_servers.docs]\ncommand = "docs"\n',
      cursor: '{"mcpServers": {"foo": {"command": "foo", "args": ["a", "b"]}}}',
      "gemini-cli": '{\n  "theme": "GitHub"\n}\n',
    };
    for (const [id, text] of Object.entries(originals)) {
      const f = files[id as keyof typeof files];
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const i = cli(h, ["init", "--yes", ...agentArgs]);
    assert.equal(i.status, 0, i.stderr);
    const tail = i.stderr.trimEnd().split("\n").slice(-5);
    assert.match(tail[0]!, /Set up Claude Code.*\(hooks \+ MCP server\)/);
    // Agents load hooks at session start: say capture begins with the next session.
    assert.match(tail[1]!, /Recording starts with the next session: start a new session of any of them\. Sessions already open may not have loaded the hooks$/);
    assert.match(tail[2]!, /Open the viewer: coding\.sh ui$/);
    assert.match(tail[3]!, /After a few sessions, see what to fix first: coding\.sh improve$/);
    assert.match(tail[4]!, /Docs: https:\/\/coding\.sh\/docs$/);
    for (const f of Object.values(files)) assert.match(readFileSync(f, "utf8"), /coding-sh/, f);
    assert.equal(readFileSync(join(h.data, "bin", "cli-path"), "utf8"), `${CLI}\n`, "hook knows the CLI for background ingests");

    // Started with npx (npm sets npm_command=exec), `coding.sh` is not on PATH: the next steps say npx.
    const npx = cli(h, ["init", "--yes", ...agentArgs], { npm_command: "exec" }).stderr;
    assert.match(npx, /Open the viewer: npx coding\.sh ui$/m);
    assert.match(npx, /see what to fix first: npx coding\.sh improve$/m);

    const again = cli(h, ["init", "--yes", "--json", ...agentArgs]);
    assert.equal((parseJson(again.stdout, "init again") as { outcome: string }).outcome, "unchanged", again.stderr);
    // Nothing new hooked: no "start a new session" note.
    assert.doesNotMatch(cli(h, ["init", "--yes", ...agentArgs]).stderr, /Recording starts/);

    const u = cli(h, ["uninstall", "--yes"]);
    assert.equal(u.status, 0, u.stderr);
    for (const [id, text] of Object.entries(originals)) assert.equal(readFileSync(files[id as keyof typeof files], "utf8"), text, id);
    assert.equal(existsSync(files.opencode), false, "created file removed");
    const dry = parseJson(cli(h, ["uninstall", "--dry-run", "--json"]).stdout, "uninstall again") as { agents: { changes: unknown[] }[] };
    assert.ok(dry.agents.every((a) => a.changes.length === 0), "nothing left");
  });

  it("captured sessions show up without running ingest: the hook ingests in the background at session end", async () => {
    const h = tmpHome();
    assert.equal(cli(h, ["init", "--agent", "claude-code", "--yes"]).status, 0);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(h.env)) if (v !== undefined) env[k] = v;
    for (const event of ["UserPromptSubmit", "Stop"]) {
      const payload = { session_id: "bg-ingest", hook_event_name: event, prompt: "background please", cwd: h.home };
      const hk = spawnSync(process.execPath, [join(h.data, "bin", "hook.mjs"), "claude-code", event], { env, input: JSON.stringify(payload), encoding: "utf8" });
      assert.equal(hk.status, 0, hk.stderr);
    }
    // Read the index directly (no lazy ingest) until the detached ingest lands.
    const { openContext } = await import("../../src/core/context.ts");
    let found = false;
    for (let i = 0; i < 100 && !found; i++) {
      if (existsSync(join(h.data, "index.db")) && !existsSync(join(h.data, "spool", ".ingest.lock"))) {
        const ctx = await openContext({ env: h.env, cwd: h.home });
        try {
          found = (await ctx.index.listSessions({ limit: 10 })).some((s) => s.id === "bg-ingest");
        } finally {
          await ctx.close();
        }
      }
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(found, "session indexed by the background ingest");
    const r = parseJson(cli(h, ["ingest", "--json"]).stdout, "ingest") as { spool: { lines: number } };
    assert.equal(r.spool.lines, 0, "nothing left for a manual ingest");
  });

  it("ingest --backfill ends with its summary rows, not a bare event count", () => {
    // Regression: after the Spool and Backfill rows it printed a lone number (e.g. `677671`) to stdout.
    const h = tmpHome();
    const r = cli(h, ["ingest", "--backfill"], { CODING_SH_NO_AUTO_INGEST: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Spool\s+0 events/);
    assert.match(r.stderr, /Backfill\s+0 events/);
    assert.equal(r.stdout, "");
  });

  it("ingest --background skips quietly while another ingest holds the lock", async () => {
    const h = tmpHome();
    assert.equal(cli(h, ["init", "--agent", "claude-code", "--yes"]).status, 0);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.env, CODING_SH_NO_AUTO_INGEST: "1" })) if (v !== undefined) env[k] = v;
    const payload = { session_id: "locked", hook_event_name: "Stop", cwd: h.home };
    spawnSync(process.execPath, [join(h.data, "bin", "hook.mjs"), "claude-code", "Stop"], { env, input: JSON.stringify(payload), encoding: "utf8" });

    const { acquireLock } = await import("../../src/core/lock.ts");
    const lock = await acquireLock(join(h.data, "spool", ".ingest.lock"));
    try {
      const busy = cli(h, ["ingest", "--background", "--json"]);
      assert.equal(busy.status, 0, busy.stderr);
      assert.deepEqual(parseJson(busy.stdout, "busy"), { outcome: "busy" });
    } finally {
      lock.release();
    }
    const first = parseJson(cli(h, ["ingest", "--background", "--json"]).stdout, "first") as { spool: { lines: number } };
    const second = parseJson(cli(h, ["ingest", "--background", "--json"]).stdout, "second") as { spool: { lines: number } };
    assert.equal(first.spool.lines, 1, "the skipped lines are still there");
    assert.equal(second.spool.lines, 0, "and are ingested exactly once");
  });

  it("a read during a re-parse doesn't wait for the ingest lock and leaves the wake marker for it", async () => {
    const h = tmpHome();
    assert.equal(cli(h, ["init", "--agent", "claude-code", "--yes"]).status, 0);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.env, CODING_SH_NO_AUTO_INGEST: "1" })) if (v !== undefined) env[k] = v;
    const payload = { session_id: "waiting", hook_event_name: "Stop", cwd: h.home };
    spawnSync(process.execPath, [join(h.data, "bin", "hook.mjs"), "claude-code", "Stop"], { env, input: JSON.stringify(payload), encoding: "utf8" });
    const marker = join(h.data, "spool", ".ingest.pending");
    rmSync(marker, { force: true });

    const { acquireLock } = await import("../../src/core/lock.ts");
    const reparse = await acquireLock(join(h.data, "reparse.lock"));
    const ingest = await acquireLock(join(h.data, "spool", ".ingest.lock"));
    try {
      const r = cli(h, ["sessions", "--json"], { CODING_SH_NO_AUTO_INGEST: "1" });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(marker), "the re-parse ingests the waiting line between its lock holds");
    } finally {
      ingest.release();
      reparse.release();
    }
  });
});

describe("cli ingest re-parse", () => {
  interface Reparse { sessions: number; reparsed: number; kept: number; removed: number; inserted: number; errors: unknown[] }
  const fixtures = join(import.meta.dirname, "..", "fixtures", "adapters", "pi", "real");

  it("re-parses sessions an older parse stored, automatically and with --rebuild --agent", async () => {
    const h = tmpHome();
    // A real Pi session: its transcript under ~/.pi and the extension's spool lines.
    cpSync(join(fixtures, "home", ".pi"), join(h.home, ".pi"), { recursive: true });
    const spool = join(h.data, "spool", "pi");
    mkdirSync(spool, { recursive: true });
    const lines = readFileSync(join(fixtures, "extension.spool.jsonl"), "utf8").split("${FIXTURES}/pi/real/home").join(JSON.stringify(h.home).slice(1, -1));
    writeFileSync(join(spool, "2026-11-07.1.jsonl"), lines);
    const first = cli(h, ["ingest", "--backfill", "--agent", "pi", "--json"]);
    assert.equal(first.status, 0, first.stderr);

    const { loadSqlite } = await import("../../src/store/sqlite.ts");
    const { DatabaseSync } = await loadSqlite();
    const db = (fn: (d: InstanceType<typeof DatabaseSync>) => unknown) => {
      const d = new DatabaseSync(join(h.data, "index.db"));
      try {
        return fn(d);
      } finally {
        d.close();
      }
    };
    const rows = () => db((d) => d.prepare("SELECT id, parse_version AS v, stats FROM sessions WHERE agent = 'pi' ORDER BY id").all()) as { id: string; v: number; stats: string }[];
    const fresh = rows();
    assert.ok(fresh.length >= 1);
    assert.ok(fresh.every((r) => r.v === 2), "ingest stamps the adapter's parse version");
    // As a 0.1.1 index looks after the upgrade: version 1 rows, no stamp for the new versions.
    db((d) => d.exec("UPDATE sessions SET parse_version = 1; DELETE FROM cursors WHERE source = 'reparse:stamp'"));

    const auto = cli(h, ["ingest", "--json"]);
    assert.equal(auto.status, 0, auto.stderr);
    const a = (parseJson(auto.stdout, "auto") as { outcome: string; reparse: Reparse }).reparse;
    assert.equal(a.reparsed, fresh.length, "the next ingest re-parses them");
    assert.deepEqual(a.errors, []);
    assert.deepEqual(rows(), fresh, "same rows and counts as a fresh v2 ingest");

    const human = cli(h, ["ingest", "--rebuild", "--agent", "pi"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout + human.stderr, new RegExp(`Re-parsed\\s+${fresh.length} session`));
    assert.match(human.stdout + human.stderr, /Kept\s+0 sessions without a source/);
    const again = cli(h, ["ingest", "--rebuild", "--agent", "pi", "--json"]);
    assert.equal(again.status, 0, again.stderr);
    const out = parseJson(again.stdout, "rebuild") as { outcome: string; reparse: Reparse };
    assert.equal(out.outcome, "rebuilt");
    assert.deepEqual([out.reparse.reparsed, out.reparse.kept, out.reparse.removed, out.reparse.inserted], [fresh.length, 0, 0, 0], "idempotent");
    assert.deepEqual(rows(), fresh);

    const none = cli(h, ["ingest", "--rebuild", "--agent", "codex", "--json"]);
    assert.equal((parseJson(none.stdout, "codex") as { reparse: Reparse }).reparse.sessions, 0);
  });
});

describe("cli exp run", () => {
  it("runs a one-string command task, stores its judge, and fails when every case errors", () => {
    const h = tmpHome();
    const add = cli(h, ["dataset", "add", "arith", "--case", '{"input":"4","expected":"4"}', "--case", '{"input":"5","expected":"5"}', "--split", "test"]);
    assert.equal(add.status, 0, add.stderr);
    writeFileSync(join(h.home, "echo.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n');
    const judge = '{"kind":"llm","name":"correct","rubric":"right?","provider":"mock","tunedOn":["dev"]}';

    // The --help form {"command":"…"} as one string works (QA: was ENOENT on "node echo.mjs").
    const ok = cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", '{"kind":"exact"}', "-g", judge, "--json"]);
    assert.equal(ok.status, 0, ok.stderr);
    const exp = (parseJson(ok.stdout, "exp run") as { experiment: { id: string; summary: { errors: number; passed: number } } }).experiment;
    assert.equal(exp.summary.errors, 0);
    assert.equal(exp.summary.passed, 2);

    // The judge version was stored, so calibrate knows its tuning splits without --tuned-on.
    const cal = cli(h, ["judge", "calibrate", exp.id, "--json"]);
    assert.doesNotMatch(cal.stderr, /is not stored/);
    assert.notEqual(cal.status, 2, cal.stderr);
    assert.equal((parseJson(cal.stdout, "judge calibrate") as { outcome: string }).outcome, "updated");

    // Regression (E2E): `exp compare <name> <name>` said "Can't find experiment"
    // for names given with --name; a name resolves to its newest experiment.
    for (const name of ["v1", "v2", "v2"]) assert.equal(cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", '{"kind":"exact"}', "--name", name]).status, 0);
    const cmp = cli(h, ["exp", "compare", "v1", "v2", "--json"]);
    assert.equal(cmp.status, 0, cmp.stderr);
    const newest = (parseJson(cli(h, ["exp", "list", "--json"]).stdout, "exp list") as { experiments: { id: string; name: string }[] }).experiments.find((e) => e.name === "v2")!;
    assert.ok(cmp.stdout.includes(newest.id), "v2 means the newest run named v2");

    // Every case erroring is not a result: non-zero exit.
    const bad = cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"no-such-agent --flag"}', "-g", '{"kind":"exact"}']);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /errors {2}2 task error\(s\)/);
  });

  it("stores an llm-checklist judge and calibrates it like a kind-llm judge", async () => {
    // QA: checklists were never stored by exp run and `judge calibrate` only looked for kind "llm":
    // "Experiment has no LLM judge grader", then "is not stored ... Pass --tuned-on", and nothing saved.
    const h = tmpHome();
    const add = cli(h, ["dataset", "add", "arith", "--case", '{"input":"4","expected":"4"}', "--case", '{"input":"5","expected":"5"}', "--split", "test"]);
    assert.equal(add.status, 0, add.stderr);
    writeFileSync(join(h.home, "echo.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n');
    const checklist = '{"kind":"llm-checklist","name":"cl","provider":"mock","tunedOn":["dev"],"items":[{"id":"num","question":"Is the answer correct?"}]}';
    const ok = cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", '{"kind":"exact"}', "-g", checklist, "--json"]);
    assert.equal(ok.status, 0, ok.stderr);
    const exp = (parseJson(ok.stdout, "exp run") as { experiment: { id: string; graders: { id: string; version: string }[] } }).experiment;
    const version = exp.graders.find((g) => g.id === "cl")?.version;
    assert.ok(version);

    // Auto-detected (no --grader) and stored (no --tuned-on).
    const cal = cli(h, ["judge", "calibrate", exp.id, "--json"]);
    assert.doesNotMatch(cal.stderr, /no LLM judge grader|is not stored/);
    assert.notEqual(cal.status, 2, cal.stderr);
    const report = parseJson(cal.stdout, "judge calibrate") as { outcome: string; calibration: { status: unknown } };
    assert.equal(report.outcome, "updated");

    const { openContext } = await import("../../src/core/context.ts");
    const { FileEvalStore } = await import("../../src/datasets/store.ts");
    const ctx = await openContext({ env: h.env, cwd: h.home });
    try {
      const stored = await new FileEvalStore({ env: h.env, index: ctx.index }).getJudge(version);
      assert.ok(stored, "exp run stored the checklist version");
      assert.equal((stored as { kind?: string }).kind, "llm-checklist");
      assert.deepEqual(stored.tunedOn, ["dev"]);
      assert.deepEqual(stored.calibration, report.calibration.status, "calibrate saved its result");
    } finally {
      await ctx.close();
    }
  });
});

describe("cli judge calibrate --probe-injection", () => {
  it("re-judges human-fail cases with a planted payload and reports the flips in --json", async () => {
    const h = tmpHome();
    assert.equal(cli(h, ["dataset", "add", "arith", "--case", '{"input":"4","expected":"4"}', "--case", '{"input":"5","expected":"5"}', "--split", "test"]).status, 0);
    writeFileSync(join(h.home, "echo.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n');
    const judge = '{"kind":"llm","name":"correct","rubric":"right?","provider":"mock","mockAnswer":"no","tunedOn":["dev"]}';
    const ok = cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", judge, "--json"]);
    assert.equal(ok.status, 0, ok.stderr);
    const exp = (parseJson(ok.stdout, "exp run") as { experiment: { id: string; runs: { caseId: string }[] } }).experiment;

    const { openContext } = await import("../../src/core/context.ts");
    const ctx = await openContext({ env: h.env, cwd: h.home });
    try {
      for (const [i, r] of exp.runs.entries()) await ctx.index.putLabel({ id: `l${i}`, sessionId: r.caseId, criterion: "correct", value: "fail", by: "me", ts: i + 1 });
    } finally {
      await ctx.close();
    }
    const cal = cli(h, ["judge", "calibrate", exp.id, "--probe-injection", judge, "--json"]);
    assert.notEqual(cal.status, 2, cal.stderr);
    const inj = (parseJson(cal.stdout, "judge calibrate") as { calibration: { injection: { cases: number; n: number; flips: number; skipped: { noTrace: number } } } }).calibration.injection;
    assert.deepEqual([inj.cases, inj.n, inj.flips, inj.skipped.noTrace], [2, 2, 0, 2], "one output variant per case; stored runs keep no trace");

    const bad = cli(h, ["judge", "calibrate", exp.id, "--probe-injection", '{"kind":"exact"}', "--json"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr + bad.stdout, /grader spec/);
  });
});

describe("cli judge sample → judge calibrate --plan", () => {
  it("writes a seeded stratified plan, and calibrate reads the human-audited pass rate from its labelled picks", () => {
    const h = tmpHome();
    const cases = Array.from({ length: 12 }, (_, i) => ["--case", `{"id":"k${i}","input":"${i}","expected":"${i}"}`]).flat();
    assert.equal(cli(h, ["dataset", "add", "arith", ...cases, "--split", "test"]).status, 0);
    writeFileSync(join(h.home, "echo.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n');
    const judge = '{"kind":"llm","name":"correct","rubric":"right?","provider":"mock","tunedOn":["dev"]}';
    const ok = cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", judge, "--json"]);
    assert.equal(ok.status, 0, ok.stderr);
    const exp = (parseJson(ok.stdout, "exp run") as { experiment: { id: string } }).experiment;

    const missing = cli(h, ["judge", "sample", exp.id]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--budget/);

    type Plan = { seed: number; split: string; experimentId: string; picks: { caseId: string; stratum: string }[]; strata: { key: string; N: number; n: number }[] };
    const s = cli(h, ["judge", "sample", exp.id, "--budget", "4", "--seed", "3", "--out", "plan.json", "--json"]);
    assert.equal(s.status, 0, s.stderr);
    const plan = (parseJson(s.stdout, "judge sample") as { plan: Plan }).plan;
    assert.deepEqual([plan.seed, plan.split, plan.experimentId], [3, "test", exp.id]);
    assert.equal(plan.picks.length, 4);
    assert.deepEqual(
      plan.strata.map((x) => [x.N, x.n]),
      [[12, 4]],
    );
    assert.ok(plan.picks.every((p) => /^k\d+$/.test(p.caseId)));
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, "plan.json"), "utf8")), plan);
    assert.deepEqual((parseJson(cli(h, ["judge", "sample", exp.id, "--budget", "4", "--seed", "3", "--json"]).stdout, "again") as { plan: Plan }).plan, plan, "seeded");
    const text = cli(h, ["judge", "sample", exp.id, "--budget", "4", "--seed", "3", "--out", "plan.json"]);
    assert.match(text.stdout, /audit plan correct {2}split test {2}4 of 12 cases \(seed 3\); 0 of 4 already labelled/);
    assert.match(text.stdout, /Then: coding\.sh judge calibrate .* --grader correct --plan plan\.json/);

    // Three of four picks labelled: 2 pass, 1 fail.
    const labels = plan.picks.slice(0, 3).map((p, i) => JSON.stringify({ caseId: p.caseId, value: i < 2 ? "pass" : "fail" }));
    writeFileSync(join(h.home, "labels.jsonl"), labels.join("\n") + "\n");
    const cal = cli(h, ["judge", "calibrate", exp.id, "--labels", "labels.jsonl", "--plan", "plan.json", "--json"]);
    assert.notEqual(cal.status, 2, cal.stderr);
    const audited = (parseJson(cal.stdout, "calibrate --plan") as { calibration: { audited: { p: number; labelled: number; picks: number; coverage: number; bounds: { lo: number; hi: number } } } }).calibration.audited;
    assert.deepEqual([audited.labelled, audited.picks, audited.coverage], [3, 4, 0.75]);
    assert.ok(Math.abs(audited.p - 2 / 3) < 1e-12);
    assert.deepEqual(audited.bounds, { lo: 0.5, hi: 0.75 });
    const plain = cli(h, ["judge", "calibrate", exp.id, "--labels", "labels.jsonl", "--plan", "plan.json"]);
    assert.match(plain.stdout, /human-audited pass rate 0\.67 \[\d\.\d\d, \d\.\d\d\] \(3\/4 of plan labelled; worst case ±\d\.\d\d\)/);

    // A plan from another split or seed is refused.
    assert.equal(cli(h, ["judge", "calibrate", exp.id, "--plan", "plan.json", "--split", "dev"]).status, 2);
    const seed = cli(h, ["judge", "calibrate", exp.id, "--plan", "plan.json", "--seed", "4"]);
    assert.equal(seed.status, 2);
    assert.match(seed.stderr, /does not match the plan's seed 3/);
  });
});

describe("cli exp run --series → exp plateau", () => {
  it("tags each round, prints the stopping status, and exits 0 continue, 3 stop, 2 too few", () => {
    const h = tmpHome();
    const cases = Array.from({ length: 12 }, (_, i) => ["--case", `{"id":"k${i + 1}","input":"${i + 1}","expected":"${i + 1}"}`]).flat();
    assert.equal(cli(h, ["dataset", "add", "loop", ...cases]).status, 0);
    // The agent echoes its input unless the case number is listed in fail.json.
    writeFileSync(
      join(h.home, "agent.mjs"),
      'import{readFileSync}from"node:fs";let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const f=JSON.parse(readFileSync("fail.json","utf8"));process.stdout.write(f.includes(Number(s.replace(/[^0-9]/g,"")))?"x":s)});\n',
    );
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    const run = (v: number, pass: number[], extra: string[] = []) => {
      writeFileSync(join(h.home, "fail.json"), JSON.stringify(all.filter((x) => !pass.includes(x))));
      return cli(h, ["exp", "run", "-d", "loop", "--task", '{"kind":"command","command":"node agent.mjs"}', "-g", '{"kind":"exact"}', "--name", `v${v}`, "--series", "loop", ...extra]);
    };
    type Plateau = { status: string; recommend?: { id: string; version: number }; incumbent: { id: string } };
    const first = run(0, [], ["--json"]);
    assert.equal(first.status, 0, first.stderr);
    const v0 = parseJson(first.stdout, "v0") as { experiment: { id: string; metadata: { series: string } }; plateau: Plateau };
    assert.equal(v0.experiment.metadata.series, "loop");
    assert.equal(v0.plateau.status, "insufficient");
    assert.equal(cli(h, ["exp", "plateau", "--series", "loop"]).status, 2);

    const second = run(1, [1, 2, 3]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /series loop: continue, incumbent v1 exp_\w+ \(round 1 \+25\.0pp, 12 cases, kept\)/);
    assert.equal(cli(h, ["exp", "plateau", "--series", "loop"]).status, 0);

    const v2 = (parseJson(run(2, [1, 2, 3, 4, 5, 6], ["--json"]).stdout, "v2") as { experiment: { id: string } }).experiment;
    // Each later candidate breaks 2 of v2's 6 passes: the loop stopped helping at round 3.
    for (let k = 0; k < 3; k++) assert.equal(run(3 + k, [1, 2, 3, 4, 5, 6].filter((x) => x !== 1 + k && x !== 2 + k)).status, 0);
    const last = run(6, [3, 4, 5, 6]);
    assert.match(last.stderr, new RegExp(`series loop: stop, ship v2 ${v2.id} \\(version 2; the plateau began at round 3\\)`));

    const stop = cli(h, ["exp", "plateau", "--series", "loop", "--json"]);
    assert.equal(stop.status, 3, stop.stderr);
    const p = (parseJson(stop.stdout, "plateau") as { series: string; plateau: Plateau }).plateau;
    assert.deepEqual([p.status, p.recommend?.id, p.recommend?.version], ["stop", v2.id, 2]);
    const text = cli(h, ["exp", "plateau", "--series", "loop"]);
    assert.match(text.stdout, /plateau loop {2}7 versions, gate greedy, ε 0\.05, δ 0\.05, bet agrapa/);
    assert.match(text.stdout, new RegExp(`ship v2 ${v2.id} \\(version 2, the incumbent before the plateau\\)`));
    // By name, in loop order; --baseline drops the earlier rounds.
    assert.equal(cli(h, ["exp", "plateau", "v0", "v1"]).status, 0);
    assert.equal(cli(h, ["exp", "plateau", "--series", "loop", "--baseline", "v2"]).status, 3, "from v2 every round is a loss");
    assert.equal(cli(h, ["exp", "plateau"]).status, 2);
    assert.equal(cli(h, ["exp", "plateau", "--series", "loop", "--eps", "2"]).status, 2);
    assert.equal(run(7, [], ["--arm", "a={}", "--arm", "b={}"]).status, 2);
  });
});

describe("cli judge calibrate --grader <verifier>", () => {
  it("samples passes to label, audits precision from a labels file, and compare/show use the stored audit", () => {
    const h = tmpHome();
    const cases = ["1", "2", "3", "4", "5"].flatMap((n) => ["--case", `{"input":"${n}","expected":"${n}"}`]);
    assert.equal(cli(h, ["dataset", "add", "arith", ...cases]).status, 0);
    writeFileSync(join(h.home, "echo.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n');
    const run = () => cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", '{"kind":"exact"}', "--json"]);
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    const exp = (parseJson(ok.stdout, "exp run") as { experiment: { id: string } }).experiment;

    // No LLM judge: the error names the graders that can be audited.
    const none = cli(h, ["judge", "calibrate", exp.id]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /audit a verifier's precision \(exact\)/);

    const q = cli(h, ["judge", "calibrate", exp.id, "--grader", "exact", "--sample-passes", "3", "--json"]);
    assert.equal(q.status, 0, q.stderr);
    const queue = (parseJson(q.stdout, "sample") as { queue: { caseId: string; output: unknown }[] }).queue;
    assert.equal(queue.length, 3);
    assert.deepEqual((parseJson(cli(h, ["judge", "calibrate", exp.id, "-g", "exact", "--sample-passes", "3", "--json"]).stdout, "again") as { queue: unknown }).queue, queue, "seeded");
    const plain = cli(h, ["judge", "calibrate", exp.id, "-g", "exact", "--sample-passes", "3"]);
    assert.match(plain.stdout, /Label 3 passing case\(s\) of exact \(seed 0\)/);

    const labels = queue.map((x, i) => JSON.stringify({ caseId: x.caseId, value: i < 2 ? "pass" : "fail" })).join("\n");
    writeFileSync(join(h.home, "labels.jsonl"), labels + "\n");
    const audit = cli(h, ["judge", "calibrate", exp.id, "-g", "exact", "--labels", "labels.jsonl", "--min-n", "3", "--json"]);
    assert.equal(audit.status, 0, audit.stderr);
    const v = (parseJson(audit.stdout, "audit") as { outcome: string; verifier: { precision: number; passes: number; falseAccepts: number; checked: number; agree: number; source: string } }).verifier;
    assert.deepEqual([v.passes, v.falseAccepts, v.checked, v.agree, v.source], [3, 1, 3, 2, "human"]);
    assert.ok(Math.abs(v.precision - 2 / 3) < 1e-12);
    assert.equal(cli(h, ["judge", "calibrate", exp.id, "-g", "exact", "--labels", "labels.jsonl"]).status, 1, "3 labelled passes is below the default 20");
    assert.equal(cli(h, ["judge", "calibrate", exp.id, "-g", "exact", "--probe-injection", "{}"]).status, 2);

    const show = parseJson(cli(h, ["exp", "show", exp.id, "--json"]).stdout, "show") as { verifiers: { graderId: string; passes: number }[] };
    assert.deepEqual(show.verifiers.map((x) => [x.graderId, x.passes]), [["exact", 3]]);
    const second = (parseJson(run().stdout, "exp run 2") as { experiment: { id: string } }).experiment;
    const cmp = cli(h, ["exp", "compare", exp.id, second.id]);
    assert.equal(cmp.status, 0, cmp.stderr);
    assert.match(cmp.stdout, /exact verifier-corrected pass {2}A 66\.7% .*\(precision 0\.67, n=3\)/);
  });
});

describe("cli QA regressions", () => {
  it("registers workflows (and its aliases) with help for every action", () => {
    const h = tmpHome();
    for (const name of ["workflows", "workflow", "wf"]) {
      const r = cli(h, [name, "--help"]);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.match(r.stdout, /coding\.sh workflows <action>/);
    }
    const root = cli(h, ["--help"]);
    const evaluate = root.stdout.split(/\n(?=\S)/).find((s) => s.startsWith("Evaluate")) ?? "";
    assert.match(evaluate, /^\s+workflows\s/m);
    for (const action of ["list", "import", "show", "stats", "score", "run", "compare", "replay"]) {
      const r = cli(h, ["workflows", action, "--help", "--json"]);
      assert.equal(r.status, 0, `${action}: ${r.stderr}`);
      assert.equal((parseJson(r.stdout, action) as { command: { name: string } }).command.name, `workflows ${action}`);
    }
    const list = cli(h, ["wf", "list", "--json"]);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(parseJson(list.stdout, "wf list"), { runs: [] });
  });

  it("config set/get round-trip update.check", () => {
    const h = tmpHome();
    const s = cli(h, ["config", "set", "update.check", "false"]);
    assert.equal(s.status, 0, s.stderr);
    assert.match(readFileSync(join(h.data, "config.toml"), "utf8"), /\[update\]\ncheck = false/);
    const g = cli(h, ["config", "get", "update.check"]);
    assert.equal(g.status, 0, g.stderr);
    assert.equal(g.stdout, "false\n");
    const all = parseJson(cli(h, ["config", "get", "--json"]).stdout, "config get") as { config: { update: { check: boolean } } };
    assert.deepEqual(all.config.update, { check: false });
    assert.match(cli(h, ["config", "get"]).stdout, /\[update\]\ncheck = false/);
    const bad = cli(h, ["config", "set", "update.check", "maybe"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /update\.check must be true or false/);
    // The update notifier's own reader agrees with the CLI.
    return import("../../src/update/index.ts").then(({ updateChecksDisabled }) => assert.equal(updateChecksDisabled(h.env), "config"));
  });

  it("suggests global flags for typos", () => {
    const h = tmpHome();
    for (const [args, want] of [
      [["sessions", "--jsn"], "--json"],
      [["sessions", "--no-colr"], "--no-color"],
      [["sessions", "--debgu"], "--debug"],
      [["status", "--jason"], "--json"],
      [["sessions", "--hlep"], "--help"],
      [["sessions", "--limt", "3"], "--limit"],
      [["--jsn"], "--json"],
      [["--verison"], "--version"],
    ] as const) {
      const r = cli(h, [...args]);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, new RegExp(`Did you mean ${want}\\?`), `${args.join(" ")}: ${r.stderr}`);
    }
  });

  it("range-checks --port on doctor and ui as a usage error", () => {
    const h = tmpHome();
    for (const args of [["doctor", "--port", "99999"], ["ui", "--port", "-5", "--no-open"], ["collector", "--port", "99999"]]) {
      const r = cli(h, args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /--port must be 0-65535, got -?\d+/);
      const j = cli(h, [...args, "--json"]);
      assert.equal(j.status, 2);
      assert.equal((JSON.parse(j.stderr) as { reason: string }).reason, "invalid_usage");
    }
  });

  it("harness snapshot --dir must be an existing directory", () => {
    const h = tmpHome();
    const missing = join(h.root, "nope");
    const r = cli(h, ["harness", "snapshot", "-a", "claude-code", "--dir", missing]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`Can't find directory ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const file = join(h.root, "file.txt");
    writeFileSync(file, "x");
    assert.equal(cli(h, ["harness", "snapshot", "-a", "claude-code", "--dir", file]).status, 1);
    const list = parseJson(cli(h, ["harness", "list", "--json"]).stdout, "harness list") as { bundles: unknown[] };
    assert.deepEqual(list.bundles, [], "no empty bundle was stored");
  });

  it("doctor shows the built-in wrapper as ready, with how to use it, and never suggests installing it", () => {
    // Dogfood: "! Any command  installed, not hooked" read as a problem, and the
    // next step said `coding.sh init --agent wrapper`, which installs nothing.
    const r = cli(tmpHome(), ["doctor"]);
    assert.match(r.stderr, /^✓ Any command\s+no hooks needed; capture with coding\.sh run -- <cmd>, no runs yet$/m);
    assert.doesNotMatch(r.stderr, /Any command \(co/);
    assert.doesNotMatch(r.stderr, /--agent wrapper/);
  });

  it("show reports files a hook session wrote outside edit tools, from its end snapshot", () => {
    // Regression: Claude Code created hello.txt through Bash; show said
    // "0 files changed" and never mentioned the end snapshot that held it.
    const h = tmpHome();
    const gitBin = which("git") ?? "";
    if (!gitBin) return; // snapshots need git
    const repo = join(h.root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.env, PATH: pathOf(dirname(process.execPath), dirname(gitBin)), GIT_CONFIG_NOSYSTEM: "1", CODING_SH_NO_AUTO_INGEST: "1" })) if (v !== undefined) env[k] = v;
    for (const a of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "init"]]) assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0);
    const hook = (event: string) => {
      const r = spawnSync(process.execPath, [HOOK, "claude-code", event], { env, cwd: repo, encoding: "utf8", input: JSON.stringify({ session_id: "snap-1", cwd: repo, hook_event_name: event }) });
      assert.equal(r.status, 0, r.stderr);
    };
    hook("SessionStart");
    writeFileSync(join(repo, "hello.txt"), "hi\n"); // as a Bash tool would
    hook("Stop");
    hook("SessionEnd");
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: repo, encoding: "utf8", timeout: 30_000 });
    assert.equal(run(["ingest"]).status, 0);
    const doc = parseJson(run(["show", "snap-1", "--json"]).stdout, "show") as { snapshot: { startKind: string; files: { path: string; status: string }[] } | null };
    assert.ok(doc.snapshot, "end snapshot diff is reported");
    assert.equal(doc.snapshot.startKind, "head");
    assert.deepEqual(doc.snapshot.files.map((f) => [f.path, f.status]), [["hello.txt", "add"]]);
    const text = run(["show", "snap-1"]);
    assert.match(text.stdout, /Snapshot\s+HEAD [0-9a-f]{7} → [0-9a-f]{7}: 1 file \(\+1 -0\): hello\.txt/);
  });

  it("doctor does not call hooks that will not fire healthy", () => {
    // Regression: after init, doctor printed "✓ Codex CLI hooked" while Codex
    // skipped the untrusted hooks, and "✓ Cursor CLI hooked" for a CLI too old
    // for hooks. Blocking notes now turn the row into a warning.
    const h = tmpHome();
    const bin = join(h.root, "bin");
    mkdirSync(bin);
    printBin(bin, "cursor-agent", "2025.09.18-7ae6800");
    const PATH = pathOf(bin, h.env.PATH);
    assert.equal(cli(h, ["init", "--yes", "--agent", "cursor"], { PATH }).status, 0);
    const r = cli(h, ["doctor", "--agent", "cursor"], { PATH });
    assert.match(r.stderr, /^! Cursor CLI\s+v2025\.09\.18-7ae6800, hooked but not firing/m);
    assert.match(r.stderr, /predates CLI hooks/);
  });

  it("init's summary says what each agent got and warns when capture cannot work", () => {
    const h = tmpHome();
    const bin = join(h.root, "bin");
    mkdirSync(bin);
    for (const [name, v] of [["cursor-agent", "2025.09.18-7ae6800"], ["agy", "1.2.14"]] as const) {
      printBin(bin, name, v);
    }
    const PATH = pathOf(bin, h.env.PATH);
    const r = cli(h, ["init", "--yes", "--agent", "cursor", "--agent", "antigravity"], { PATH });
    assert.equal(r.status, 0, r.stderr);
    // The blocker is part of the plan, ahead of the Y/n prompt, not a surprise after the writes.
    const blocker = r.stderr.search(/^ {4}! cursor-agent 2025\.09\.18-7ae6800 predates CLI hooks/m);
    assert.ok(blocker >= 0, r.stderr);
    assert.ok(blocker < r.stderr.indexOf("✓ Set up"), "blocker listed before the setup");
    const tail = r.stderr.trimEnd().split("\n").slice(-5);
    assert.match(tail[0]!, /^✓ Set up Cursor CLI \(hooks \+ MCP server\); Antigravity CLI \(hooks\)$/);
    assert.match(tail[1]!, /Recording starts with the next session/);
    assert.doesNotMatch(r.stderr, /Antigravity CLI \(hooks \+ MCP/);
    assert.doesNotMatch(r.stderr, /headless runs/, "informational notes stay out of init");

    const j = parseJson(cli(h, ["init", "--yes", "--json", "--agent", "cursor"], { PATH }).stdout, "init json") as { agents: { id: string; warnings: string[] }[] };
    assert.match(j.agents[0]!.warnings[0]!, /predates CLI hooks/);
  });
});

describe("doctor on a dogfood machine", () => {
  // Dogfood: hooks wired in <project>/.claude/settings.local.json, events
  // arriving, and doctor said "! Claude Code v2.1.319, not hooked, last event 2s ago".
  function claudeHome(): { h: Home; PATH: string; proj: string; run: (cwd: string, args: string[], extra?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>; hook: (cwd: string) => void } {
    const h = tmpHome();
    const bin = join(h.root, "bin");
    printBin(bin, "claude", "2.1.319 (Claude Code)");
    const PATH = pathOf(bin, h.env.PATH);
    const proj = join(h.root, "work", "demo");
    mkdirSync(proj, { recursive: true });
    const envOf = (extra: NodeJS.ProcessEnv) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...h.env, PATH, CODING_SH_NO_AUTO_INGEST: "1", ...extra })) if (v !== undefined) env[k] = v;
      return env;
    };
    const run = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { env: envOf(extra), cwd, encoding: "utf8", timeout: 30_000 });
    const hook = (cwd: string) => {
      const r = spawnSync(process.execPath, [HOOK, "claude-code", "SessionStart"], { env: envOf({}), cwd, encoding: "utf8", input: JSON.stringify({ session_id: "dog-1", cwd, hook_event_name: "SessionStart" }) });
      assert.equal(r.status, 0, r.stderr);
    };
    return { h, PATH, proj, run, hook };
  }

  it("reports hooks in a project's .claude/settings.local.json, from the project and from the spooled events' cwd", () => {
    const { h, proj, run, hook } = claudeHome();
    const init = run(proj, ["init", "--scope", "project", "--agent", "claude-code", "--yes"]);
    assert.equal(init.status, 0, init.stderr);
    const file = join(proj, ".claude", "settings.local.json");
    assert.ok(existsSync(file));
    const row = new RegExp(`^✓ Claude Code\\s+v2\\.1\\.319, hooked in ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(project\\), `, "m");

    const inProj = run(proj, ["doctor", "--agent", "claude-code"]);
    assert.match(inProj.stderr, row);
    assert.doesNotMatch(inProj.stderr, /not hooked|Capture the agents without hooks/);

    // From elsewhere, the project is known from where the agent's events ran.
    hook(proj);
    const elsewhere = run(h.home, ["doctor", "--agent", "claude-code"]);
    assert.match(elsewhere.stderr, row);
    const doc = parseJson(run(h.home, ["doctor", "--json", "--agent", "claude-code"]).stdout, "doctor") as { agents: { id: string; hooked: boolean; projectHooks: string[] }[] };
    const a = doc.agents.find((x) => x.id === "claude-code")!;
    assert.equal(a.hooked, false, "hooked stays about the user config");
    assert.deepEqual(a.projectHooks, [file]);
  });

  it("reports one state when a project's hooks run another home's hook, and names each settings file", () => {
    // Regression: doctor under a temp CODING_SH_HOME, run from a repo whose
    // .claude/settings.local.json runs the real ~/.coding.sh hook, said both
    // "✓ Claude Code hooked in <file> (project)" and "! Hook missing".
    const { h, proj, run } = claudeHome();
    const other = join(h.root, "other-home", ".coding.sh");
    const init = run(proj, ["init", "--scope", "project", "--agent", "claude-code", "--yes"], { CODING_SH_HOME: other });
    assert.equal(init.status, 0, init.stderr);
    const file = join(proj, ".claude", "settings.local.json");
    const otherHook = join(other, "bin", "hook.mjs");
    assert.ok(existsSync(otherHook));
    assert.ok(!existsSync(join(h.data, "bin", "hook.mjs")));

    const r = run(proj, ["doctor", "--agent", "claude-code"]);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(r.stderr, new RegExp(`^! Claude Code\\s+v2\\.1\\.319, hooks in ${esc(file)} \\(project\\) run ${esc(otherHook)}, not this home's hook, `, "m"));
    assert.doesNotMatch(r.stderr, /✓ Claude Code/);
    assert.match(r.stderr, /^! Hook\s+missing at .*hook\.mjs; run coding\.sh init$/m);
    assert.match(r.stderr, /coding\.sh init --agent claude-code/);
    const doc = parseJson(run(proj, ["doctor", "--json", "--agent", "claude-code"]).stdout, "doctor") as { agents: { id: string; hookFiles: unknown[] }[] };
    assert.deepEqual(doc.agents.find((x) => x.id === "claude-code")!.hookFiles, [{ file, scope: "project", hook: otherHook, current: false }]);

    // Hooked for this home, in the user config, but its hook bin is gone: one warning, naming the file.
    const ui = run(proj, ["init", "--agent", "claude-code", "--yes"]);
    assert.doesNotMatch(ui.stderr, /skipping hooks/, "project hooks for another home do not block this one");
    assert.equal(ui.status, 0);
    rmSync(join(h.data, "bin", "hook.mjs"));
    const gone = run(proj, ["doctor", "--agent", "claude-code"]);
    assert.match(gone.stderr, new RegExp(`^! Claude Code\\s+v2\\.1\\.319, hooked in ${esc(join(h.home, ".claude", "settings.json"))}, but the hook it runs is missing, `, "m"));
    assert.match(gone.stderr, /^! Hook\s+missing at /m);
  });

  it("never says 'not hooked' while events arrive", () => {
    const { h, run, hook } = claudeHome();
    const before = run(h.home, ["doctor", "--agent", "claude-code"]);
    assert.match(before.stderr, /^! Claude Code\s+v2\.1\.319, not hooked, no events yet/m);
    const other = join(h.root, "elsewhere");
    mkdirSync(other);
    hook(other);
    const r = run(h.home, ["doctor", "--agent", "claude-code"]);
    assert.match(r.stderr, /^✓ Claude Code\s+v2\.1\.319, events arriving, hook not in user config, last event /m);
    assert.doesNotMatch(r.stderr, /Capture the agents without hooks/);
  });

  it("a stale hook bin gets `update --refresh-bin`, not init, and the next ingest refreshes it", () => {
    const { h, run } = claudeHome();
    const binDir = join(h.data, "bin");
    mkdirSync(binDir, { recursive: true });
    const hookFile = join(binDir, "hook.mjs");
    writeFileSync(hookFile, "// hook from the previous version\n");
    writeFileSync(join(binDir, "cli-path"), CLI + "\n");
    const r = run(h.home, ["doctor"]);
    assert.match(r.stderr, /^! Hook\s+.*hook\.mjs is stale \(differs from the hook this CLI ships\); run coding\.sh update --refresh-bin$/m);
    assert.doesNotMatch(r.stderr, /stale.*coding\.sh init/);

    // `npm i -g` of a newer version: the hook's session-end ingest runs the new CLI.
    assert.equal(run(h.home, ["ingest", "--background"]).status, 0);
    assert.equal(readFileSync(hookFile, "utf8"), readFileSync(HOOK, "utf8"));
    assert.match(run(h.home, ["doctor"]).stderr, /^✓ Hook\s+.*hook\.mjs$/m);
  });

  it("ingest leaves the bin alone when init never ran, or when cli-path names another install", () => {
    const fresh = claudeHome();
    assert.equal(fresh.run(fresh.h.home, ["ingest"]).status, 0);
    assert.equal(existsSync(join(fresh.h.data, "bin", "hook.mjs")), false);

    const { h, run } = claudeHome();
    const binDir = join(h.data, "bin");
    mkdirSync(binDir, { recursive: true });
    const otherCli = join(h.root, "other", "dist", "cli.mjs");
    mkdirSync(dirname(otherCli), { recursive: true });
    writeFileSync(otherCli, "");
    writeFileSync(join(binDir, "hook.mjs"), "// another install's hook\n");
    writeFileSync(join(binDir, "cli-path"), otherCli + "\n");
    assert.equal(run(h.home, ["ingest"]).status, 0);
    assert.equal(readFileSync(join(binDir, "hook.mjs"), "utf8"), "// another install's hook\n");
    assert.equal(readFileSync(join(binDir, "cli-path"), "utf8"), otherCli + "\n");
  });
});

describe("cli QA fixes", () => {
  it("duration rounds before splitting, so a carry moves up a unit", async () => {
    const { duration } = await import("../../src/cli/output.ts");
    assert.deepEqual([119600, 59700, 999.6, 3599700, 7199999].map(duration), ["2m00s", "1m00s", "1.0s", "1h00m", "2h00m"]);
    assert.deepEqual([0, 500, 1234, 9940, 9960, 42_000, 187_000, 7_500_000].map(duration), ["0ms", "500ms", "1.2s", "9.9s", "10s", "42s", "3m07s", "2h05m"]);
    assert.equal(duration(undefined), "-");
  });

  it("row labels that do not fit end in an ellipsis", async () => {
    const { formatLabel, LABEL_WIDTH } = await import("../../src/cli/output.ts");
    const f = formatLabel("Any command (coding.sh run --)");
    assert.equal(f.length, LABEL_WIDTH);
    assert.match(f, /…\s$/);
    assert.equal(formatLabel("Claude Code"), "Claude Code".padEnd(LABEL_WIDTH));
  });

  it("--port rejects a non-integer too", () => {
    const r = cli(tmpHome(), ["doctor", "--port", "1.5"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--port must be 0-65535, got 1\.5/);
  });

  it("init summary helpers", async () => {
    const { blockingNotes, setupSummary } = await import("../../src/cli/commands/init.ts");
    assert.equal(setupSummary([{ name: "A", mcp: true }, { name: "B", mcp: true }]), "A and B (hooks + MCP server)");
    assert.equal(setupSummary([{ name: "A", mcp: false }]), "A (hooks)");
    assert.equal(setupSummary([]), "");
    assert.deepEqual(
      blockingNotes(["hooks are disabled in config.toml ([features] hooks = false); coding.sh hooks will not run", "Token totals are written at session shutdown", "2 coding.sh hook(s) not trusted yet (Stop)"]).length,
      2,
    );
  });

  it("update: a 404 from every source is 'no release', not a connection problem", async () => {
    const { checkFailed } = await import("../../src/cli/commands/update.ts");
    const none = checkFailed({ error: "GitHub: x returned HTTP 404; npm: y returned HTTP 404", errorKind: "no_release" } as never, "0.0.1");
    assert.equal(none.reason, "no_release");
    assert.match(none.message, /No coding\.sh release has been published yet/);
    assert.ok(none.next.some((n) => n.includes("github.com/jackulau/coding.sh/releases")));
    assert.ok(!none.next.some((n) => /connection/i.test(n)));
    const net = checkFailed({ error: "GitHub: fetch failed; npm: fetch failed", errorKind: "network" } as never, "0.0.1");
    assert.equal(net.reason, "update_check_failed");
    assert.match(net.next[0]!, /Check your connection/);
    const bad = checkFailed({ error: "GitHub: x returned HTTP 500; npm: y returned HTTP 404", errorKind: "bad_response" } as never, "0.0.1");
    assert.doesNotMatch(bad.next[0]!, /connection/);
  });
});

describe("cli exp regrade", () => {
  it("grades stored outputs again without the task, prints the flips, and compare warns on the grader change", () => {
    const h = tmpHome();
    assert.equal(cli(h, ["dataset", "add", "arith", "--case", '{"input":"4","expected":"4"}', "--case", '{"input":"5","expected":"5"}', "--case", '{"input":"6","expected":"6"}']).status, 0);
    const counter = join(h.home, "calls.txt");
    writeFileSync(join(h.home, "echo.mjs"), `import{appendFileSync}from"node:fs";appendFileSync(${JSON.stringify(counter)},"x");let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n`);
    const ran = cli(h, ["exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", '{"kind":"exact"}', "--name", "base", "--json"]);
    assert.equal(ran.status, 0, ran.stderr);
    const baseId = (parseJson(ran.stdout, "run") as { experiment: { id: string } }).experiment.id;
    const calls = readFileSync(counter, "utf8").length;
    writeFileSync(join(h.home, "spec.json"), JSON.stringify({ graders: [{ kind: "regex", pattern: "^[45]$" }] }));
    const human = cli(h, ["exp", "regrade", "base", "spec.json"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /flips {3}1 of 3 runs: 1 pass → fail, 0 fail → pass/);
    assert.match(human.stdout, /100\.0% → 66\.7%/);
    assert.equal(readFileSync(counter, "utf8").length, calls, "the task was never called");
    const regexId = human.stdout.trim().split("\n").find((l) => /^exp_/.test(l))!;
    const json = cli(h, ["exp", "regrade", baseId, "-g", '{"kind":"exact"}', "--name", "same", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const out = parseJson(json.stdout, "regrade") as { experiment: { id: string; metadata: { regradeOf: string } }; diff: { flips: unknown[] } };
    assert.equal(out.diff.flips.length, 0);
    assert.equal(out.experiment.metadata.regradeOf, baseId);
    const same = cli(h, ["exp", "compare", baseId, "same", "--json"]);
    assert.equal((parseJson(same.stdout, "compare") as { comparison: { instrumentWarning?: string } }).comparison.instrumentWarning, undefined);
    const warned = cli(h, ["exp", "compare", baseId, regexId]);
    assert.match(warned.stdout, /not graded alike: exact graded only A; regex graded only B/);
    const none = cli(h, ["exp", "regrade", "base"]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /Missing graders/);

    // --grader adds to the spec file's graders; --replace-graders uses only the flags.
    const ids = (r: ReturnType<typeof cli>) => (parseJson(r.stdout, "graders") as { experiment: { graders: { id: string }[] } }).experiment.graders.map((g) => g.id).sort();
    assert.deepEqual(ids(cli(h, ["exp", "regrade", baseId, "spec.json", "-g", '{"kind":"exact"}', "--json"])), ["exact", "regex"]);
    assert.deepEqual(ids(cli(h, ["exp", "regrade", baseId, "spec.json", "-g", '{"kind":"regex","pattern":"^[45]$"}', "--json"])), ["regex"], "the same grader is not added twice");
    assert.deepEqual(ids(cli(h, ["exp", "regrade", baseId, "spec.json", "-g", '{"kind":"exact"}', "--replace-graders", "--json"])), ["exact"]);
    writeFileSync(join(h.home, "run.json"), JSON.stringify({ dataset: "arith", task: { kind: "command", command: "node echo.mjs" }, graders: [{ kind: "regex", pattern: "^[45]$" }] }));
    assert.deepEqual(ids(cli(h, ["exp", "run", "run.json", "-g", '{"kind":"exact"}', "--json"])), ["exact", "regex"]);
    assert.deepEqual(ids(cli(h, ["exp", "run", "run.json", "-g", '{"kind":"exact"}', "--replace-graders", "--json"])), ["exact"]);
    const alone = cli(h, ["exp", "run", "run.json", "--replace-graders"]);
    assert.equal(alone.status, 2);
    assert.match(alone.stderr, /--replace-graders needs at least one --grader/);
  });
});

describe("cli exp run matrix", () => {
  it("--plan stores nothing, a run stores one experiment per cell with Holm p, and a vary violation exits 2", () => {
    const h = tmpHome();
    assert.equal(cli(h, ["dataset", "add", "up", ...["a", "b", "c", "d"].flatMap((q) => ["--case", JSON.stringify({ id: q, input: q, expected: q.toUpperCase() })])]).status, 0);
    // Upper-cases its input, except under MODEL=bad.
    writeFileSync(join(h.home, "up.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const q=JSON.parse(s);process.stdout.write(JSON.stringify(process.env.MODEL==="bad"?q:q.toUpperCase()))});\n');
    const base = { name: "mx", dataset: "up", task: { kind: "command", command: "node up.mjs", env: { MODEL: "good" } }, graders: [{ kind: "exact" }] };
    writeFileSync(join(h.home, "matrix.json"), JSON.stringify({ ...base, matrix: { model: { path: "/task/env/MODEL", values: ["good", "bad", "also-good"] } }, baseline: { model: "good" } }));
    const plan = cli(h, ["exp", "run", "matrix.json", "--plan", "--json"]);
    assert.equal(plan.status, 0, plan.stderr);
    const p = parseJson(plan.stdout, "plan") as { plan: { baseline: string; vary: string[]; cells: { name: string; baseline?: boolean }[] } };
    assert.deepEqual(p.plan.cells.map((c) => c.name), ["model=good", "model=bad", "model=also-good"]);
    assert.deepEqual(p.plan.vary, ["/task/env/MODEL"]);
    assert.equal(p.plan.cells[0]!.baseline, true);
    const listOf = () => (parseJson(cli(h, ["exp", "list", "--json"]).stdout, "list") as { experiments: { name: string }[] }).experiments;
    assert.equal(listOf().length, 0, "--plan stores nothing");

    const run = cli(h, ["exp", "run", "matrix.json", "--seed", "3", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    const r = parseJson(run.stdout, "run") as { outcome: string; matrix: { id: string; seed: number }; experiments: Record<string, string>; comparisons: Record<string, { pHolm: number; mcnemar: { p: number; b: number } }> };
    assert.equal(r.outcome, "completed");
    assert.match(r.matrix.id, /^mx_/);
    assert.equal(r.matrix.seed, 3);
    assert.deepEqual(Object.keys(r.experiments), ["model=good", "model=bad", "model=also-good"]);
    assert.deepEqual(Object.keys(r.comparisons), ["model=bad", "model=also-good"]);
    assert.equal(r.comparisons["model=bad"]!.mcnemar.b, 4);
    for (const c of Object.values(r.comparisons)) assert.ok(c.pHolm >= c.mcnemar.p);
    assert.deepEqual(listOf().map((e) => e.name).sort(), ["mx/model=also-good", "mx/model=bad", "mx/model=good"]);

    writeFileSync(join(h.home, "variants.json"), JSON.stringify({ ...base, vary: ["/task/env/MODEL"], variants: { a: {}, b: { "/task/env/MODEL": "bad", "/task/timeoutMs": 5000 } }, baseline: "a" }));
    const bad = cli(h, ["exp", "run", "variants.json"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /outside "vary" \(\/task\/env\/MODEL\): b: \/task\/timeoutMs/);
    assert.equal(cli(h, ["exp", "run", "variants.json", "--plan"]).status, 2, "--plan validates too");
    writeFileSync(join(h.home, "graders.json"), JSON.stringify({ ...base, vary: ["/graders/0"], variants: { a: {}, b: { "/graders/0": { kind: "contains", value: "A" } } }, baseline: "a" }));
    assert.match(cli(h, ["exp", "run", "graders.json"]).stderr, /graders and dataset are not overridable/);
    assert.equal(listOf().length, 3, "nothing stored by the refused specs");

    writeFileSync(join(h.home, "plain.json"), JSON.stringify(base));
    const noMatrix = cli(h, ["exp", "run", "plain.json", "--plan"]);
    assert.equal(noMatrix.status, 2);
    assert.match(noMatrix.stderr, /--plan/);
    const arm = cli(h, ["exp", "run", "matrix.json", "--arm", "x=y.json"]);
    assert.equal(arm.status, 2);
    assert.match(arm.stderr, /--arm does not combine with a matrix spec/);

    // --reuse: the plan counts the stored baseline case-trials; the flags are refused where they mean nothing.
    const reusePlan = cli(h, ["exp", "run", "matrix.json", "--reuse", "baseline", "--plan", "--json"]);
    assert.equal(reusePlan.status, 0, reusePlan.stderr);
    assert.deepEqual((parseJson(reusePlan.stdout, "reuse plan") as { reuse: unknown }).reuse, { "model=good": { reused: 4, toRun: 0 }, "model=bad": { reused: 0, toRun: 4 }, "model=also-good": { reused: 0, toRun: 4 } });
    const reuseRun = cli(h, ["exp", "run", "matrix.json", "--reuse", "baseline", "--cell", "model=bad"]);
    assert.equal(reuseRun.status, 0, reuseRun.stderr);
    assert.match(reuseRun.stdout, /2 cells, interleaved \(seed \d+\), 4 case-trials reused/);
    assert.match(reuseRun.stdout, /! reused case-trials from earlier experiments \(model=good 4\/4\)/);
    const plainReuse = cli(h, ["exp", "run", "plain.json", "--reuse", "baseline"]);
    assert.equal(plainReuse.status, 2);
    assert.match(plainReuse.stderr, /--reuse needs a spec file with "matrix" or "variants"/);
    const ageOnly = cli(h, ["exp", "run", "matrix.json", "--reuse-max-age", "1d"]);
    assert.equal(ageOnly.status, 2);
    assert.match(ageOnly.stderr, /--reuse-max-age needs --reuse baseline or --reuse all/);
    assert.equal(cli(h, ["exp", "run", "matrix.json", "--reuse", "both"]).status, 2, "exp run takes baseline, all or none");
    assert.match(cli(h, ["exp", "run", "matrix.json", "--reuse", "all", "--reuse-max-age", "soon"]).stderr, /--reuse-max-age needs a duration/);
  });
});
