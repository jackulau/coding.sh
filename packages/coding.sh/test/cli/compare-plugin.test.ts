// `coding.sh compare <bundle> --with plugin:<name>` and `--without plugin:<name>`:
// "with plugin vs without" in one command. A fake `claude` on PATH fixes the bug
// only when it was started with a --plugin-dir holding the plugin (outside its
// work dir, hook script still executable), and logs every run. The plugin is
// installed in a temp CLAUDE_CONFIG_DIR, which must come out byte-for-byte the same.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
// The fake claude is a shebang script; Windows would need a .cmd shim.
const skip = !gitBin || process.platform === "win32";
let root = "";
let home = "";
let repo = "";
let claudeDir = "";
let env: Record<string, string> = {};
let configBefore: Record<string, string> = {};

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}

function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[relative(dir, abs)] = `${createHash("sha256").update(readFileSync(abs)).digest("hex")}:${statSync(abs).mode}`;
    }
  };
  walk(dir);
  return out;
}

const runs = () =>
  readFileSync(join(root, "runs.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { dirs: string[]; ok: boolean; inWork: boolean });

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-with-plugin-")));
  home = join(root, "home");
  repo = join(root, "repo");
  claudeDir = join(root, "claude-config");
  const bin = join(root, "bin");
  for (const d of [home, repo, bin, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: claudeDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(bin, dirname(process.execPath), dirname(gitBin), "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  // The plugin, installed in the (temp) Claude config dir; a copy in a plain dir for plugin:<dir>.
  const plugin = (dir: string) => {
    const files: Record<string, string> = {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "tiny", version: "0.1.0" }),
      "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh" }] }] } }),
      "hooks/start.sh": "#!/bin/sh\necho tiny\n",
      "skills/t/SKILL.md": "---\nname: t\ndescription: Use when summing.\n---\nUse +.\n",
    };
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    chmodSync(join(dir, "hooks/start.sh"), 0o755);
  };
  const installed = join(claudeDir, "plugins", "cache", "tiny-mk", "tiny", "0.1.0");
  plugin(installed);
  plugin(join(root, "tiny-plugin"));
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "tiny@tiny-mk": true } }));
  writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tiny@tiny-mk": [{ scope: "user", installPath: installed, version: "0.1.0" }] } }));
  configBefore = fingerprint(claudeDir);

  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.319 (Claude Code)"); process.exit(0); }
