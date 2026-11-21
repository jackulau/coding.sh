import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, findScript, MODES, notStarted, NO_SCRIPT, scoreCases } from "../cli-guidelines.mjs";
import { sh } from "../lib/util.mjs";

const TTY_MODES = Object.entries(MODES).filter(([, m]) => m.tty).map(([k]) => k);

/** A run that answers every case as the CLI would: exit 2 for the typo and the unknown flag, plain output elsewhere. */
function fakeRun(seen = []) {
  return (argv, mode) => {
    seen.push(mode);
    const spec = COMMANDS.find(([, a]) => a === argv)[2];
    const code = spec.expect ?? 0;
    const json = mode.json;
    const stdout = json && code === 0 ? "{}" : code === 0 ? "ok\n" : "";
    const stderr = code === 0 ? "" : json ? JSON.stringify({ error: "x", reason: spec.confirm ? "confirmation_required" : "usage" }) : spec.confirm ? "needs confirmation\n" : "unknown command\n";
    return { code, signal: null, stdout, stderr, ms: 5 };
  };
}

test("findScript: a spawn that fails with ENOENT means no script(1); one that starts means there is one", () => {
  const missing = findScript(() => ({ code: 1, signal: null, stdout: "", stderr: "", ms: 1, error: Object.assign(new Error("spawn script ENOENT"), { code: "ENOENT" }) }));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no script\(1\) on this machine to give the child a terminal \(ENOENT\)/);
  assert.deepEqual(findScript(() => ({ code: 0, signal: null, stdout: "", stderr: "", ms: 1 })), { ok: true });
});

test("scoreCases without script(1): the TTY modes are skipped with the reason and left out of the score", () => {
  const seen = [];
  const r = scoreCases({ run: fakeRun(seen), script: { ok: false, reason: NO_SCRIPT } });
  assert.ok(seen.every((m) => !m.tty), "no TTY case runs");
  assert.deepEqual(r.skipped, { modes: TTY_MODES, reason: NO_SCRIPT });
  const nonTty = Object.values(MODES).filter((m) => !m.tty).length;
  assert.equal(r.n, COMMANDS.length * nonTty);
  assert.equal(r.value, 1, JSON.stringify(r.failures));
  assert.deepEqual(r.scorerErrors, []);
});

test("scoreCases with script(1): the same cases as before, TTY modes included (Linux and macOS)", () => {
  const r = scoreCases({ run: fakeRun(), script: { ok: true } });
  const noTty = COMMANDS.filter(([, , s]) => s.noTty).length;
  assert.equal(r.n, COMMANDS.length * Object.keys(MODES).length - noTty * TTY_MODES.length);
  assert.equal(r.skipped, undefined);
  assert.equal(r.value, 1);
});

test("a process that did not start is a scorer error, never exit 1 or a failed rule", () => {
  const enoent = { code: 1, signal: null, stdout: "", stderr: "", ms: 1, error: Object.assign(new Error("spawn script ENOENT"), { code: "ENOENT" }) };
  const good = fakeRun();
  const run = (argv, mode) => (argv[0] === "sesions" && mode.tty ? enoent : good(argv, mode));
  const r = scoreCases({ run, script: { ok: true } });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.scorerErrors.map((e) => `${e.id}/${e.mode}`), TTY_MODES.map((m) => `typo-command/${m}`));
  assert.match(r.scorerErrors[0].error, /process did not start: ENOENT/);
  assert.equal(r.value, 1);
});

test("notStarted: a real spawn of a missing program is caught; an exit or a signal from the CLI is not", () => {
  const r = sh("cs-no-such-program-xyz", []);
  assert.equal(r.code, 1, "sh reports a failed spawn as exit 1, which is why the scorer must check");
  assert.match(notStarted(r), /ENOENT/);
  assert.equal(notStarted({ code: 1, signal: null }), undefined);
  assert.equal(notStarted({ code: 128, signal: "SIGTERM", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }), undefined);
  assert.match(notStarted({ code: 1, signal: null, status: null }), /no exit code and no signal/);
});
