// `stats --scorecard` sets the window's models side by side: one column per model (or agent), one row
// per measure with its counts and a 95% interval, and with exactly two columns a DIFFERENCE column.
// It adds up the tallies the fold keeps per session (Session.stats.turnsByModel, edits, shells), so
// the store needs no events. core/scorecard.ts has the counting; this file has the command.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import * as stats from "../../src/cli/commands/stats.ts";
import { widerSince } from "../../src/cli/commands/stats-scorecard.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { paths } from "../../src/core/paths.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { collect, FIXTURES, testCtx, tmpEnv } from "../adapters/_helpers.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const DAY = 86_400_000;
const t = Date.now() - DAY;
/** n turn durations: step, 2 step, ... n step. */
const durations = (n: number, step: number) => Array.from({ length: n }, (_, i) => (i + 1) * step);
/** The TSV table off a TTY, as cells. A row keeps its empty last cell. */
const cells = (stdout: string) => stdout.replace(/\n$/, "").split("\n").map((line) => line.split("\t"));

const STORE: Session[] = [
  mkSession("a1", t, { model: "m-a", stats: { launch: "interactive", turnsByModel: { "m-a": { turns: 20, replied: 18, pushback: { undo: 2, broken: 1 }, cancelled: 1, durationsMs: durations(20, 1000) } }, edits: { calls: 30, failed: 3 }, shells: { calls: 40, failed: 4 } } }),
  mkSession("a2", t + 1, { model: "m-a", stats: { launch: "interactive", turnsByModel: { "m-a": { turns: 10, replied: 10, pushback: { intent: 1 }, durationsMs: durations(10, 3000) } }, shells: { calls: 10 } } }),
  mkSession("b1", t + 2, { agent: "codex", model: "m-b", stats: { launch: "interactive", turnsByModel: { "m-b": { turns: 12, replied: 11, pushback: { redo: 4, broken: 2 }, durationsMs: durations(12, 5000) } }, edits: { calls: 20, failed: 6 }, shells: { calls: 25, failed: 1 } } }),
  // A gemini-cli capture records no stopped turn: its turns stay out of the cancelled row.
  mkSession("b2", t + 3, { agent: "gemini-cli", model: "m-b", stats: { launch: "interactive", turnsByModel: { "m-b": { turns: 3, replied: 2, cancelNotRecorded: 3 } } } }),
  // A subagent's and a headless run's calls count in the tool rows; neither has turns.
  mkSession("a-sub", t + 4, { model: "m-a", parent: { sessionId: "a1", type: "Explore" }, stats: { launch: "interactive", edits: { calls: 5, failed: 1 } } }),
  mkSession("b-headless", t + 5, { agent: "codex", model: "m-b", stats: { launch: "headless", shells: { calls: 5, failed: 5 } } }),
  // A capture that does not say how it was launched, with nothing to count.
  mkSession("quiet", t + 6, { agent: "aider", model: "m-a" }),
  // Before the default 30-day window.
  mkSession("old", Date.now() - 40 * DAY, { model: "m-c", stats: { launch: "interactive", turnsByModel: { "m-c": { turns: 2 } } } }),
];

