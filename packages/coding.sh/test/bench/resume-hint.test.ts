// A bench run stopped by Ctrl-C says how to continue it: the error carries the
// full resume command with the run id, which the CLI prints as the next step.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { BenchRunError, runBench } from "../../src/bench/run.ts";
import { listRuns } from "../../src/bench/store.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

describe("bench run: the resume hint on an interrupt", () => {
  test("the error names the command that continues the saved run", async () => {
    const p = project();
    const ac = new AbortController();
    const err = await runBench({ def: p.def(), env: p.env, now: day("2026-11-04"), signal: ac.signal, onProgress: (done, _t, phase) => phase === "run" && done >= 3 && ac.abort() }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof BenchRunError);
    const [partial] = await listRuns("arith", p.env);
    assert.equal((err as BenchRunError & { resume?: string }).resume, `coding.sh bench run arith --resume ${partial!.id}`);
  });
});
