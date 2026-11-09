// Claude Code plugins in harness bundles: resolution (installed by name, or a
// dir), storage as blobs, the bundle id, applyBundle + overlayClaude putting
// them under the run's isolated home, and the --with / --without derivations.
// Every config dir is a temp dir; the user's real ~/.claude is never read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { overlayClaude } from "../../src/adapters/claude-code.ts";
import { sha256Hex } from "../../src/core/ids.ts";
import type { HarnessBundle } from "../../src/core/types.ts";
import { ablateBundle, addPlugins, applyBundle, bundleFromDir, bundleFromToml, bundleId, canonicalJson, diffBundles, formatBundleDiff } from "../../src/runner/bundle.ts";
import { bundleItemChange } from "../../src/runner/harness-report.ts";
import { installedPlugins, pluginProblem, resolvePlugin, storePlugin } from "../../src/runner/plugins.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { MemBlobs, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<string> {
  const d = await tempDir("csh-plugins-");
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), c);
  }
  return d;
}

/** Every file under dir → sha256 of its bytes (and its mode), to prove a dir is byte-for-byte untouched. */
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

const PLUGIN = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "terse", version: "1.2.0" }),
  "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/start.sh" }] }] } }),
  "hooks/start.sh": "#!/bin/sh\necho keep it short\n",
  "skills/grunt/SKILL.md": "---\nname: grunt\ndescription: Use when terse.\n---\nGrunt.\n",
  ".git/HEAD": "ref: refs/heads/main\n",
};

/** A Claude config dir with `terse@terse` installed (v2 shape), plus a settings.json that enables it. */
async function claudeDirWithTerse(): Promise<{ claudeDir: string; pluginDir: string }> {
  const claudeDir = await tree({ "settings.json": JSON.stringify({ enabledPlugins: { "terse@terse": true } }) });
  const pluginDir = join(claudeDir, "plugins", "cache", "terse", "terse", "1.2.0");
  for (const [p, c] of Object.entries(PLUGIN)) {
    await mkdir(dirname(join(pluginDir, p)), { recursive: true });
    await writeFile(join(pluginDir, p), c);
  }
  await chmod(join(pluginDir, "hooks/start.sh"), 0o755);
  await writeFile(
    join(claudeDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "terse@terse": [
          { scope: "project", installPath: "/nowhere", version: "0.1.0", projectPath: "/work/demo" },
          { scope: "user", installPath: pluginDir, version: "1.2.0", installedAt: "2026-01-01T00:00:00.000Z" },
        ],
        "pdf@anthropic-agent-skills": [{ scope: "user", installPath: join(claudeDir, "plugins", "cache", "pdf"), version: "1.0.0" }],
      },
    }),
  );
  return { claudeDir, pluginDir };
}

const isWin = process.platform === "win32";

describe("bundleId", () => {
  it("keeps the id of a bundle without plugins (the old formula), and plugins: [] changes nothing", () => {
    const b = { name: "base", agent: "claude-code", flags: ["--max-turns", "4"], env: { A: "1" }, files: { "CLAUDE.md": "blob1" }, remove: ["AGENTS.md"] };
    const old = sha256Hex(canonicalJson({ v: 0, name: b.name, agent: b.agent, model: null, flags: b.flags, env: b.env, files: b.files, remove: b.remove }));
    assert.equal(bundleId(b), old);
    assert.equal(bundleId({ ...b, plugins: [] }), old);
    assert.equal(bundleId(b), "b68d6d802811bb7f0dd69e08f2bf741747c55d60e8f1ef4ee3fac76f21e68046");
    assert.notEqual(bundleId({ ...b, plugins: [{ name: "terse" }] }), old);
  });

  it("changes when a plugin's content changes", async () => {
    const blobs = new MemBlobs();
    const dir = await tree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "tiny" }), "skills/x/SKILL.md": "one\n" });
    const proj = await tree({ "CLAUDE.md": "rules\n" });
    const opts = { name: "b", agent: "claude-code", dir: proj, include: ["CLAUDE.md"], blobs, plugins: [dir], claudeDir: proj, now: 1 };
    const one = await bundleFromDir(opts);
    assert.equal((await bundleFromDir(opts)).id, one.id, "deterministic");
    await writeFile(join(dir, "skills/x/SKILL.md"), "two\n");
    assert.notEqual((await bundleFromDir(opts)).id, one.id);
  });
});

