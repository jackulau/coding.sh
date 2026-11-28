import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { deserialize, serialize } from "node:v8";
import * as show from "../../src/cli/commands/show.ts";
import { buildSession, foldSession, isFoldState, sessionOf, sessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

let seq = 0;
const T0 = 1_760_000_000_000;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `ch${++seq}`,
  v: 0,
  sessionId: "ch-sess",
  ts: T0 + seq * 100,
  agent: "claude-code",
  cwd: "/work/demo",
  kind,
  payload,
  ...o,
});

const bash = (command: string, ok: boolean, output?: string): AgentEvent[] => {
  const id = `tu${seq + 1}`;
  const endPayload: Record<string, unknown> = { tool: "Bash", toolUseId: id, ok };
  if (output !== undefined) endPayload.output = output;
  return [
    ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }),
    ev("tool.end", endPayload),
  ];
};

const editCall = (path: string, oldStr: string, newStr: string, ok: boolean, output?: string): AgentEvent[] => {
  const id = `ed${seq + 1}`;
  const endPayload: Record<string, unknown> = { tool: "Edit", toolUseId: id, ok };
  if (output !== undefined) endPayload.output = output;
  return [
    ev("tool.start", { tool: "Edit", toolUseId: id, input: { file_path: path, old_string: oldStr, new_string: newStr } }),
    ev("tool.end", endPayload),
  ];
};