describe("stats --scorecard", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed(STORE);
  });
  after(() => sb.cleanup());

  const run = (flags: Record<string, string | boolean>, json = false) => runCmd(stats, sb, { flags: { scorecard: true, ...flags }, json });

  test("one column per model with counts and intervals, and the second minus the first beside two", async () => {
    const r = await run({});
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    assert.deepEqual(cells(r.stdout), [
      ["MEASURE", "m-a", "m-b", "DIFFERENCE"],
      ["Turns", "30", "15", ""],
      ["  sessions", "2", "2", ""],
      ["Pushback (4 kinds)", "14.3% (4/28)", "46.2% (6/13)", "+31.9pp"],
      ["  95% CI", "5.7% to 31.5%", "23.2% to 70.9%", "+3.2 to +58.0pp"],
      ["  sessions", "2", "2", ""],
      ["Pushback: intent", "3.6% (1/28)", "0.0% (0/13)", "no clear difference"],
      ["  95% CI", "0.6% to 17.7%", "0.0% to 22.8%", "-17.7 to +19.4pp"],
      ["Pushback: undo", "7.1% (2/28)", "0.0% (0/13)", "no clear difference"],
      ["  95% CI", "2.0% to 22.6%", "0.0% to 22.8%", "-22.6 to +16.2pp"],
      ["Pushback: redo", "0.0% (0/28)", "30.8% (4/13)", "+30.8pp"],
      ["  95% CI", "0.0% to 12.1%", "12.7% to 57.6%", "+9.0 to +57.6pp"],
      ["Pushback: broken", "3.6% (1/28)", "15.4% (2/13)", "no clear difference"],
      ["  95% CI", "0.6% to 17.7%", "4.3% to 42.2%", "-6.1 to +38.8pp"],
      // m-b's 3 gemini-cli turns are left out: 0 of its 12 codex turns.
      ["Cancelled turns", "3.3% (1/30)", "0.0% (0/12)", "no clear difference"],
      ["  95% CI", "0.6% to 16.7%", "0.0% to 24.2%", "-16.7 to +21.1pp"],
      ["  sessions", "2", "1", ""],
      ["Median turn", "12s (30)", "33s (12)", "+21s"],
      ["  95% CI", "8.0s to 16s", "15s to 50s", "+2.5s to +38s"],
      ["  quartiles", "6.3s to 18s", "19s to 46s", ""],
      ["  sessions", "2", "1", ""],
      // The subagent's edits count under its own model, the headless run's shell calls under its own.
      ["Failed file edits", "11.4% (4/35)", "30.0% (6/20)", "no clear difference"],
      ["  95% CI", "4.5% to 26.0%", "14.5% to 51.9%", "-2.6 to +41.5pp"],
      ["  sessions", "2", "1", ""],
      ["Failed shell commands", "8.0% (4/50)", "20.0% (6/30)", "no clear difference"],
      ["  95% CI", "3.2% to 18.8%", "9.5% to 37.3%", "-3.1 to +30.0pp"],
      ["  sessions", "2", "2", ""],
    ]);
    for (const note of [
      "DIFFERENCE is m-b minus m-a: percentage points for a rate, time for the median. Where its 95% interval includes 0 it says no clear difference.",
      "Turn rows count the turns of 4 top-level sessions launched interactively. They leave out 1 subagent session, 1 headless session and 1 aider session whose capture does not say how it was launched. Edit and shell rows count the calls of all 7 sessions, each under its own model.",
      "Cancelled turns leave out 3 turns of gemini-cli: those captures do not record a turn the person stopped.",
      "The intervals treat each turn and each call as independent.",
      "The models did different tasks, so a difference can come from the task mix. coding.sh compare runs two of them on the same tasks: https://coding.sh/docs/how-to/compare-models",
    ]) {
      assert.ok(r.stderr.includes(note), `${note}\n--- in ---\n${r.stderr}`);
    }
  });

  test("--json has the counts, the intervals and the difference", async () => {
    const j = (await run({}, true)).json;
    assert.equal(j.by, "model");
    assert.equal(j.sessions, 7);
    assert.equal(j.turnSessions, 4);
    assert.deepEqual(j.turnsLeftOut, { subagent: 1, headless: 1, launchUnknown: { aider: 1 } });
    assert.deepEqual(j.groups.map((g: { key: string }) => g.key), ["m-a", "m-b"]);
    const [a, b] = j.groups;
    assert.deepEqual(a.turns, { n: 30, sessions: 2 });
    assert.deepEqual([a.pushback.k, a.pushback.n, a.pushback.byKind.undo.k], [4, 28, 2]);
    assert.deepEqual(a.duration, { n: 30, sessions: 2, medianMs: 12_000, p25Ms: 6_250, p75Ms: 17_750, loMs: 8_000, hiMs: 16_000 });
    assert.deepEqual([a.edits.k, a.edits.n, a.edits.sessions], [4, 35, 2]);
    assert.deepEqual([b.cancelled.k, b.cancelled.n, b.cancelled.sessions, b.cancelled.lo], [0, 12, 1, 0]);
    assert.deepEqual(b.cancelNotRecorded, { "gemini-cli": 3 });
    assert.deepEqual([b.shells.k, b.shells.n, b.shells.sessions], [6, 30, 2]);
    assert.deepEqual([j.difference.a, j.difference.b], ["m-a", "m-b"]);
    assert.equal(j.difference.pushback.clear, true);
    assert.equal(j.difference.edits.clear, false);
    assert.ok(j.difference.edits.lo < 0 && j.difference.edits.hi > 0);
    assert.equal(j.window.since.slice(0, 2), "20");
    assert.equal("truncated" in j, false);
    assert.equal("refolding" in j, false);
  });

  test("by agent: three columns, no difference, and cancelled not recorded where the capture has none", async () => {
    const r = await run({ by: "agent" });
    const rows = cells(r.stdout);
    assert.deepEqual(rows[0], ["MEASURE", "claude-code", "codex", "gemini-cli"]);
    assert.deepEqual(rows.find((x) => x[0] === "Cancelled turns"), ["Cancelled turns", "3.3% (1/30)", "0.0% (0/12)", "not recorded"]);
    assert.deepEqual(rows.find((x) => x[0] === "Failed file edits"), ["Failed file edits", "11.4% (4/35)", "30.0% (6/20)", "-"]);
    assert.equal(r.stderr.includes("DIFFERENCE is"), false);
    assert.match(r.stderr, /each under its own agent\./);
    // The next step names the two busiest columns, and running it gives them a difference. sh gets
    // the query in single quotes, PowerShell and cmd in double quotes.
    const where = /stats --scorecard --by agent --where ['"](agent:claude-code OR agent:codex)['"]/.exec(r.stderr);
    assert.ok(where, r.stderr);
    const two = cells((await run({ by: "agent", where: where[1]! })).stdout);
    assert.deepEqual(two[0], ["MEASURE", "claude-code", "codex", "DIFFERENCE"]);
  });

  test("the cancelled note says why claude-code turns are left out, hook capture included", async () => {
    const own = sandbox();
    try {
      await own.seed([
        // One turn whose end its hooks have not seen, such as one still running.
        mkSession("h1", t, { model: "m-a", stats: { launch: "interactive", turnsByModel: { "m-a": { turns: 4, replied: 3, cancelled: 1, cancelNotRecorded: 1 } } } }),
        mkSession("g1", t + 1, { agent: "gemini-cli", model: "m-a", stats: { launch: "interactive", turnsByModel: { "m-a": { turns: 2, replied: 1, cancelNotRecorded: 2 } } } }),
      ]);
      const r = await runCmd(stats, own, { flags: { scorecard: true } });
      assert.deepEqual(cells(r.stdout).find((x) => x[0] === "Cancelled turns"), ["Cancelled turns", "33.3% (1/3)"]);
      const note = "Cancelled turns leave out 1 turn of claude-code and 2 turns of gemini-cli: those captures do not record a turn the person stopped. A claude-code turn is left out when it was captured in metadata mode or over OpenTelemetry, or when hooks have not seen it end, such as a turn still running.";
      assert.ok(r.stderr.includes(note), r.stderr);
      // Without claude-code turns the note gives no claude-code reasons.
      const other = await runCmd(stats, own, { flags: { scorecard: true, where: "agent:gemini-cli" } });
      assert.ok(other.stderr.includes("Cancelled turns leave out 2 turns of gemini-cli: those captures do not record a turn the person stopped.\n"), other.stderr);
    } finally {
      own.cleanup();
    }
  });

  test("honors the window and --where; --all changes nothing", async () => {
    const all = await run({ all: true });
    assert.equal(all.stdout, (await run({})).stdout);
    const old = cells((await run({ since: "60d", until: "20d" })).stdout);
    assert.deepEqual(old.slice(0, 2), [["MEASURE", "m-c"], ["Turns", "2"]]);
    assert.deepEqual(cells((await run({ since: "60d" })).stdout)[0], ["MEASURE", "m-a", "m-b", "m-c"]);
    assert.deepEqual(cells((await run({ where: "agent:codex" })).stdout)[0], ["MEASURE", "m-b"]);
  });

  test("the next step to two columns keeps the window and the query, and only when it leaves two", async () => {
    const r = await run({ since: "60d", where: "-agent:aider" });
    assert.deepEqual(cells(r.stdout)[0], ["MEASURE", "m-a", "m-b", "m-c"]);
    const next = /stats --scorecard --since 60d --where ['"](-agent:aider \(model:m-a OR model:m-b\))['"]/.exec(r.stderr);
    assert.ok(next, r.stderr);
    assert.deepEqual(cells((await run({ since: "60d", where: next[1]! })).stdout)[0], ["MEASURE", "m-a", "m-b", "DIFFERENCE"]);
    // model: matches a session's main model. A turn m-z ran in an m-a session keeps its column
    // under that query, so a next step would print the same three columns again.
    const switched = sandbox();
    try {
      await switched.seed([
        mkSession("s1", t, { model: "m-a", stats: { launch: "interactive", turnsByModel: { "m-a": { turns: 5 }, "m-z": { turns: 1 } } } }),
        mkSession("s2", t + 1, { model: "m-b", stats: { launch: "interactive", turnsByModel: { "m-b": { turns: 4 } } } }),
      ]);
      const three = await runCmd(stats, switched, { flags: { scorecard: true } });
      assert.deepEqual(cells(three.stdout)[0], ["MEASURE", "m-a", "m-b", "m-z"]);
      assert.equal(three.stderr.includes("Compare the first two columns"), false, three.stderr);
    } finally {
      switched.cleanup();
    }
  });

  test("a window with no interactive session has tool rows only, and says why", async () => {
    const r = await run({ where: "launch:headless" });
    assert.deepEqual(cells(r.stdout), [
      ["MEASURE", "m-b"],
      ["Failed shell commands", "100.0% (5/5)"],
      ["  95% CI", "56.6% to 100.0%"],
      ["  sessions", "1"],
    ]);
    assert.match(r.stderr, /No top-level session was launched interactively, so there are no turn rows: the window has 1 headless session\. Edit and shell rows count the calls of the one session, under its own model\./);
    // One column: nothing to compare, so no task-mix line.
    assert.equal(r.stderr.includes("did different tasks"), false);
    const quiet = await run({ where: "agent:aider" });
    assert.equal(quiet.stdout, "");
    assert.match(quiet.stderr, /The one session from \S+ to \S+ matching the query has no turn, file edit or shell command to count\./);
    assert.match(quiet.stderr, /the window has 1 aider session whose capture does not say how it was launched\./);
  });

  test("an empty window says so and names the next step, with the window as typed", async () => {
    const r = await run({ where: "model:nope" });
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /No sessions from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} matching the query/);
    assert.match(r.stderr, /Drop --where to see every session in the window:\n +\S+ stats --scorecard\n/);
    const j = (await run({ where: "model:nope" }, true)).json;
    assert.deepEqual([j.sessions, j.groups, j.difference], [0, [], undefined]);
    // Dropping --where keeps the window; widening it starts further back than the typed --since and keeps --until.
    const typed = await run({ since: "100d", until: "50d", where: "agent:codex" });
    assert.match(typed.stderr, /Drop --where to see every session in the window:\n +\S+ stats --scorecard --since 100d --until 50d\n/);
    const widen = await run({ since: "100d", until: "50d" });
    assert.match(widen.stderr, /No sessions from/);
    assert.match(widen.stderr, /Widen the window:\n +\S+ stats --scorecard --since 200d --until 50d\n/);
    assert.match((await run({ since: "7d", until: "2d", by: "agent" })).stderr, /Widen the window:\n +\S+ stats --scorecard --by agent --since 90d --until 2d\n/);
  });

  test("a wider --since starts 90 days back, or twice as far back as the window", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    assert.equal(widerSince(now - 30 * DAY, now), "90d");
    assert.equal(widerSince(now - 90 * DAY, now), "180d");
    // A few ms between parsing the flag and printing the step change nothing.
    assert.equal(widerSince(now - 100 * DAY - 5, now), "200d");
  });

  test("refuses flags with no meaning here", async () => {
    for (const [flags, message] of [
      [{ measure: "cost" }, /--measure does not work with --scorecard/],
      [{ per: "day" }, /--per does not work with --scorecard/],
      [{ by: "repo" }, /--by repo does not work with it/],
    ] as const) {
      const r = await run(flags);
      assert.match(String(r.error?.message), message);
      assert.equal(r.stdout, "");
    }
  });
});

