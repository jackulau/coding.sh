// `coding.sh budget`: set, list, rm and status against a seeded store, through the CLI
// and in process, and the status line's `budget 82%` part.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import * as budget from "../../src/cli/commands/budget.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";
import { MAIN, runSync } from "./_run-cli.ts";

const boxes: Sandbox[] = [];
after(() => {
  for (const b of boxes) b.cleanup();
});
const box = () => {
  const b = sandbox();
  boxes.push(b);
  return b;
};

/** A session that started a minute ago with a cost the fold priced from tokens. */
const priced = (id: string, costUsd: number, extra: Parameters<typeof mkSession>[2] = {}) =>
  mkSession(id, Date.now() - 60_000, { ...extra, stats: { usage: { inputTokens: 200_000, outputTokens: 20_000, costUsd, estimatedCostUsd: costUsd } } });

describe("coding.sh budget status (CLI)", () => {
  test("priced sessions over $1 today against budget set day 1 report over", async () => {
    const b = box();
    await b.seed([priced("s1", 0.75), priced("s2", 0.5, { agent: "codex" })]);
    const set = runSync(["budget", "set", "day", "1", "--json"], b.env);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(set.stdout).budget.id, "day");
    const r = runSync(["budget", "status", "--json"], b.env);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.estimated, true);
    assert.match(doc.note, /estimated/);
    const [s] = doc.budgets;
    assert.equal(s.id, "day");
    assert.equal(s.spendUsd, 1.25);
    assert.equal(s.limitUsd, 1);
    assert.equal(s.percent, 125);
    assert.equal(s.over, true);
    assert.ok(Date.parse(s.resetsAt) > Date.now(), s.resetsAt);
    // The same total as `usage` over the window.
    const u = runSync(["usage", "--since", "today", "--json"], b.env);
    assert.equal(JSON.parse(u.stdout).total.costUsd, s.spendUsd);
  });
});

