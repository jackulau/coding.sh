// A state assertion reads only the keys of its own form. `contains` on a
// command assertion means stdoutContains, and any other stray key is refused
// when the task loads, so the check cannot pass on exit 0 alone.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { runChecks } from "../../src/toolevals/checks.ts";
import { parseTask, ToolEvalsConfigError } from "../../src/toolevals/config.ts";
import { prepareSandbox } from "../../src/toolevals/sandbox.ts";
import { cleanup, cliTarget, tmp } from "./helpers.ts";

after(cleanup);

const load = (a: Record<string, unknown>) => parseTask({ id: "never", instruction: "list datasets", target: "fake", check: [{ kind: "state", assert: [a] }] }, "never.toml");
const refused = (a: Record<string, unknown>, re: RegExp) => assert.throws(() => load(a), (e: Error) => e instanceof ToolEvalsConfigError && re.test(e.message));

describe("state assertions", () => {
  it("reads contains on a command assertion as stdoutContains", () => {
    assert.deepEqual(load({ command: "echo hi", contains: "zzz" }).checks, [{ kind: "state", assert: [{ command: "echo hi", stdoutContains: "zzz" }] }]);
    assert.deepEqual(load({ command: "echo hi", stdoutContains: "zzz" }).checks, [{ kind: "state", assert: [{ command: "echo hi", stdoutContains: "zzz" }] }]);
    refused({ command: "echo hi", contains: "a", stdoutContains: "b" }, /both contains and stdoutContains/);
  });

  it("refuses a key the assertion does not read", () => {
    refused({ command: "echo hi", stdoutContain: "zzz" }, /command state assertion has unknown key "stdoutContain"/);
    refused({ command: "echo hi", regex: "zzz" }, /unknown key "regex"/);
    refused({ file: "out.txt", stdoutContains: "zzz" }, /file state assertion has unknown key "stdoutContains"/);
    refused({ file: "out.txt", command: "echo hi" }, /both file and command/);
    refused({ command: "echo hi", contains: 3 }, /contains must be a string/);
    refused({ file: "out.txt", exists: "yes" }, /exists must be true or false/);
    assert.deepEqual(load({ file: "out.txt", exists: true, contains: "a", regex: "b", jsonPath: "$.x", equals: 1 }).checks, [{ kind: "state", assert: [{ file: "out.txt", exists: true, contains: "a", regex: "b", jsonPath: "$.x", equals: 1 }] }]);
  });

  it("fails a command assertion whose stdout lacks contains, though the command exits 0", async () => {
    const t = { ...load({ command: "echo hi", contains: "zzz-never-present" }), target: "fake" };
    const sb = await prepareSandbox(t, cliTarget(), { name: "base" }, "trial_state", tmp());
    const [r] = await runChecks(t, sb, "");
    assert.equal(r!.pass, false);
    assert.match(r!.detail ?? "", /stdout lacks "zzz-never-present"/);
    const ok = { ...load({ command: "echo hi", contains: "hi" }), target: "fake" };
    assert.equal((await runChecks(ok, sb, ""))[0]!.pass, true);
  });
});
