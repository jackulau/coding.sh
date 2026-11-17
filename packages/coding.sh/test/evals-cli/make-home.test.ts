// evals/cli/fixtures/make-home.mjs builds the fixture home that the CLI suite and
// scripts/dogfood/cli-guidelines.mjs (cli.guidelines) run against. It has to build on
// every CI platform, Windows included: a PATH joined with ':' and a #!/bin/sh codex stub
// left git and codex unfound there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "../../scripts/bundle.mjs";

const MAKE_HOME = fileURLToPath(new URL("../../../../evals/cli/fixtures/make-home.mjs", import.meta.url));
const WIN = process.platform === "win32";

let root = "";
let CLI = "";

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-makehome-")));
  CLI = (await bundle(join(root, "dist"))).cli;
});
after(() => rmSync(root, { recursive: true, force: true }));

function makeHome(out: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [MAKE_HOME, "--seed", "1", "--out", out, "--cli", CLI, "--answers", join(out, "..", "answers.json")], {
    env: { ...env, CODING_SH_HOME: join(out, "home", ".coding.sh") },
    encoding: "utf8",
    timeout: 300_000,
  });
}

describe("make-home.mjs", () => {
  it("builds the fixture home on this platform", () => {
    const out = join(root, "a", "trial");
    const r = makeHome(out);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout) as { ok: boolean; sessions: number; events: number; answers: string };
    assert.equal(res.ok, true);
    assert.ok(res.sessions > 0, `sessions: ${res.sessions}`);
    assert.ok(res.events > 0, `events: ${res.events}`);

    const answers = JSON.parse(readFileSync(res.answers, "utf8")) as { env: Record<string, string>; doctor: { agent: string } };
    const dirs = answers.env.PATH!.split(delimiter);
    assert.equal(dirs[0], join(realpathSync(out), "fakebin"));
    assert.ok(dirs.includes(dirname(process.execPath)), answers.env.PATH);
    if (WIN) {
      assert.ok(!dirs.includes("/usr/bin"), answers.env.PATH);
      assert.ok(dirs.some((d) => existsSync(join(d, "git.exe")) || existsSync(join(d, "git.cmd"))), `no git on ${answers.env.PATH}`);
      for (const k of ["SystemRoot", "PATHEXT"]) assert.ok(answers.env[k], `${k} is passed`);
      assert.ok(existsSync(join(out, "fakebin", "codex.cmd")));
    } else assert.ok(dirs.includes("/usr/bin"), answers.env.PATH);
    assert.equal(answers.env.USERPROFILE, answers.env.HOME);

    // The codex stub runs on the fixture PATH: doctor sees Codex installed at the stub's version.
    const d = spawnSync(process.execPath, [CLI, "doctor", "--json"], { env: answers.env, cwd: out, encoding: "utf8", timeout: 60_000 });
    const codex = (JSON.parse(d.stdout) as { agents: { id: string; installed: boolean; version: string | null; hooked: boolean }[] }).agents.find((a) => a.id === answers.doctor.agent);
    assert.equal(codex?.installed, true, d.stdout);
    assert.equal(codex?.version, "0.166.0");
    assert.equal(codex?.hooked, false);
  });

  it("says why a command it runs failed to start", { skip: !WIN && "POSIX keeps /usr/bin on the fixture PATH" }, () => {
    // No git on PATH: spawnSync sets r.error (ENOENT) and leaves stderr empty.
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: dirname(process.execPath) };
    delete env.Path;
    const r = makeHome(join(root, "b", "trial"), env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /fixture: git init .* exited null: spawnSync git ENOENT/);
  });
});