describe("resolving plugins", () => {
  it("finds an installed plugin by name or name@marketplace (v2, user scope first) and stores its whole dir", async () => {
    const { claudeDir, pluginDir } = await claudeDirWithTerse();
    const before = fingerprint(claudeDir);
    const list = await installedPlugins(claudeDir);
    assert.deepEqual(
      list.map((p) => [p.key, p.installPath, p.version]),
      [
        ["pdf@anthropic-agent-skills", join(claudeDir, "plugins", "cache", "pdf"), "1.0.0"],
        ["terse@terse", pluginDir, "1.2.0"],
      ],
    );
    const r = await resolvePlugin("terse", { cwd: "/", claudeDir });
    assert.deepEqual(r, { name: "terse", dir: pluginDir, marketplace: "terse", version: "1.2.0" });
    assert.deepEqual(await resolvePlugin("terse@terse", { cwd: "/", claudeDir }), r);

    const blobs = new MemBlobs();
    const proj = await tree({ "CLAUDE.md": "rules\n" });
    const b = await bundleFromDir({ name: "with-terse", agent: "claude-code", dir: proj, include: ["CLAUDE.md"], blobs, plugins: ["terse"], claudeDir });
    assert.deepEqual(b.plugins, [{ name: "terse", marketplace: "terse", version: "1.2.0", ...(isWin ? {} : { exec: ["hooks/start.sh"] }) }]);
    assert.deepEqual(Object.keys(b.files), [
      "CLAUDE.md",
      "~/.coding.sh-plugins/terse/.claude-plugin/plugin.json",
      "~/.coding.sh-plugins/terse/hooks/hooks.json",
      "~/.coding.sh-plugins/terse/hooks/start.sh",
      "~/.coding.sh-plugins/terse/skills/grunt/SKILL.md",
    ]);
    assert.equal(await blobs.getText(b.files["~/.coding.sh-plugins/terse/hooks/start.sh"]!), PLUGIN["hooks/start.sh"]);
    assert.deepEqual(fingerprint(claudeDir), before, "the Claude config dir is byte-for-byte untouched");
  });

  it("reads the v1 shape, and fails clearly on unknown or ambiguous names", async () => {
    const claudeDir = await tree({});
    for (const d of ["p/a", "p/b", "plugins"]) await mkdir(join(claudeDir, d), { recursive: true });
    await writeFile(
      join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "lint@a": { installPath: join(claudeDir, "p", "a"), version: "1" }, "lint@b": { installPath: join(claudeDir, "p", "b") } } }),
    );
    assert.deepEqual(
      (await installedPlugins(claudeDir)).map((p) => [p.key, p.name, p.marketplace]),
      [
        ["lint@a", "lint", "a"],
        ["lint@b", "lint", "b"],
      ],
    );
    await assert.rejects(resolvePlugin("lint", { cwd: "/", claudeDir }), /plugin lint is ambiguous: lint@a, lint@b; name one as <name>@<marketplace>/);
    assert.equal((await resolvePlugin("lint@b", { cwd: "/", claudeDir })).dir, join(claudeDir, "p", "b"));
    await assert.rejects(resolvePlugin("nope", { cwd: "/", claudeDir }), /plugin nope is not installed \(installed: lint@a, lint@b\)/);
    await assert.rejects(resolvePlugin("nope", { cwd: "/", claudeDir: await tree({}) }), /no plugins are installed in /);
  });

  it("reads a plugin dir (relative to cwd), named by its manifest; a dir without one is refused", async () => {
    const parent = await tree({ "mine/.claude-plugin/plugin.json": JSON.stringify({ name: "tiny", version: "0.0.1" }), "mine/commands/hi.md": "hi\n", "bare/x.md": "x" });
    const r = await resolvePlugin("./mine", { cwd: parent, claudeDir: parent });
    assert.deepEqual(r, { name: "tiny", dir: join(parent, "mine"), version: "0.0.1" });
    await assert.rejects(resolvePlugin("./bare", { cwd: parent, claudeDir: parent }), /not a Claude Code plugin \(needs \.claude-plugin\/plugin\.json with a "name"\)/);
    await assert.rejects(resolvePlugin("./missing", { cwd: parent, claudeDir: parent }), /no such directory/);
    const stored = await storePlugin(r, new MemBlobs());
    assert.deepEqual(Object.keys(stored.files), ["~/.coding.sh-plugins/tiny/.claude-plugin/plugin.json", "~/.coding.sh-plugins/tiny/commands/hi.md"]);
  });

  it("harness.toml plugins = [...]: names from the config dir, dirs relative to the TOML", async () => {
    const { claudeDir } = await claudeDirWithTerse();
    const h = await tree({
      "CLAUDE.md": "rules\n",
      "plugins/mine/.claude-plugin/plugin.json": JSON.stringify({ name: "tiny" }),
      "plugins/mine/skills/s/SKILL.md": "s\n",
      "harness.toml": 'name = "t"\nagent = "claude-code"\ninclude = ["CLAUDE.md"]\nplugins = ["./plugins/mine", "terse@terse"]\n',
    });
    const b = await bundleFromToml(join(h, "harness.toml"), { blobs: new MemBlobs(), claudeDir });
    assert.deepEqual(
      b.plugins?.map((p) => p.name),
      ["terse", "tiny"],
    );
    assert.ok(b.files["~/.coding.sh-plugins/tiny/skills/s/SKILL.md"]);
    await writeFile(join(h, "bad.toml"), 'agent = "claude-code"\nplugins = "terse"\n');
    await assert.rejects(bundleFromToml(join(h, "bad.toml"), { blobs: new MemBlobs(), claudeDir }), /"plugins" must be an array of strings/);
    await writeFile(join(h, "codex.toml"), 'agent = "codex"\nplugins = ["terse"]\n');
    await assert.rejects(bundleFromToml(join(h, "codex.toml"), { blobs: new MemBlobs(), claudeDir }), /its agent is codex; only claude-code loads them/);
  });
});

