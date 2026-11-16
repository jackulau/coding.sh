// test/_cli.ts picks the CLI every test launches. Unset, CODING_SH_TEST_CLI
// means src/cli/main.ts. Set, it means that file, and a value that names no
// file fails the import: a run must not report the bundle's speed for a suite
// that ran from source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { CLI, resolveCli, SOURCE_CLI, TEST_CLI_ENV } from "./_cli.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-test-cli-")));
after(() => rmSync(root, { recursive: true, force: true }));
const built = join(root, "dist", "cli.mjs");
mkdirSync(join(root, "dist"));
writeFileSync(built, "");
const missing = join(root, "gone", "cli.mjs");

/** Imports test/_cli.ts in a new process and prints its CLI. */
function importHelper(value: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, [TEST_CLI_ENV]: value };
  if (value === undefined) delete env[TEST_CLI_ENV];
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "_cli.ts")).href)}); process.stdout.write(m.CLI);`;
  return spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 60_000 });
}

describe("the CLI the tests launch (CODING_SH_TEST_CLI)", () => {
  it("is named CODING_SH_TEST_CLI", () => {
    assert.equal(TEST_CLI_ENV, "CODING_SH_TEST_CLI");
  });

  it("unset: src/cli/main.ts", () => {
    assert.equal(resolveCli({}), SOURCE_CLI);
    assert.ok(SOURCE_CLI.endsWith(["src", "cli", "main.ts"].join(sep)), SOURCE_CLI);
    assert.ok(existsSync(SOURCE_CLI));
  });

  it("set to a file that exists: that file", () => {
    assert.equal(resolveCli({ CODING_SH_TEST_CLI: built }), built);
  });

  it("set to a file that does not exist: throws, naming the variable and the path", () => {
    assert.throws(
      () => resolveCli({ CODING_SH_TEST_CLI: missing }),
      (e: Error) => e.message.includes("CODING_SH_TEST_CLI") && e.message.includes(missing) && /npm run build/.test(e.message),
    );
    assert.throws(() => resolveCli({ CODING_SH_TEST_CLI: join(root, "dist") }), /CODING_SH_TEST_CLI .*not a file/, "a directory is not a CLI");
  });

  it("set to a path that is not absolute, or to nothing: throws, and never means source", () => {
    for (const value of ["dist/cli.mjs", "./dist/cli.mjs", ""]) {
      assert.throws(
        () => resolveCli({ CODING_SH_TEST_CLI: value }),
        (e: Error) => e.message.includes("CODING_SH_TEST_CLI") && e.message.includes(JSON.stringify(value)) && /absolute/.test(e.message),
        JSON.stringify(value),
      );
    }
  });

  it("SOURCE_CLI stays src/cli/main.ts whatever the variable says", () => {
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "_cli.ts")).href)}); process.stdout.write(m.SOURCE_CLI);`],
      { env: { ...process.env, CODING_SH_TEST_CLI: built }, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, SOURCE_CLI);
  });

  it("this run launches what the variable says", () => {
    assert.equal(CLI, resolveCli(process.env));
  });
});

describe("importing the helper", () => {
  it("unset: CLI is src/cli/main.ts", () => {
    const r = importHelper(undefined);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, SOURCE_CLI);
  });

  it("set to a file that exists: CLI is that file", () => {
    const r = importHelper(built);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, built);
  });

  it("set to a file that does not exist: the import throws, so every test file that launches the CLI fails", () => {
    const r = importHelper(missing);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "", "no CLI was chosen");
    assert.ok(r.stderr.includes("CODING_SH_TEST_CLI"), r.stderr);
    assert.ok(r.stderr.includes(missing), r.stderr);
  });

  it("set to a relative path: the import throws", () => {
    const r = importHelper("dist/cli.mjs");
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /CODING_SH_TEST_CLI must be an absolute path/);
  });
});
