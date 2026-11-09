// `coding.sh eval trigger <skill> --draft` from the CLI: refuses to overwrite,
// and a model that answers without a draft is a clear error. Runs src/cli/main.ts
// with a temp HOME; no model is called (provider "mock").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-trigger-draft-")));
const home = join(root, "home");
const skill = join(root, "skills", "pdf");
mkdirSync(home);
mkdirSync(skill, { recursive: true });
writeFileSync(join(skill, "SKILL.md"), "---\nname: pdf\ndescription: Read and merge PDF files.\n---\n# PDF\n");
const env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: process.env.PATH ?? "", NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: root, encoding: "utf8", timeout: 60_000 });
after(() => rmSync(root, { recursive: true, force: true }));

describe("eval trigger --draft", () => {
  it("keeps an existing triggers.toml without --force (exit 2)", () => {
    const file = join(skill, "triggers.toml");
    writeFileSync(file, "# mine\n");
    const r = cli(["eval", "trigger", skill, "--draft", "mock", "--no-traces"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /triggers\.toml exists; pass --force/);
    assert.equal(readFileSync(file, "utf8"), "# mine\n");
    rmSync(file);
  });

  it("names the provider when its reply has no draft, after one retry", () => {
    const r = cli(["eval", "trigger", skill, "--draft", "mock", "--no-traces", "--dry-run"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Couldn't draft trigger prompts: mock mock: no JSON draft in 2 replies/);
  });
});
