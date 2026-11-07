// `eval trigger` end to end through the CLI: a fake agent (the wrapper adapter
// running a script) prints Claude-style stream-json and calls the Skill tool for a
// skill whose installed description names a word in the prompt. The probes run
// in fresh dirs through the harness runner; the trace is the agent's stdout.
// Runs src/cli/main.ts with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { posixShell } from "../../src/core/spawn.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
let root = "";
let home = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = root) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}

const SPEC = `k = 1
[[should]]
prompt = "Fill in the pdf form"
[[should]]
prompt = "Merge these pdf pages"
[[should]]
prompt = "Make the invoice searchable"
[[should]]
prompt = "OCR this scanned invoice"
[[should_not]]
prompt = "Rename every txt file"
[[should_not]]
prompt = "Write a docx memo"
expect_skill = "docx"
[[should_not]]
prompt = "Explain in one line what a pdf is"
[[should_not]]
prompt = "Sort this list"
`;

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-trigger-cli-")));
  home = join(root, "home");
  for (const d of [home, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(dirname(process.execPath), dirname(gitBin), process.platform === "win32" ? dirname(posixShell() ?? "") : undefined, "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    CODING_SH_HOOK_SOURCE: join(root, "hook-source.mjs"),
  };
  writeFileSync(join(root, "hook-source.mjs"), "// test hook\n");
  // Loads the skill whose description ("Use when the user mentions a, b.") names a word of the prompt.
  writeFileSync(
    join(root, "agent.mjs"),
    `import { existsSync, readdirSync, readFileSync } from "node:fs";
const prompt = process.argv[process.argv.length - 1].toLowerCase();
const say = (o) => console.log(JSON.stringify(o));
const dir = ".agents/skills";
for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
  const md = readFileSync(dir + "/" + name + "/SKILL.md", "utf8");
  const words = (/mentions ([^.]*)\\./.exec(md)?.[1] ?? "").split(/,\\s*/).filter(Boolean);
  if (words.some((w) => prompt.includes(w))) { say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: name } }] } }); break; }
}
say({ type: "result", result: "done" });
`,
  );
  const skills = join(root, "skills");
  for (const [name, words] of [["pdf", "pdf"], ["docx", "docx, word"]] as const) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: Use when the user mentions ${words}.\n---\nBody.\n`);
  }
  writeFileSync(join(skills, "pdf", "triggers.toml"), SPEC);
  writeFileSync(join(root, "harness.toml"), `name = "fake"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = []\n`);
  const snap = cli(["harness", "snapshot", "--file", join(root, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Out {
  outcome: string;
  file: string;
  report: {
    arms: { label: string; raw: { tp: number; fp: number; tn: number; fn: number }; metrics: { f1: number }; errors: number; prompts: { expectHits?: number; expectSkill?: string }[] }[];
    delta?: { verdict: string; flips: { prompt: string; better: boolean }[]; regression: boolean };
  };
}

describe("eval trigger", () => {
  it("scores one arm: counts, sibling routes, the result file", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["eval", "trigger", "skills/pdf", "--harness", "fake", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as Out;
    const a = out.report.arms[0]!;
    assert.deepEqual(a.raw, { tp: 2, fp: 1, tn: 3, fn: 2 });
    assert.equal(a.errors, 0);
    assert.equal(a.prompts.find((p) => p.expectSkill === "docx")?.expectHits, 1, "the sibling docx is installed and takes its prompt");
    assert.ok(existsSync(out.file) && out.file.startsWith(join(home, ".coding.sh", "triggers", "pdf")), out.file);
    const text = cli(["eval", "trigger", "skills/pdf/SKILL.md", "--harness", "fake", "--yes", "--no-siblings"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /precision 67% {2}recall 50% {2}F1 0\.57/);
    assert.match(text.stderr + text.stdout, /no sibling skills/);
  });

  it("A/Bs a new description: recall rises, flips listed; --min-f1 sets the exit code", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["eval", "trigger", "skills/pdf", "--harness", "fake", "--description", "Use when the user mentions pdf, invoice.", "--fail-on", "regression", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as Out;
    const [a, b] = out.report.arms;
    assert.deepEqual([a!.raw.tp, b!.raw.tp, b!.raw.fp], [2, 4, 1]);
    assert.match(out.report.delta!.verdict, /^recall 2\/4→4\/4 · false triggers 1\/4→1\/4 · Δacc \+25 pp/);
    assert.deepEqual(out.report.delta!.flips.map((f) => [f.prompt, f.better]), [
      ["Make the invoice searchable", true],
      ["OCR this scanned invoice", true],
    ]);
    const low = cli(["eval", "trigger", "skills/pdf", "--harness", "fake", "--min-f1", "0.9", "-k", "1", "--yes"]);
    assert.equal(low.status, 1, low.stdout + low.stderr);
    assert.match(low.stderr, /F1 0\.\d+ is under --min-f1 0\.9/);
  });

  it("checks the spec and flags before running anything", (t) => {
    if (!gitBin) return t.skip("needs git");
    const bad = join(root, "bad.toml");
    writeFileSync(bad, SPEC.replace("k = 1", 'k = 1\nmodel = "x"'));
    const e1 = cli(["eval", "trigger", "skills/pdf", "--spec", bad, "--yes"]);
    assert.equal(e1.status, 2);
    assert.match(e1.stderr, /bad\.toml: model: unknown key/);
    const e2 = cli(["eval", "trigger", "skills/docx", "--yes"]);
    assert.equal(e2.status, 2);
    assert.match(e2.stderr, /No trigger spec at .*triggers\.toml/);
    assert.equal(cli(["eval", "trigger", "skills/pdf", "--fail-on", "regression", "--yes"]).status, 2);
    assert.equal(cli(["eval", "trigger", "skills/pdf", "--candidate", "skills/docx", "--description", "x", "--yes"]).status, 2);
    assert.equal(cli(["eval", "trigger", "skills/pdf", "--min-f1", "2", "--yes"]).status, 2);
    const consent = cli(["eval", "trigger", "skills/pdf", "--harness", "fake"]);
    assert.equal(consent.status, 2);
    assert.match(consent.stderr, /Run 8 agent sessions \(1 arm x 8 prompts x 1\) needs confirmation/);
    assert.equal(readdirSync(join(home, ".coding.sh", "triggers", "pdf")).length, 4, "no run, no new result file");
  });
});
