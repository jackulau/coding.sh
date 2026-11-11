// coding.sh score add and score list: the same value again keeps its comment,
// a run or case target must exist, an experiment target says what to score instead,
// and the empty and unknown-config cases name the next step.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { RunResult } from "../../src/core/types.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";

let env: TmpEnv;
const RUN: RunResult = { id: "run_01abc", taskId: "t1", bundleId: "b1", attempt: 1, pass: true, verifierExit: 0, agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, startedAt: 1, endedAt: 2 };

before(async () => {
  env = tmpEnv();
  await seed(env.dataHome, { sessions: [session("sess-aaaa1111")] });
  const store = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
  try {
    await store.putRun(RUN);
  } finally {
    await store.close();
  }
});
before(() => {
  ok(["dataset", "add", "ds", "--case", JSON.stringify({ id: "c1", input: "x" })]);
});
after(() => env.restore());

const json = (args: string[]) => JSON.parse(ok([...args, "--json"]).stdout);

describe("score targets and messages", () => {
  test("the same value again keeps the comment and says Unchanged", () => {
    ok(["score", "add", "case:c1", "correct", "true", "--comment", "x"]);
    const again = cli(["score", "add", "case:c1", "correct", "true"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /Unchanged/);
    const [s] = json(["score", "list", "--target", "case:c1"]).items as { comment?: string }[];
    assert.equal(s?.comment, "x");
  });

  test("run:<id> must name a stored run; a known one is scored", () => {
    const missing = cli(["score", "add", "run:does-not-exist", "human_preferred", "true"]);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /run not found: does-not-exist/);
    assert.equal(json(["score", "list", "--target", "run:does-not-exist"]).items.length, 0, "nothing stored");
    const known = json(["score", "add", `run:${RUN.id}`, "human_preferred", "true"]);
    assert.equal(known.score.targetId, RUN.id);
  });

  test("case:<id> must name a case in a dataset, as run:<id> must name a run", () => {
    const missing = cli(["score", "add", "case:c_nope", "quality", "5"]);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /case not found: c_nope/);
    assert.match(missing.stderr, /coding\.sh dataset list/);
    assert.equal(json(["score", "list", "--target", "case:c_nope"]).items.length, 0, "nothing stored");
  });

  test("exp:<id> is refused with what to score instead", () => {
    const r = cli(["score", "add", "exp:exp_123", "x", "1"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /run:<id>/);
    assert.doesNotMatch(r.stderr, /find session/i);
  });

  test("score list with filters that match nothing says so, and an unknown --config names score configs", () => {
    const none = ok(["score", "list", "--name", "no such"]);
    assert.match(none.stderr, /No scores match/);
    assert.match(none.stderr, /coding\.sh score list/);
    const bad = cli(["score", "add", "case:c1", "correct", "true", "--config", "nosuch"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /coding\.sh score configs/);
    assert.doesNotMatch(bad.stderr, /GET \/api/);
  });
});