describe("running a bundle with plugins", () => {
  let env: TmpEnv;
  beforeEach(() => {
    env = tmpEnv();
  });
  afterEach(() => env.restore());

  it("applyBundle writes plugins under the isolated home; overlayClaude adds --plugin-dir; the user's config is untouched", async () => {
    const { claudeDir } = await claudeDirWithTerse();
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const before = fingerprint(claudeDir);
    const blobs = new MemBlobs();
    const proj = await tree({ "CLAUDE.md": "rules\n" });
    const b = await bundleFromDir({ name: "with-terse", agent: "claude-code", dir: proj, include: ["CLAUDE.md"], blobs, plugins: ["terse"], claudeDir });

    const root = await tree({ "work/sum.js": "x\n" });
    const work = join(root, "work");
    const home = join(root, "home");
    const applied = await applyBundle(b, work, blobs, { home });
    assert.equal(applied.usesHome, false, "plugins alone don't make the run export HOME");
    const dir = join(home, ".coding.sh-plugins", "terse");
    assert.equal(readFileSync(join(dir, "hooks/start.sh"), "utf8"), PLUGIN["hooks/start.sh"]);
    if (!isWin) assert.ok((statSync(join(dir, "hooks/start.sh")).mode & 0o111) !== 0, "the hook script stays executable");
    assert.ok(existsSync(join(dir, "skills/grunt/SKILL.md")));
    assert.ok(!existsSync(join(dir, ".git")), ".git is not carried");
    assert.deepEqual(readdirSync(work).sort(), ["CLAUDE.md", "sum.js"], "nothing lands in the work dir");

    const o = await overlayClaude(b, work);
    assert.deepEqual(o.flags, ["--plugin-dir", dir]);
    assert.equal(o.env.CLAUDE_CONFIG_DIR, join(home, ".claude"));
    assert.deepEqual((await overlayClaude({ ...b, plugins: undefined }, work)).flags, []);
    assert.deepEqual(fingerprint(claudeDir), before, "the user's Claude config dir is byte-for-byte untouched");
  });

  it("a non-claude agent can't carry plugins", () => {
    assert.match(pluginProblem({ agent: "codex", plugins: [{ name: "terse" }] }) ?? "", /its agent is codex; only claude-code loads them/);
    assert.equal(pluginProblem({ agent: "claude-code", plugins: [{ name: "terse" }] }), undefined);
    assert.equal(pluginProblem({ agent: "codex" }), undefined);
  });
});

