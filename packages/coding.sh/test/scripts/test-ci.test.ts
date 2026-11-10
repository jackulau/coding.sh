import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = new URL("../../scripts/test-ci.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function run(files: Record<string, string>, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "test-ci-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const env: NodeJS.ProcessEnv = { ...process.env, SHARD: "", FLAKE_FLAG: join(dir, "flag") };
    delete env.NODE_TEST_CONTEXT; // else the inner node --test reports to this test run instead of its own stdout
    const r = spawnSync(process.execPath, [RUNNER, ...names], { cwd: dir, encoding: "utf8", env });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FLAKY = `import { it } from "node:test"; import { existsSync, writeFileSync } from "node:fs";
it("fails the first time only", () => { if (!existsSync(process.env.FLAKE_FLAG!)) { writeFileSync(process.env.FLAKE_FLAG!, "1"); throw new Error("under load"); } });`;
const BROKEN = `import { it } from "node:test"; it("always fails", () => { throw new Error("real"); });`;
const GREEN = `import { it } from "node:test"; it("passes", () => {});`;

describe("scripts/test-ci.mjs", () => {
  it("passes when a failed file passes alone, and says so as a warning", () => {
    const r = run({ "a.test.ts": FLAKY, "c.test.ts": GREEN }, ["a.test.ts", "c.test.ts"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning title=Passed when run alone::a\.test\.ts/);
  });

  it("fails when a file fails again alone", () => {
    const r = run({ "a.test.ts": FLAKY, "b.test.ts": BROKEN }, ["a.test.ts", "b.test.ts"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Rerunning b\.test\.ts alone/);
    assert.doesNotMatch(r.out, /::warning[^\n]*b\.test\.ts/);
  });

  it("does not rerun anything when every file passes", () => {
    const r = run({ "c.test.ts": GREEN }, ["c.test.ts"]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Rerunning/);
  });
});