describe("stats --scorecard on recorded captures", () => {
  let sb: Sandbox;
  before(async () => {
    const env = tmpEnv();
    let sessions: Session[];
    let events: AgentEvent[];
    try {
      process.env.CODEX_HOME = join(FIXTURES, "codex", "home");
      process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
      // As a backfill stores them (core/ingest.ts backfillEvent): source "transcript".
      const transcript = (xs: AgentEvent[]) => xs.map((e) => ({ ...e, source: e.source ?? "transcript" }));
      const rollout = transcript((await collect(codex.backfill!(testCtx().ctx))).filter((e) => e.sessionId === "0193cccc-1111-7222-8333-444455556666"));
      // The capture ran through the Agent SDK, so it is headless. Launched from a terminal it has turns.
      const claude = transcript(await collect(claudeCode.backfill!(testCtx().ctx))).map((e) => (e.kind === "session.start" ? { ...e, payload: { ...e.payload, entrypoint: "cli" } } : e));
      sessions = [buildSession(rollout), buildSession(claude)];
      events = [...rollout, ...claude];
    } finally {
      env.restore();
    }
    sb = sandbox();
    await sb.seed(sessions, events);
  });
  after(() => sb?.cleanup());

  test("a Claude Code session and a Codex rollout, one column per model", async () => {
    const r = await runCmd(stats, sb, { flags: { scorecard: true, since: "2020-01-01" } });
    assert.equal(r.error, undefined);
    const rows = cells(r.stdout);
    const row = (label: string) => rows.find((x) => x[0] === label);
    assert.deepEqual(rows[0], ["MEASURE", "claude-sonnet-4-5", "gpt-5", "DIFFERENCE"]);
    assert.deepEqual(row("Turns"), ["Turns", "2", "1", ""]);
    // The Codex turn has no reply after it, so there is no pushback to read.
    assert.deepEqual(row("Pushback (4 kinds)"), ["Pushback (4 kinds)", "0.0% (0/1)", "-", ""]);
    assert.deepEqual(row("Cancelled turns"), ["Cancelled turns", "0.0% (0/2)", "0.0% (0/1)", "no clear difference"]);
    assert.deepEqual(row("Median turn"), ["Median turn", "507ms (2)", "2.7s (1)", "no clear difference"]);
    // 1 of 1 against 0 of 4: Newcombe's interval (+6.7 to +100.0pp) leaves out 0, so the cell gives
    // the difference, and the counts beside it show how few calls it rests on.
    assert.deepEqual(row("Failed shell commands"), ["Failed shell commands", "0.0% (0/4)", "100.0% (1/1)", "+100.0pp"]);
    assert.equal(row("Failed file edits"), undefined);
    assert.match(r.stderr, /Turn rows count the turns of 2 top-level sessions launched interactively\. Edit and shell rows count the calls of both sessions, each under its own model\./);
  });
});

