// Round 4 QA on the CLI: the status line's `today` counts subagents like its budget part, monitor
// messages (one colon, the right error for --run with --judge), list empty states that name the
// command that fills them, and one line per monitor error from ingest.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import * as budget from "../../src/cli/commands/budget.ts";
import * as dataset from "../../src/cli/commands/dataset.ts";
import * as exp from "../../src/cli/commands/exp.ts";
import * as ingest from "../../src/cli/commands/ingest.ts";
import * as monitor from "../../src/cli/commands/monitor.ts";
import * as workflows from "../../src/cli/commands/workflows.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";
import { MAIN } from "./_run-cli.ts";

const boxes: Sandbox[] = [];
after(() => {
  for (const b of boxes) b.cleanup();
});
const box = () => {
  const b = sandbox();
  boxes.push(b);
  return b;
};

const priced = (id: string, costUsd: number, extra: Parameters<typeof mkSession>[2] = {}) =>
  mkSession(id, Date.now() - 60_000, { ...extra, stats: { usage: { inputTokens: 200_000, outputTokens: 20_000, costUsd, estimatedCostUsd: costUsd } } });

describe("status line today", () => {
  test("counts subagent sessions, so the dollar figure and the budget percent on the line agree", async () => {
    const b = box();
    await b.seed([priced("top", 0.5), priced("sub", 0.4, { parent: { sessionId: "top", type: "Explore" } } as never)]);
    await runCmd(budget, b, { action: "set", positionals: ["day", "1"] });
    const run = (json: boolean) => spawnSync(process.execPath, ["--no-warnings", MAIN, "statusline", "--json"].slice(0, json ? 4 : 3), { env: b.env, input: "{}", encoding: "utf8", timeout: 30_000 });
    const text = run(false);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\$0\.90(?:00)? today/);
    assert.match(text.stdout, /budget 90%/);
    const j = JSON.parse(run(true).stdout);
    assert.equal(Math.round(j.todayCostUsd * 100), 90);
    const status = await runCmd(budget, b, { action: "status", json: true });
    assert.equal(Math.round(status.json.budgets[0].spendUsd * 100), Math.round(j.todayCostUsd * 100));
  });
});

describe("monitor messages", () => {
  test("monitor add with --run and --judge says they cannot go together", async () => {
    const r = await runCmd(monitor, box(), { action: "add", positionals: ["x"], flags: { run: "a", judge: "b" } });
    assert.equal(r.error?.exitCode ?? r.error?.code ?? 2, 2);
    assert.match(r.error?.message, /not both/);
    assert.doesNotMatch(r.error?.message, /needs one of/);
    const none = await runCmd(monitor, box(), { action: "add", positionals: ["x"] });
    assert.match(none.error?.message, /needs one of/);
  });

  test("monitor add's next step and monitor list's empty state end with one colon; the empty state is indented", async () => {
    const b = box();
    const empty = await runCmd(monitor, b, { action: "list" });
    assert.equal(empty.code, 0);
    assert.match(empty.stderr, /^ {2}No monitors yet$/m);
    assert.match(empty.stderr, /Score every new session with a command:\n/);
    const added = await runCmd(monitor, b, { action: "add", positionals: ["qa-x"], flags: { run: "node -e 1" } });
    assert.equal(added.code, 0, String(added.error?.message));
    assert.match(added.stderr, / {2}Score the past week now:\n/);
    assert.doesNotMatch(empty.stderr + added.stderr, /::/);
  });
});

describe("list empty states name the next step", () => {
  for (const [name, mod, cmd] of [
    ["workflows list", workflows, "coding.sh workflows import"],
    ["dataset list", dataset, "coding.sh dataset add"],
    ["exp list", exp, "coding.sh exp run"],
  ] as const) {
    test(name, async () => {
      const b = box();
      await b.seed([]);
      const r = await runCmd(mod as never, b, { action: "list", flags: { import: false } });
      assert.equal(r.error, undefined, String(r.error?.message));
      assert.match(r.stderr, new RegExp(`:\\n {4}${cmd.replace(/\./g, "\\.")}`));
    });
  }
});

describe("ingest prints each monitor error once", () => {
  test("under its summary row, and with --json only in monitors[] with no bare stderr line", async () => {
    const b = box();
    await b.seed([]);
    const rubric = join(b.root, "rubric.md");
    writeFileSync(rubric, "Score 1 when the session did what was asked.\n");
    const add = await runCmd(monitor, b, { action: "add", positionals: ["qa-judge"], flags: { judge: rubric } });
    assert.equal(add.code, 0, String(add.error?.message));
    // The monitor run's log went straight to process.stderr: catch what reaches it.
    let bare = "";
    const write = process.stderr.write;
    process.stderr.write = ((s: string | Uint8Array) => ((bare += String(s)), true)) as typeof process.stderr.write;
    let human: Awaited<ReturnType<typeof runCmd>>;
    let json: Awaited<ReturnType<typeof runCmd>>;
    try {
      human = await runCmd(ingest, b, {});
      json = await runCmd(ingest, b, { json: true });
    } finally {
      process.stderr.write = write;
    }
    assert.equal(human.error, undefined, String(human.error?.message));
    assert.match(human.stderr, /Monitor qa-jud/);
    assert.equal(human.stderr.split("no judge provider").length - 1 + (bare.split("no judge provider").length - 1), 2, "the row and one note: " + human.stderr + bare);
    assert.equal(json.json.monitors[0].error, "no judge provider");
    assert.doesNotMatch(bare, /monitor qa-judge/);
  });
});