describe("--with / --without plugin:<name>", () => {
  async function base(blobs: MemBlobs): Promise<HarnessBundle> {
    const proj = await tree({ "CLAUDE.md": "rules\n", ".claude/skills/pdf/SKILL.md": "pdf\n" });
    return bundleFromDir({ name: "base", agent: "claude-code", dir: proj, include: ["CLAUDE.md", ".claude/**"], blobs, claudeDir: proj, now: 1 });
  }

  it("addPlugins derives <A>-with-plugin-<name>: A's files plus the plugin's, deterministic; the diff reads + plugin", async () => {
    const blobs = new MemBlobs();
    const A = await base(blobs);
    const dir = await tree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "tiny" }), "skills/t/SKILL.md": "t\n" });
    const stored = await storePlugin(await resolvePlugin(dir, { cwd: "/", claudeDir: dir }), blobs);
    const B = addPlugins(A, [stored], { now: 2 });
    assert.equal(B.name, "base-with-plugin-tiny");
    assert.equal(addPlugins(A, [stored], { now: 3 }).id, B.id);
    assert.deepEqual(B.plugins, [{ name: "tiny" }]);
    assert.deepEqual(Object.keys(B.files), [".claude/skills/pdf/SKILL.md","CLAUDE.md", "~/.coding.sh-plugins/tiny/.claude-plugin/plugin.json", "~/.coding.sh-plugins/tiny/skills/t/SKILL.md"]);
    const d = diffBundles(A, B);
    assert.deepEqual(d.files, { added: [], removed: [], changed: [] }, "plugin files are not listed one by one");
    assert.deepEqual(d.plugins, { added: ["tiny"], removed: [], changed: [] });
    assert.deepEqual(formatBundleDiff(d), ["+ plugin tiny"]);
    assert.equal(diffBundles(A, A).plugins, undefined);
    assert.equal(bundleItemChange(A, B), undefined, "a plugin is not one rule, skill or context file");
    assert.throws(() => addPlugins(B, [stored]), /already carries plugin tiny/);
    assert.throws(() => addPlugins({ ...A, agent: "codex" }, [stored]), /only claude-code loads them/);

    // A changed plugin reads as ~ plugin.
    await writeFile(join(dir, "skills/t/SKILL.md"), "t2\n");
    const B2 = addPlugins(A, [await storePlugin(await resolvePlugin(dir, { cwd: "/", claudeDir: dir }), blobs)]);
    assert.notEqual(B2.id, B.id);
    assert.deepEqual(formatBundleDiff(diffBundles(B, B2)), ["~ plugin tiny"]);
  });

  it("ablateBundle plugin:<name> drops the plugin and its files, not from the repo; an unknown plugin throws", async () => {
    const blobs = new MemBlobs();
    const A = await base(blobs);
    const dir = await tree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "tiny" }), "skills/t/SKILL.md": "t\n" });
    const B = addPlugins(A, [await storePlugin(await resolvePlugin(dir, { cwd: "/", claudeDir: dir }), blobs)]);
    const ab = ablateBundle(B, ["plugin:tiny"], { now: 1 });
    assert.equal(ab.bundle.name, "base-with-plugin-tiny-without-plugin-tiny");
    assert.deepEqual(ab.paths, ["plugin:tiny"]);
    assert.deepEqual(ab.plugins, ["tiny"]);
    assert.deepEqual(ab.dropped, ["~/.coding.sh-plugins/tiny/.claude-plugin/plugin.json", "~/.coding.sh-plugins/tiny/skills/t/SKILL.md"]);
    assert.deepEqual(ab.unmatched, []);
    assert.equal(ab.bundle.plugins, undefined);
    assert.deepEqual(ab.bundle.remove, [], "a plugin is not removed from the task's repo");
    assert.deepEqual(ab.bundle.files, A.files);
    assert.deepEqual(formatBundleDiff(diffBundles(B, ab.bundle)), ["- plugin tiny"]);
    assert.throws(() => ablateBundle(A, ["plugin:tiny"]), /bundle base has no plugin tiny; it carries no plugins/);
    // Mixed: a plugin and a path.
    const mixed = ablateBundle(B, ["plugin:tiny", ".claude/skills/pdf"]);
    assert.equal(mixed.bundle.name, "base-with-plugin-tiny-without-plugin-tiny-claude-skills-pdf");
    assert.deepEqual(mixed.bundle.remove, [".claude/skills/pdf"]);
  });
});