describe("stats.contextHygiene", () => {
  const sandboxes: Sandbox[] = [];
  after(() => {
    for (const sb of sandboxes) sb.cleanup();
  });

  it("omits stats.contextHygiene for a clean low-risk session", () => {
    const s = buildSession([
      ev("user.message", { text: "update readme" }),
      ...editCall("README.md", "old", "new", true),
      ...bash("npm test", true, "all passed"),
      ev("assistant.message", { text: "Done." }),
    ]);
    assert.equal(s.stats.contextHygiene, undefined);
    assert.equal("contextHygiene" in s.stats, false);
  });

  it("tracks post-compaction failed repeats across both commands and edits, and sets supervisionRisk", () => {
    const err1 = "error: build failed on module foo";
    const err2 = "old_string not found in src/a.ts";
    const events: AgentEvent[] = [
      ...bash("cargo   build", false, err1),
      ...editCall("src/a.ts", "missing()", "fixed()", false, err2),
      ...bash("ls", true, "src"),
      ev("context.compact", { trigger: "auto" }),
      // Repeats the same failed command (normalized whitespace) and same failed edit after compaction.
      ...bash("cargo build", false, err1),
      ...editCall("src/a.ts", "missing()", "fixed()", false, err2),
    ];
    const s = buildSession(events);
    assert.deepEqual(s.stats.contextHygiene, {
      compactions: 1,
      postCompactionFailedRepeats: 2,
      deadEndStreak: 2,
      failedOutputChars: (err1.length + err2.length) * 2,
      supervisionRisk: "medium",
      riskReasons: ["post-compaction-repeats"],
    });
  });

  it("tracks dead-end streaks (ignoring benign and interrupted failures) and records >= 2 only", () => {
    const oneFail = buildSession([
      ...bash("npm test", false, "FAIL"),
      ...bash("rg nonexistent src", false, ""), // benign no-match
      ...bash("npm test", true, "PASS"),
    ]);
    assert.equal(oneFail.stats.contextHygiene?.deadEndStreak, undefined);
    assert.equal(oneFail.stats.contextHygiene?.failedOutputChars, 4);
    assert.equal(oneFail.stats.contextHygiene?.supervisionRisk, undefined);

    const mediumLoop = buildSession([
      ...bash("cmd1", false, "err1"),
      ...bash("rg missing src", false, ""), // benign does not break or extend streak
      ...bash("cmd2", false, "err2"),
      ...bash("cmd3", false, "err3"),
      ...bash("cmd4", true, "ok"),
      ...bash("cmd5", false, "err5"),
    ]);
    assert.deepEqual(mediumLoop.stats.contextHygiene, {
      deadEndStreak: 3,
      failedOutputChars: 16,
      supervisionRisk: "medium",
      riskReasons: ["dead-end-loop"],
    });

    const highLoop = buildSession([
      ...bash("c1", false, "e1"),
      ...bash("c2", false, "e2"),
      ...bash("c3", false, "e3"),
      ...bash("c4", false, "e4"),
      ...bash("c5", false, "e5"),
    ]);
    assert.equal(highLoop.stats.contextHygiene?.deadEndStreak, 5);
    assert.equal(highLoop.stats.contextHygiene?.supervisionRisk, "high");
    assert.deepEqual(highLoop.stats.contextHygiene?.riskReasons, ["dead-end-loop"]);
  });

  it("escalates to high supervisionRisk when multiple medium reasons combine or compaction churn hits high", () => {
    const combined = buildSession([
      ...bash("npm test", false, "fail"),
      ev("context.compact", { trigger: "auto" }),
      ...bash("npm test", false, "fail"),
      ev("context.compact", { trigger: "auto" }),
    ]);
    assert.deepEqual(combined.stats.contextHygiene, {
      compactions: 2,
      postCompactionFailedRepeats: 1,
      deadEndStreak: 2,
      failedOutputChars: 8,
      supervisionRisk: "high",
      riskReasons: ["post-compaction-repeats", "compaction-churn"],
    });

    const unverifiedHigh = buildSession([
      ev("file.change", { path: "a.ts", op: "modify" }),
      ev("file.change", { path: "b.ts", op: "modify" }),
      ev("file.change", { path: "c.ts", op: "modify" }),
      ev("file.change", { path: "d.ts", op: "modify" }),
      ev("file.change", { path: "e.ts", op: "modify" }),
      ev("file.change", { path: "f.ts", op: "modify" }),
    ]);
    assert.deepEqual(unverifiedHigh.stats.contextHygiene, {
      supervisionRisk: "high",
      riskReasons: ["unverified-edits"],
    });
  });

  it("maintains full foldSession + serialized incremental fold parity", () => {
    const events: AgentEvent[] = [
      ev("session.start", {}),
      ...bash("cargo check", false, "error[E0308]: mismatched types"),
      ev("context.compact", { trigger: "auto" }),
      ...bash("cargo check", false, "error[E0308]: mismatched types"),
      ...bash("cargo check", false, "error[E0308]: mismatched types"),
      ...bash("cargo check", false, "error[E0308]: mismatched types"),
      ev("session.end", {}),
    ].map((e) => ({ ...e, sessionId: "parity-ch" }));

    const full = buildSession(events);
    const split = 4;
    const st = sessionState();
    for (const e of events.slice(0, split)) foldSession(st, e);
    const restored = deserialize(serialize(st));
    assert.equal(isFoldState(restored), true);
    for (const e of events.slice(split)) foldSession(restored, e);
    const incremental = sessionOf(restored);
    assert.deepEqual(incremental.stats.contextHygiene, full.stats.contextHygiene);
  });

  it("renders a Context row in `coding.sh show` only when supervisionRisk is medium or high", async () => {
    const sb = sandbox();
    sandboxes.push(sb);
    const riskyEvents = [
      ev("session.start", {}),
      ...bash("npm test", false, "fail 1"),
      ev("context.compact", { trigger: "auto" }),
      ...bash("npm test", false, "fail 1"),
      ev("context.compact", { trigger: "auto" }),
      ev("session.end", {}),
    ].map((e) => ({ ...e, sessionId: "show-risky" }));
    const lowRiskEvents = [
      ev("session.start", {}),
      ...bash("ls /missing", false, "ls: /missing: No such file"),
      ev("session.end", {}),
    ].map((e) => ({ ...e, sessionId: "show-low" }));

    await sb.seed([buildSession(riskyEvents), buildSession(lowRiskEvents)], [...riskyEvents, ...lowRiskEvents]);
    const riskyOut = await runCmd(show, sb, { positionals: ["show-risky"] });
    const ctxLines = riskyOut.stdout.split("\n").filter((l) => l.startsWith("  Context"));
    assert.equal(ctxLines.length, 1);
    assert.match(ctxLines[0]!, /high risk \(post-compaction-repeats, compaction-churn\); 2 compactions; 1 post-compaction repeat; dead-end streak 2/);

    const lowOut = await runCmd(show, sb, { positionals: ["show-low"] });
    assert.equal(lowOut.stdout.includes("  Context"), false, "low-risk session prints no Context row");
  });
});