describe("coding.sh budget (in process)", () => {
  test("set, list, update, rm; budgets.json holds them", async () => {
    const b = box();
    let r = await runCmd(budget, b, { action: "set", positionals: ["week", "50"], flags: { agent: "codex" } });
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    assert.match(r.stderr + r.stdout, /week-codex/);
    r = await runCmd(budget, b, { action: "set", positionals: ["month", "$200"], flags: { repo: "." }, cwd: join(b.root, "web") });
    assert.equal(r.code, 0, String(r.error));
    r = await runCmd(budget, b, { action: "list", json: true });
    assert.deepEqual(r.json.budgets.map((x: { id: string }) => x.id), ["week-codex", "month-web"]);
    assert.equal(r.json.budgets[1].repo, join(b.root, "web"), "a repo path is stored absolute");
    r = await runCmd(budget, b, { action: "set", positionals: ["week", "75"], flags: { agent: "codex" }, json: true });
    assert.equal(r.json.outcome, "updated");
    r = await runCmd(budget, b, { action: "rm", positionals: ["month-web"] });
    assert.equal(r.code, 0);
    const file = JSON.parse(readFileSync(join(b.env.CODING_SH_HOME!, "budgets.json"), "utf8"));
    assert.deepEqual(file.budgets.map((x: { id: string; limitUsd: number }) => [x.id, x.limitUsd]), [["week-codex", 75]]);
  });

  test("a bad period, a bad amount and an unknown id are refused", async () => {
    const b = box();
    let r = await runCmd(budget, b, { action: "set", positionals: ["year", "5"] });
    assert.match(String(r.error?.message), /day, week, month/);
    assert.equal(r.error?.suggestion, undefined, "no near period to name");
    r = await runCmd(budget, b, { action: "set", positionals: ["dya", "20"] });
    assert.equal(r.error?.suggestion, "coding.sh budget set day 20", "a near miss names the period it meant");
    r = await runCmd(budget, b, { action: "set", positionals: ["wekk", "5"], flags: { agent: "codex" } });
    assert.equal(r.error?.suggestion, "coding.sh budget set week 5 --agent codex");
    r = await runCmd(budget, b, { action: "set", positionals: ["day", "-3"] });
    assert.match(String(r.error?.message), /USD amount/);
    r = await runCmd(budget, b, { action: "set", positionals: ["day", "0"] });
    assert.match(String(r.error?.message), /USD amount/);
    r = await runCmd(budget, b, { action: "rm", positionals: ["nope"] });
    assert.equal(r.error?.reason, "not_found");
  });

  test("status under the limit is not over, and an agent budget leaves other agents out", async () => {
    const b = box();
    await b.seed([priced("s1", 2), priced("s2", 0.25, { agent: "codex" })]);
    await runCmd(budget, b, { action: "set", positionals: ["day", "1"], flags: { agent: "codex" } });
    const r = await runCmd(budget, b, { action: "status", json: true });
    assert.equal(r.json.budgets[0].spendUsd, 0.25);
    assert.equal(r.json.budgets[0].over, false);
    const text = await runCmd(budget, b, { action: "status" });
    assert.match(text.stdout, /day-codex/);
    assert.match(text.stdout + text.stderr, /estimated/i);
  });

  test("a budget whose --where no longer parses shows its error, in text and --json, and the others still report", async () => {
    const b = box();
    await b.seed([priced("s1", 0.75)]);
    // A query stored before the grammar changed (budget set refuses it now).
    const budgets = [
      { id: "day", period: "day", limitUsd: 1, createdAt: 0 },
      { id: "day-w0ld000", period: "day", limitUsd: 5, where: "bogus:1", createdAt: 0 },
    ];
    writeFileSync(join(b.env.CODING_SH_HOME!, "budgets.json"), JSON.stringify({ budgets }));
    const r = await runCmd(budget, b, { action: "status", json: true });
    assert.equal(r.code, 1, String(r.error));
    const [day, bad] = r.json.budgets;
    assert.deepEqual([day.id, day.spendUsd, day.over], ["day", 0.75, false]);
    assert.equal(bad.id, "day-w0ld000");
    assert.equal(bad.where, "bogus:1");
    assert.equal(bad.error, '--where does not parse (unknown key "bogus")');
    assert.deepEqual([bad.spendUsd, bad.percent, bad.over, bad.sessions], [undefined, undefined, undefined, undefined], "no numbers for a spend that was not read");
    assert.ok(Date.parse(bad.resetsAt) > Date.now(), bad.resetsAt);
    const text = await runCmd(budget, b, { action: "status" });
    assert.equal(text.code, 1, String(text.error));
    assert.match(text.stdout, /^day\tday\tevery session\t~\$0\.7500\t\$1\.00\t75%\t/m);
    assert.match(text.stdout, /^day-w0ld000\tday\twhere bogus:1\t-\t\$5\.00\t-\t/m);
    assert.match(text.stderr, /Budget day-w0ld000 can't be read: --where does not parse \(unknown key "bogus"\)/);
    assert.match(text.stderr, /(?:coding\.sh|codingsh) budget rm day-w0ld000/);
  });

  test("status with no budgets says how to set one", async () => {
    const r = await runCmd(budget, box(), { action: "status" });
    assert.equal(r.code, 0);
    assert.match(r.stderr + r.stdout, /budget set day/);
  });
});

describe("status line budget part", () => {
  // The status line reads Claude Code's JSON on stdin, so it runs as a child process.
  const line = (b: Sandbox, json = false) => {
    const args = ["--no-warnings", MAIN, "statusline"];
    if (json) args.push("--json");
    const r = spawnSync(process.execPath, args, { env: b.env, input: "{}", encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  test("shows budget N% once the highest budget passes 80%, and not before", async () => {
    const b = box();
    await b.seed([priced("s1", 0.85)]);
    await runCmd(budget, b, { action: "set", positionals: ["day", "1"] });
    assert.match(line(b), /·  budget 85%\s*$/, "the part shows past 80%");
    assert.deepEqual(JSON.parse(line(b, true)).budget, { id: "day", percent: 85, over: false });
    await runCmd(budget, b, { action: "set", positionals: ["day", "2"] });
    assert.doesNotMatch(line(b), /budget/);
    assert.equal(JSON.parse(line(b, true)).budget, undefined);
  });
});
