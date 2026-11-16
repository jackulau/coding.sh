import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_START_LIMIT_MS, firstStart, firstStartArgs } from "../../scripts/warm-chrome.ts";
import { chromeArgs, findChrome } from "../viewer/browser.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/warm-chrome.ts", import.meta.url));
const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--no-warnings", SCRIPT], { encoding: "utf8", env, timeout: 120_000 });

test("the first start uses the tests' flags, and prints a page instead of staying open", () => {
  const args = firstStartArgs("/tmp/profile");
  const tests = chromeArgs("/tmp/profile");
  for (const flag of tests) {
    if (flag === "--remote-debugging-port=0" || flag === "about:blank") assert.ok(!args.includes(flag), flag);
    else assert.ok(args.includes(flag), flag);
  }
  assert.equal(args.length, tests.length);
  assert.equal(args.at(-2), "--dump-dom");
  assert.match(args.at(-1)!, /^data:text\/html,/);
});

test("a Chrome that is named and missing fails the step", () => {
  const r = run({ ...process.env, CODING_SH_TEST_CHROME: fileURLToPath(new URL("./no-such-chrome", import.meta.url)) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CODING_SH_TEST_CHROME=.*no-such-chrome does not exist/);
});

test("a first start past its limit is stopped and fails", { skip: process.platform === "win32" && "the stand-in for Chrome is a shell script" }, async () => {
  assert.equal(FIRST_START_LIMIT_MS, 60_000);
  const dir = mkdtempSync(join(tmpdir(), "csh-warm-test-"));
  try {
    const slow = join(dir, "chrome");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(slow, 0o755);
    const t0 = performance.now();
    await assert.rejects(firstStart(slow, 300), /Chrome's first start took longer than 300 ms and was stopped/);
    assert.ok(performance.now() - t0 < 10_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const chrome = findChrome();
test("starts Chrome twice and prints the three times", { skip: !chrome && "no Chrome installed" }, () => {
  const r = run(process.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^warm-chrome: first start \d+ ms, then a start in \d+ ms and a page in \d+ ms \(.+\)\n$/);
});
