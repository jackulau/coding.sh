// End-to-end CLI tests against a fresh esbuild bundle (never a stale dist/).
// Every run gets a temp HOME / CODING_SH_HOME and a PATH holding only node's
// directory, so no real agent binary runs and no real config is touched.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";

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
    // Best of three: the first spawn pays cold file-cache costs.
    let best = Infinity;
    let bare = Infinity;
    let res: SpawnSyncReturns<string> | undefined;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      res = cli(h, ["--help"]);
      best = Math.min(best, performance.now() - t0);
      // A bare node spawn under the same load: the budget is for the CLI's own startup, so a busy
      // machine (the parallel suite, other jobs) slows both and does not fail the check.
      const t1 = performance.now();
      spawnSync(process.execPath, ["-e", ""]);
      bare = Math.min(bare, performance.now() - t1);
    }
    assert.equal(res!.status, 0, res!.stderr);
    assert.match(res!.stdout, /coding\.sh/);
    assert.match(res!.stdout, /init/);
    assert.ok(best - bare < 170, `--help took ${best.toFixed(0)} ms (bare node ${bare.toFixed(0)} ms)`);
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
    const gitBin = spawnSync("git", ["--version"]).status === 0 ? spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim() : "";
    if (!gitBin) return; // snapshots need git
    const extra = { PATH: `${dirname(process.execPath)}:${dirname(gitBin)}`, GIT_CONFIG_NOSYSTEM: "1" };
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
    assert.ok(installed.includes(res.hook), "settings point at the hook bin");
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
    const tail = i.stderr.trimEnd().split("\n").slice(-3);
    assert.match(tail[0]!, /Set up Claude Code.*\(hooks \+ MCP server\)/);
    assert.match(tail[1]!, /Open the viewer: coding\.sh$/);
    assert.match(tail[2]!, /Docs: https:\/\/coding\.sh\/docs$/);
    for (const f of Object.values(files)) assert.match(readFileSync(f, "utf8"), /coding-sh/, f);
    assert.equal(readFileSync(join(h.data, "bin", "cli-path"), "utf8"), `${CLI}\n`, "hook knows the CLI for background ingests");

    const again = cli(h, ["init", "--yes", "--json", ...agentArgs]);
    assert.equal((parseJson(again.stdout, "init again") as { outcome: string }).outcome, "unchanged", again.stderr);

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
    const gitBin = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    if (!gitBin) return; // snapshots need git
    const repo = join(h.root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...h.env, PATH: `${dirname(process.execPath)}:${dirname(gitBin)}`, GIT_CONFIG_NOSYSTEM: "1", CODING_SH_NO_AUTO_INGEST: "1" })) if (v !== undefined) env[k] = v;
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
    writeFileSync(join(bin, "cursor-agent"), "#!/bin/sh\necho 2025.09.18-7ae6800\n", { mode: 0o755 });
    const PATH = `${bin}:${h.env.PATH}`;
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
      writeFileSync(join(bin, name), `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
    }
    const PATH = `${bin}:${h.env.PATH}`;
    const r = cli(h, ["init", "--yes", "--agent", "cursor", "--agent", "antigravity"], { PATH });
    assert.equal(r.status, 0, r.stderr);
    // The blocker is part of the plan, ahead of the Y/n prompt, not a surprise after the writes.
    const blocker = r.stderr.search(/^ {4}! cursor-agent 2025\.09\.18-7ae6800 predates CLI hooks/m);
    assert.ok(blocker >= 0, r.stderr);
    assert.ok(blocker < r.stderr.indexOf("✓ Set up"), "blocker listed before the setup");
    const tail = r.stderr.trimEnd().split("\n").slice(-3);
    assert.match(tail[0]!, /^✓ Set up Cursor CLI \(hooks \+ MCP server\); Antigravity CLI \(hooks\)$/);
    assert.doesNotMatch(r.stderr, /Antigravity CLI \(hooks \+ MCP/);
    assert.doesNotMatch(r.stderr, /headless runs/, "informational notes stay out of init");

    const j = parseJson(cli(h, ["init", "--yes", "--json", "--agent", "cursor"], { PATH }).stdout, "init json") as { agents: { id: string; warnings: string[] }[] };
    assert.match(j.agents[0]!.warnings[0]!, /predates CLI hooks/);
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