describe("stats --scorecard while coding.sh rebuilds its index after an update", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([
      // As an older coding.sh stored them: launched interactively, without the stats the scorecard adds up.
      mkSession("pre1", t, { model: "m-a", stats: { launch: "interactive" } }),
      mkSession("pre2", t + 1, { model: "m-a", stats: { launch: "interactive" } }),
      mkSession("new", t + 2, { model: "m-b", stats: { launch: "interactive", turnsByModel: { "m-b": { turns: 3, replied: 2 } }, shells: { calls: 4, failed: 1 } } }),
    ]);
  });
  after(() => sb.cleanup());

  const run = (flags: Record<string, string | boolean>, json = false) => runCmd(stats, sb, { flags: { scorecard: true, ...flags }, json });

  test("counts the interactive sessions with no turn recorded, and names them in the note", async () => {
    const r = await run({});
    assert.equal(r.error, undefined);
    assert.ok(r.stderr.includes("Turn rows count the turns of 1 top-level session launched interactively. They leave out 2 interactive sessions with no turn recorded."), r.stderr);
    assert.doesNotMatch(r.stderr, /rebuilding its index/);
    const j = (await run({}, true)).json;
    assert.deepEqual([j.turnSessions, j.turnsLeftOut], [1, { noTurns: 2 }]);
    const none = await run({ where: "model:m-a" });
    assert.equal(none.stdout, "");
    assert.match(none.stderr, /None of the 2 sessions .* has a turn, a file edit or a shell command to count\./);
    assert.match(none.stderr, /There are no turn rows: the window has 2 interactive sessions with no turn recorded\. Edit and shell rows count the calls of both sessions, each under its own model\./);
  });

  test("while a rebuild runs, the text says the counts are not all in and --json has refolding", async () => {
    const held = await acquireLock(paths(sb.env).reparseLock, { waitMs: 0 });
    try {
      const warning = /! coding\.sh is rebuilding its index after an update: a session it has not reached yet can have no turns, file edits or shell commands to count\. Run this again in a minute for the rest\./;
      const table = await run({});
      assert.notEqual(table.stdout, "");
      assert.match(table.stderr, warning);
      const none = await run({ where: "model:m-a" });
      assert.equal(none.stdout, "");
      assert.match(none.stderr, warning);
      assert.equal((await run({}, true)).json.refolding, true);
    } finally {
      held.release();
    }
    assert.equal("refolding" in (await run({}, true)).json, false);
  });
});