const dirs = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--plugin-dir") dirs.push(args[++i]);
const ok = dirs.length === 1 && fs.existsSync(path.join(dirs[0], "skills/t/SKILL.md")) && (fs.statSync(path.join(dirs[0], "hooks/start.sh")).mode & 0o111) !== 0;
const inWork = dirs.some((d) => !path.relative(process.cwd(), d).startsWith(".."));
fs.appendFileSync(${JSON.stringify(join(root, "runs.log"))}, JSON.stringify({ dirs, ok, inWork }) + "\\n");
if (ok) fs.writeFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");
const sid = args[args.indexOf("--session-id") + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: sid, result: "done", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
  );
  chmodSync(join(bin, "claude"), 0o755);

  writeFileSync(join(repo, "sum.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(repo, "test.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const fix = 'require("fs").writeFileSync("sum.js","module.exports=(a,b)=>a+b;\\n")';
  assert.equal(cli(["run", "--", process.execPath, "-e", fix], repo).status, 0);
  const t = cli(["eval", "new", "latest", "--name", "sum", "--verifier", "node test.js", "--instruction", "make sum add", "--json"], repo);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  git("checkout", "-q", "sum.js");

  const h = join(root, "harness");
  mkdirSync(h);
  writeFileSync(join(h, "CLAUDE.md"), "be brief\n");
  writeFileSync(join(h, "harness.toml"), 'name = "base"\nagent = "claude-code"\ninclude = ["CLAUDE.md"]\n');
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Report = { baseline: { passes: number; runs: number; name: string }; candidate: { passes: number; runs: number; name: string }; ablation?: { paths: string[] }; itemGate?: unknown };

describe("compare --with plugin:<name>", () => {
  it("runs A, and A plus the installed plugin loaded with --plugin-dir, in one command", (t) => {
    if (skip) return t.skip("needs git and a POSIX shebang");
    const r = cli(["compare", "base", "--with", "plugin:tiny", "-t", "sum", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { report } = JSON.parse(r.stdout) as { report: Report };
    assert.equal(report.candidate.name, "base-with-plugin-tiny");
    assert.deepEqual([report.baseline.passes, report.baseline.runs, report.candidate.passes, report.candidate.runs], [0, 1, 1, 1]);
    assert.equal(report.itemGate, undefined, "a plugin is not a one-item change");
    const log = runs();
    assert.equal(log.length, 2);
    const withPlugin = log.filter((x) => x.dirs.length);
    assert.equal(withPlugin.length, 1, "only arm B got --plugin-dir");
    assert.ok(withPlugin[0]!.ok, "B's plugin dir holds the plugin, hook script executable");
    assert.ok(!withPlugin[0]!.inWork, "the plugin is outside the work dir");
    assert.ok(!withPlugin[0]!.dirs[0]!.startsWith(claudeDir), "the plugin is not loaded from the user's config dir");

    const list = JSON.parse(cli(["harness", "list", "--json"]).stdout) as { bundles: { name: string; plugins?: { name: string; marketplace: string | null; version: string | null }[] }[] };
    const derived = list.bundles.find((b) => b.name === "base-with-plugin-tiny");
    assert.deepEqual(derived?.plugins, [{ name: "tiny", marketplace: "tiny-mk", version: "0.1.0" }]);
    assert.equal(list.bundles.find((b) => b.name === "base")?.plugins, undefined);

    // The mirror: --without plugin:tiny on the derived bundle.
    const w = cli(["compare", "base-with-plugin-tiny", "--without", "plugin:tiny", "-t", "sum", "--yes"]);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.match(w.stdout, /^A = base-with-plugin-tiny · B = base-with-plugin-tiny without plugin:tiny \(4 files dropped\)$/m);
    assert.match(w.stdout, /^ {2}- plugin tiny$/m);
    assert.deepEqual(
      runs()
        .slice(2)
        .map((x) => x.dirs.length)
        .sort(),
      [0, 1],
    );
    assert.deepEqual(fingerprint(claudeDir), configBefore, "the Claude config dir is byte-for-byte untouched");
  });

  it("takes a plugin dir, and refuses what it can't load", (t) => {
    if (skip) return t.skip("needs git and a POSIX shebang");
    const dry = cli(["compare", "base", "--with", "plugin:./tiny-plugin", "-t", "sum", "--dry-run", "--json"], root);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal((JSON.parse(dry.stdout) as { candidate: { name: string } }).candidate.name, "base-with-plugin-tiny");

    const notPlugin = cli(["compare", "base", "--with", ".claude/skills/x", "-t", "sum", "--dry-run"]);
    assert.equal(notPlugin.status, 2);
    assert.match(notPlugin.stderr, /--with takes a Claude Code plugin, plugin:<name\|name@marketplace\|dir>/);
    const unknown = cli(["compare", "base", "--with", "plugin:nope", "-t", "sum", "--dry-run"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /plugin nope is not installed \(installed: tiny@tiny-mk\)/);
    const both = cli(["compare", "base", "--with", "plugin:tiny", "--without", "CLAUDE.md"]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /Pass --with or --without, not both/);
    const absent = cli(["compare", "base", "--without", "plugin:tiny", "-t", "sum", "--dry-run"]);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /bundle base has no plugin tiny; it carries no plugins/);
  });

  it("harness snapshot --plugin carries a named plugin; a non-claude agent is refused", (t) => {
    if (skip) return t.skip("needs git and a POSIX shebang");
    const s = cli(["harness", "snapshot", "--agent", "claude-code", "--name", "snap", "--dir", repo, "--plugin", "tiny", "--json"]);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    const { bundle } = JSON.parse(s.stdout) as { bundle: { plugins: { name: string }[]; files: string[] } };
    assert.deepEqual(
      bundle.plugins.map((p) => p.name),
      ["tiny"],
    );
    assert.ok(bundle.files.includes("~/.coding.sh-plugins/tiny/hooks/start.sh"));
    const codex = cli(["harness", "snapshot", "--agent", "codex", "--plugin", "tiny"]);
    assert.equal(codex.status, 2);
    assert.match(codex.stderr, /--plugin loads Claude Code plugins; agent codex can't/);
    assert.deepEqual(fingerprint(claudeDir), configBefore);
  });
});
