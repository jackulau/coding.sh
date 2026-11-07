// `coding.sh refine protected|check` in a temp git repo with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-")));
after(() => rmSync(root, { recursive: true, force: true }));

const AGENTS = "# Rules\n\n- Never run `git push --force`.\n- Ask the owner before deleting anything under `prod/`.\n- Prefer small commits.\n";

function setup(name: string, git = true) {
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  writeFileSync(join(repo, "AGENTS.md"), AGENTS);
  if (git) {
    const g = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { home, repo, env, cli };
}

describe("cli refine", () => {
  it("protected lists auto, config and marker lines in plain text and JSON", () => {
    const e = setup("list");
    writeFileSync(join(e.repo, "AGENTS.md"), `${AGENTS}- Use pnpm.\n<!-- coding.sh:protect -->\nKeep answers short.\n<!-- coding.sh:protect end -->\n`);
    mkdirSync(join(e.home, ".coding.sh"), { recursive: true });
    writeFileSync(join(e.home, ".coding.sh", "config.toml"), '[refine]\nprotect = ["^Use pnpm"]\n');
    const t = e.cli("refine", "protected");
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^WHERE\s+WHY\s+LINE$/m);
    assert.match(t.stdout, /^AGENTS\.md:3\s+auto\s+Never run `git push --force`\.$/m);
    assert.match(t.stdout, /^AGENTS\.md:6\s+config\s+Use pnpm\.$/m);
    assert.match(t.stdout, /^AGENTS\.md:8\s+marker\s+Keep answers short\.$/m);
    assert.match(t.stderr, /4 protected lines in 1 file \(current files; auto-protect on, 1 pattern\)/);
    const j = JSON.parse(e.cli("refine", "protected", "--json").stdout) as { count: number; files: string[]; settings: { autoProtect: boolean; patterns: string[] }; lines: { why: string }[] };
    assert.equal(j.count, 4);
    assert.deepEqual(j.files, ["AGENTS.md"]);
    assert.deepEqual(j.settings.patterns, ["^Use pnpm"]);
    assert.deepEqual(
      j.lines.map((l) => l.why),
      ["auto", "auto", "config", "marker"],
    );
  });

  it("protected with nothing to protect says how to protect a line", () => {
    const e = setup("empty");
    writeFileSync(join(e.repo, "AGENTS.md"), "Prefer small commits.\n");
    const t = e.cli("refine", "protected");
    assert.equal(t.status, 0);
    assert.equal(t.stdout, "");
    assert.match(t.stderr, /No protected lines in 1 harness file/);
    assert.match(t.stderr, /coding\.sh:protect/);
  });

  it("check: no edits and a harmless edit pass; deleting or relaxing a protected line exits 1 until allowed", () => {
    const e = setup("check");
    const same = e.cli("refine", "check");
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stderr, /No changes from A \(git:HEAD\) to B \(your edits\); 2 protected lines in place/);

    writeFileSync(join(e.repo, "AGENTS.md"), `${AGENTS}- Run \`npm run check\` before finishing.\n`);
    const fine = e.cli("refine", "check");
    assert.equal(fine.status, 0, fine.stderr);
    assert.match(fine.stderr, /No protected line deleted, reworded or relaxed \(2 protected lines in A; git:HEAD -> your edits\)/);

    writeFileSync(join(e.repo, "AGENTS.md"), AGENTS.replace("- Never run `git push --force`.\n", "").replace("- Prefer small commits.\n", "- Prefer small commits.\n- Only ask the owner when the path is ambiguous.\n"));
    const bad = e.cli("refine", "check");
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, 'protected-line: AGENTS.md:3 "Never run `git push --force`." (auto)\nrelaxes-protected: "Only ask the owner when the path is ambiguous." vs AGENTS.md:4 (added at AGENTS.md:5)\n');
    assert.match(bad.stderr, /2 protected-line problems from A \(git:HEAD\) to B \(your edits\)/);
    assert.match(bad.stderr, /coding\.sh refine check --allow-protected-edit AGENTS\.md:3/);

    const j = e.cli("refine", "check", "--json");
    assert.equal(j.status, 1);
    const doc = JSON.parse(j.stdout) as { a: string; b: string; changed: boolean; ok: boolean; count: number; rejections: { critic: string }[] };
    assert.deepEqual(
      [doc.a, doc.b, doc.changed, doc.ok, doc.count],
      ["git:HEAD", "your edits", true, false, 2],
    );
    assert.deepEqual(
      doc.rejections.map((r) => r.critic),
      ["protected", "relaxes-protected"],
    );

    const ok = e.cli("refine", "check", "--allow-protected-edit", "AGENTS.md:3", "--allow-protected-edit", "AGENTS.md:4");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^allowed: protected-line: AGENTS\.md:3/m);
    assert.match(ok.stdout, /^allowed: relaxes-protected: /m);
  });

  it("check refuses a malformed override and needs --a/--b outside git", () => {
    const e = setup("usage");
    const bad = e.cli("refine", "check", "--allow-protected-edit", "AGENTS.md");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--allow-protected-edit: expected PATH:LINE/);

    const ng = setup("nogit", false);
    const r = ng.cli("refine", "check");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Not in a git repo: pass the two versions with --a and --b/);
    writeFileSync(join(ng.repo, "new.md"), "- Prefer small commits.\n");
    const files = ng.cli("refine", "check", "--a", "AGENTS.md", "--b", "new.md", "--json");
    assert.notEqual(files.status, 2, files.stderr);
  });

  it("a bad [refine] config is an error naming the file", () => {
    const e = setup("badcfg");
    mkdirSync(join(e.repo, ".coding.sh"), { recursive: true });
    writeFileSync(join(e.repo, ".coding.sh", "config.toml"), '[refine]\nprotect = ["(x"]\n');
    const r = e.cli("refine", "protected");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid regex/);
    assert.match(r.stderr, /config\.toml/);
  });
});
