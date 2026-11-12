// A calls check on a CLI called with no subcommand (`greet --name Ada`): the
// call is named by the bin, so `must = [{ tool = "greet" }]` can match it.
// Before, a root call had an empty tool name that no check could name.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { callsFromTap } from "../../src/toolevals/calls.ts";
import type { TapRecord } from "../../src/toolevals/types.ts";
import { validateToolTask } from "../../src/toolevals/validate.ts";
import { cleanup, cliTarget, task, tmp } from "./helpers.ts";

after(cleanup);

describe("calls check on a root CLI call", () => {
  it("names a root call by the bin, and keeps subcommands as they are", () => {
    const rec = (argv: string[]): TapRecord => ({ ts: argv.length, durationMs: 1, target: "cli", class: "ok", argv });
    const calls = callsFromTap([rec(["--name", "Ada"]), rec(["hello", "--name", "Bo", "x"])], "greet");
    assert.deepEqual(calls.map((c) => c.tool), ["greet", "hello"]);
    assert.equal(calls[0]!.args!.name, "Ada");
  });

  it("a root-call reference passes validate", async () => {
    const dir = tmp();
    const script = join(dir, "greet.mjs");
    writeFileSync(script, 'const i = process.argv.indexOf("--name");\nprocess.stdout.write(`hello ${i > 0 ? process.argv[i + 1] : "world"}\\n`);\n');
    const target = cliTarget({ bin: "greet", command: [process.execPath, script] });
    const t = task({ reference: ["greet --name Ada"], checks: [{ kind: "calls", must: [{ tool: "greet", args: { name: "Ada" } }] }] });
    const v = await validateToolTask(t, target, { root: tmp() });
    assert.equal(v.reference?.error, undefined);
    assert.deepEqual(v.reference?.checks, [{ kind: "calls", pass: true }]);
    assert.equal(v.ok, true, v.problems.join("; "));
  });
});
