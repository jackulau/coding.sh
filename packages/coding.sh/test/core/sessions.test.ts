import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent, CostByTokenType, EventKind } from "../../src/schema/index.ts";
import { priceEvent, pricesFor } from "../../src/core/pricing.ts";
import {
  buildSession,
  detectFlags,
  FLAGS,
  isSyntheticPrompt,
  isVerifyCommand,
  latencyStats,
  percentile,
  rollupUsage,
  similarInputs,
  writesToolCallAsText,
} from "../../src/core/sessions.ts";

let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++t}`, v: 0, sessionId: "s", ts: 1000 + t * 10, agent: "codex", kind, payload, ...o,
});
const bash = (command: string, ok: boolean, id = `tu${t + 1}`) => [
  ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }),
  ev("tool.end", { tool: "Bash", toolUseId: id, ok }),
];

describe("buildSession", () => {
  it("counts failed model calls and keeps the first one's status and message", () => {
    const events = [
      ev("llm.call", { ok: true, statusCode: 200 }),
      ev("llm.call", { ok: false, statusCode: 429, error: "429 Rate limit reached " + "x".repeat(400) }),
      ev("llm.call", { statusCode: 500 }),
      ev("llm.call", { ok: false, error: "socket hang up" }),
      ev("llm.call", { ok: true, statusCode: "503" }),
    ];
    const s = buildSession(events);
    assert.equal(s.stats.llmErrors?.count, 3);
    assert.equal(s.stats.llmErrors?.statusCode, 429);
    assert.equal(s.stats.llmErrors?.error?.length, 300);
    assert.match(s.stats.llmErrors!.error!, /^429 Rate limit reached/);
    assert.equal(buildSession([ev("llm.call", { ok: true })]).stats.llmErrors, undefined, "unset when none failed");
  });

  it("counts API error events (429, 5xx) as failed model calls", () => {
    const events = [
      ev("error", { message: "Error 429 rate limit", source: "api", statusCode: 429, errorClass: "rate_limit" }),
      ev("error", { message: "Error 429 rate limit", source: "api", statusCode: 429, errorClass: "rate_limit" }),
      ev("error", { message: "stop failure" }),
    ];
    const s = buildSession(events);
    assert.equal(s.stats.llmErrors?.count, 2);
    assert.equal(s.stats.llmErrors?.statusCode, 429);
    assert.match(s.stats.llmErrors!.error!, /^Error 429/);
    assert.equal(buildSession([ev("error", { message: "stop failure" })]).stats.llmErrors, undefined);
  });

  it("folds stats, usage, title, files, tests and end time", () => {
    const long = "Please   fix\nthe bug " + "x".repeat(400);
    const events = [
      ev("session.start", {}, { cwd: "/w", repo: { root: "/w", head: "h", snapshot: "start-snap" }, agentVersion: "1.0" }),
      ev("user.message", { text: long }),
      ev("assistant.message", { text: "ok" }, { model: "m1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } }),
      ...bash("ls", true),
      ...bash("cat x", false),
      ev("file.change", { path: "a.ts", op: "modify" }),
      ev("file.change", { path: "a.ts", op: "modify" }),
      ev("file.change", { path: "b.ts", op: "add" }),
      ev("test.result", { passed: 3, failed: 1 }),
      ev("test.result", { passed: 4, failed: 0 }),
      ev("assistant.message", { text: "done" }, { model: "m2", usage: { inputTokens: 1, cacheReadTokens: 7 } }),
      ev("turn.end"),
      ev("session.end", {}, { repo: { root: "/w", head: "h", snapshot: "end-snap" } }),
    ];
    const s = buildSession([...events].reverse(), { id: "s", agent: "codex", startedAt: 0, stats: {} as never, flags: [], runId: undefined });
    assert.equal(s.id, "s");
    assert.equal(s.startedAt, events[0]!.ts, "events are sorted by ts");
    assert.equal(s.endedAt, events.at(-1)!.ts);
    assert.equal(s.title!.length, 280);
    assert.ok(s.title!.startsWith("Please fix the bug x"));
    assert.ok(s.title!.endsWith("…"));
    assert.equal(s.model, "m2");
    assert.equal(s.agentVersion, "1.0");
    assert.equal(s.cwd, "/w");
    assert.deepEqual(s.repo, { root: "/w", head: "h", snapshot: "start-snap" });
    assert.equal(s.endSnapshot, "end-snap");
    assert.deepEqual(s.stats, {
      events: events.length, turns: 1, toolCalls: 2, toolErrors: 1, filesChanged: 2, testsPassed: 4, testsFailed: 0,
      // `ls` searched; `cat x` failed with no error line naming x, so x still counts as read.
      retrieval: { reads: 1, filesRead: 1, editedAfterRead: 0, searches: 1, beforeFirstEdit: 2 },
      usage: { inputTokens: 11, outputTokens: 5, costUsd: 0.5, cacheReadTokens: 7 },
      latency: { wallMs: events.at(-1)!.ts - events[0]!.ts, toolMs: 20, toolP95Ms: 10 },
    });
    assert.deepEqual(s.flags, []);
  });

  it("marks an end taken from a transcript's last event as inferred, and a session.end as real", () => {
    const transcript = buildSession([ev("user.message", { text: "a" }, { source: "transcript" }), ev("assistant.message", { text: "b" }, { source: "transcript" })]);
    assert.equal(transcript.endedAt, transcript.startedAt + 10);
    assert.equal(transcript.stats.endInferred, true);
    const ended = buildSession([ev("user.message", { text: "a" }), ev("session.end")]);
    assert.notEqual(ended.endedAt, undefined);
    assert.equal(ended.stats.endInferred, undefined);
    assert.equal("endInferred" in buildSession([ev("user.message", { text: "a" })]).stats, false, "absent when there is no end");
  });

  it("gives no end to a transcript that stops on an open tool call, even after its quiet marker", () => {
    const tr = { source: "transcript" } as const;
    const start = () => [ev("user.message", { text: "a" }, tr), ev("tool.start", { tool: "Write", toolUseId: "w1" }, tr)];
    const open = buildSession(start());
    assert.equal(open.endedAt, undefined, "an unanswered call is not an end");
    assert.equal("endInferred" in open.stats, false);
    const quiet = buildSession([...start(), ev("session.end", { reason: "idle" }, tr)]);
    assert.equal(quiet.endedAt, undefined, "a transcript's quiet marker is not an end while a call is open");
    const answered = buildSession([...start(), ev("tool.end", { tool: "Write", toolUseId: "w1", ok: true }, tr), ev("session.end", { reason: "idle" }, tr)]);
    assert.notEqual(answered.endedAt, undefined);
    const inferred = buildSession([...start(), ev("tool.end", { tool: "Write", toolUseId: "w1", ok: true }, tr)]);
    assert.equal(inferred.stats.endInferred, true);
    const real = buildSession([ev("user.message", { text: "a" }), ev("tool.start", { tool: "Write", toolUseId: "w2" }), ev("session.end", { reason: "exit" })]);
    assert.notEqual(real.endedAt, undefined, "a real session.end ends it");
  });

  it("counts turns from prompts when there is no turn.end, and keeps prev-only fields", () => {
    const s = buildSession([ev("user.message", { text: "a" }), ev("user.message", { text: "b" })], {
      id: "s", agent: "codex", startedAt: 0, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [], endSnapshot: "kept", parent: { sessionId: "p" },
    });
    assert.equal(s.stats.turns, 2);
    assert.equal(s.endSnapshot, "kept");
    assert.deepEqual(s.parent, { sessionId: "p" });
    assert.equal(s.endedAt, undefined);
    assert.throws(() => buildSession([]), /at least one event/);
  });

  it("names the parent from a `<parent>:sub:<agentId>` id when there is no session.start", () => {
    const sid = "abc:sub:a1";
    const s = buildSession([
      ev("tool.start", { tool: "Bash", toolUseId: "x1", input: { command: "ls" } }, { sessionId: sid }),
      ev("tool.end", { tool: "Bash", toolUseId: "x1", ok: true }, { sessionId: sid }),
    ]);
    assert.deepEqual(s.parent, { sessionId: "abc", subagentId: "a1", type: "subagent" });
    assert.equal(buildSession([ev("tool.start", { tool: "Bash", toolUseId: "y", input: { command: "ls" } }, { sessionId: "plain" })]).parent, undefined);
  });

  it("a session.start parent wins over the id, before or after the tool events", () => {
    const sid = "abc:sub:a1";
    const start = ev("session.start", { parentSessionId: "real", subagentId: "a1", subagentType: "explore" }, { sessionId: sid });
    const tool = ev("tool.start", { tool: "Bash", toolUseId: "z", input: { command: "ls" } }, { sessionId: sid });
    const want = { sessionId: "real", subagentId: "a1", type: "explore" };
    assert.deepEqual(buildSession([start, tool]).parent, want);
    const late = { ...start, ts: tool.ts + 5 };
    assert.deepEqual(buildSession([tool, late]).parent, want);
  });

  it("takes the parent link from session.start", () => {
    const s = buildSession([ev("session.start", { parentSessionId: "p1", parentEventId: "e9", subagentId: "a1", subagentType: "explore" })]);
    assert.deepEqual(s.parent, { sessionId: "p1", eventId: "e9", subagentId: "a1", type: "explore" });
  });
});

describe("latencyStats", () => {
  it("aggregates llm calls, ttft, tool durations (derived when absent) and subagents", () => {
    const events = [
      ev("llm.call", { ok: true, ttftMs: 100 }, { ts: 0, durationMs: 1000 }),
      ev("llm.call", { ok: true, ttftMs: 300 }, { ts: 2000, durationMs: 3000 }),
      ev("llm.call", { ok: false }, { ts: 6000 }),
      ev("tool.start", { tool: "Bash", toolUseId: "a" }, { ts: 7000 }),
      ev("tool.end", { tool: "Bash", toolUseId: "a", ok: true }, { ts: 7500 }),
      ev("tool.end", { tool: "Read", toolUseId: "b", ok: true, durationMs: 40 }, { ts: 8000 }),
      ev("tool.end", { tool: "Read", toolUseId: "c", ok: true }, { ts: 8100, durationMs: 60 }),
      ev("subagent.start", { subagentId: "x" }, { ts: 9000 }),
      ev("subagent.start", { subagentId: "x" }, { ts: 9001 }),
      ev("subagent.start", {}, { ts: 9002, subagentId: "y" }),
    ];
    assert.deepEqual(latencyStats(events), {
      wallMs: 9002, llmCalls: 3, llmMs: 4000, llmP50Ms: 1000, llmP95Ms: 3000, ttftP50Ms: 100,
      toolMs: 600, toolP95Ms: 500, subagents: 2,
    });
    assert.deepEqual(latencyStats([]), {});
  });

  it("percentile uses nearest rank", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
    assert.equal(percentile([], 50), undefined);
  });
});

describe("failure detectors", () => {
  it("premature-completion: ends while failing, cleared by a later green run", () => {
    const failingEnd = [ev("test.result", { passed: 1, failed: 2 }), ev("turn.end")];
    assert.ok(detectFlags(failingEnd).includes(FLAGS.prematureCompletion));
    assert.ok(detectFlags([ev("test.result", { passed: 1, failed: 2 }), ev("session.end")]).includes(FLAGS.prematureCompletion));
    assert.ok(!detectFlags([...failingEnd, ev("user.message", { text: "fix" }), ev("test.result", { passed: 3, failed: 0 }), ev("turn.end")]).includes(FLAGS.prematureCompletion));
    assert.ok(!detectFlags([ev("test.result", { passed: 1, failed: 2 }), ev("test.result", { passed: 3, failed: 0 }), ev("turn.end")]).includes(FLAGS.prematureCompletion));
    assert.ok(!detectFlags([ev("test.result", { passed: 1, failed: 2 })]).includes(FLAGS.prematureCompletion), "still working");
  });

  it("premature-completion: an agent that says the tests still fail is not flagged; one that claims success or says nothing is", () => {
    const premature = (...events: AgentEvent[]) => detectFlags(events).includes(FLAGS.prematureCompletion);
    const red = () => ev("test.result", { passed: 3, failed: 2 });
    const say = (text: string) => ev("assistant.message", { text });
    assert.equal(premature(red(), say("2 tests still fail: test_a and test_b need the fixture."), ev("turn.end"), ev("session.end")), false);
    assert.equal(premature(red(), say("I couldn't get test_a to pass. How would you like to proceed?"), ev("turn.end")), false);
    assert.equal(premature(red(), say("Done: all tests pass."), ev("turn.end")), true, "claims success");
    assert.equal(premature(red(), ev("turn.end")), true, "silent end");
    assert.equal(premature(red(), say("Updated the README."), ev("turn.end")), true, "says nothing about the failure");
    // Text before a tool call is not what the agent said as it stopped.
    assert.equal(premature(red(), say("2 tests still fail; checking the fixture."), ev("tool.start", { tool: "Read", toolUseId: "r1" }), ev("turn.end")), true);
    // Once reported, a later end is flagged only if it claims success without a new run.
    const reported = [red(), say("test_a still fails."), ev("turn.end"), ev("user.message", { text: "thanks" })];
    assert.equal(premature(...reported, say("You're welcome."), ev("turn.end")), false);
    assert.equal(premature(...reported, say("Fixed it, all tests pass now."), ev("turn.end")), true);
    assert.equal(premature(...reported, red(), ev("turn.end")), true, "a new red run, then a silent end");
  });

  describe("premature-completion on the adapter fixtures", () => {
    const fixtures = join(import.meta.dirname, "..", "fixtures", "adapters");
    const session = (golden: string, id: string): AgentEvent[] =>
      (JSON.parse(readFileSync(join(fixtures, golden), "utf8")) as AgentEvent[]).filter((e) => e.sessionId === id).sort((a, b) => a.ts - b.ts);
    const premature = (events: AgentEvent[]) => detectFlags(events).includes(FLAGS.prematureCompletion);
    // The agent ends on a failing run and says so: "One test fails: test_div.", "One test still fails.", "TestSub still fails."
    const honest: [string, string][] = [
      ["codex/golden/backfill.golden.json", "0193cccc-1111-7222-8333-444455556666"],
      ["pi/golden/backfill.golden.json", "pi-sess-1"],
      ["goose/golden/backfill.golden.json", "20260921_1"],
    ];
    // The agent ends on a failing run and says it is done ("all tests pass", "Fixed add().") or says nothing.
    const flagged: [string, string][] = [
      ["claude-code/golden/backfill.golden.json", "11111111-2222-4333-8444-555555555555"],
      ["claude-code/golden/hooks.golden.json", "11111111-2222-4333-8444-555555555555"],
      ["codex/golden/hooks.golden.json", "0193aaaa-1111-7222-8333-444455556666"],
      ["cursor/golden/hooks.golden.json", "c0ffee00-1111-4222-8333-444455556666"],
      ["gemini-cli/golden/backfill.golden.json", "gem-sess-1"],
      ["opencode/golden/v2.golden.json", "ses_main"],
      ["copilot-cli/golden/backfill.golden.json", "cop-sess-1"],
      ["copilot-cli/golden/hooks.golden.json", "cop-sess-1"],
      ["droid/golden/hooks.golden.json", "droid-sess-1"],
      ["antigravity/golden/backfill.golden.json", "agy-conv-1"],
      ["wrapper/golden/wrapper.golden.json", "wrap-sess-1"],
    ];
    it("an honest failure report is not flagged", () => {
      for (const [g, id] of honest) assert.equal(premature(session(g, id)), false, `${g}: ${id}`);
    });
    it("a claim of success or a silent end while tests fail is flagged", () => {
      for (const [g, id] of flagged) assert.equal(premature(session(g, id)), true, `${g}: ${id}`);
    });
    it("the codex honest session with only its final text changed is flagged", () => {
      const events = session(...honest[0]!);
      const last = events.findLast((e) => e.kind === "assistant.message")!;
      assert.equal(last.payload.text, "One test fails: test_div.");
      const withText = (text: string) => events.map((e) => (e === last ? { ...e, payload: { ...e.payload, text } } : e));
      assert.equal(premature(withText("Done: test_div is fixed and all tests pass.")), true);
      assert.equal(premature(withText("Fixed the division.")), true);
      assert.equal(premature(events.filter((e) => e !== last)), true, "silent end");
      assert.equal(premature(withText("I couldn't get test_div to pass: the fixture returns None.")), false);
    });
  });

  it("repeated-tool-failure: 3 similar consecutive failures of one tool", () => {
    const stuck = [...bash("npm test -- --grep parser", false), ...bash("npm test -- --grep  parser", false), ev("tool.end", { tool: "Read", ok: true }), ...bash("npm test -- --grep parser", false)];
    assert.ok(detectFlags(stuck).includes(FLAGS.repeatedToolFailure), "other tools in between don't break the streak");
    const recovered = [...bash("npm test", false), ...bash("npm test", false), ...bash("npm test", true), ...bash("npm test", false)];
    assert.ok(!detectFlags(recovered).includes(FLAGS.repeatedToolFailure));
    const varied = [...bash("npm test", false), ...bash("cargo build --release", false), ...bash("ls -la /tmp/x", false)];
    assert.ok(!detectFlags(varied).includes(FLAGS.repeatedToolFailure));
    const noInput = [1, 2, 3].map(() => ev("tool.end", { tool: "Edit", ok: false }));
    assert.ok(detectFlags(noInput).includes(FLAGS.repeatedToolFailure));
    assert.ok(similarInputs("a b c d e", "a b c d f"));
    assert.ok(!similarInputs("a b", "c d"));
  });

  it("no-verification: files changed but nothing checked", () => {
    const changed = ev("file.change", { path: "a.ts" });
    assert.ok(detectFlags([changed]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([changed, ...bash("pnpm test", true)]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([changed, ev("test.result", { passed: 1, failed: 0 })]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([changed, ev("tool.start", { tool: "Bash", verify: true })]).includes(FLAGS.noVerification), "metadata-mode marker");
    assert.ok(detectFlags([changed, ...bash("git status", true)]).includes(FLAGS.noVerification));
    assert.ok(!detectFlags([...bash("ls", true)]).includes(FLAGS.noVerification), "no changes, no flag");
    for (const cmd of ["npm test", "npm run typecheck", "pytest -x tests/", "go test ./...", "cargo test", "npx tsc --noEmit", "node --test test/", "python -m pytest", "make check", "bun test", "vitest run"]) {
      assert.ok(isVerifyCommand(cmd), cmd);
    }
    for (const cmd of ["git diff", "cat test.txt", "ls tests", "echo testing"]) assert.ok(!isVerifyCommand(cmd), cmd);
  });

  it("compaction", () => {
    assert.deepEqual(detectFlags([ev("context.compact", { trigger: "auto" })]), [FLAGS.compaction]);
  });

  it("api-stall: repeated rate-limit or overload errors, long retry waits, retries run out, or a last error never got past", () => {
    // Claude Code's system/api_error lines (claude-transcript.ts apiError).
    const retry = (statusCode: number, retryAttempt: number, extra: Record<string, unknown> = {}) =>
      ev("error", { message: `${statusCode} rate limit`, source: "api", statusCode, errorClass: statusCode === 429 ? "rate_limit" : "overloaded", retryAfterMs: 1000, retryAttempt, maxRetries: 10, ...extra });
    const reply = () => ev("assistant.message", { text: "done" });
    // A session whose only failures are 429s.
    const only429 = [ev("user.message", { text: "fix it" }), retry(429, 1), retry(429, 2), retry(429, 3), reply()];
    assert.deepEqual(buildSession(only429).flags, [FLAGS.apiStall]);
    assert.equal(buildSession(only429).stats.llmErrors?.count, 3);
    assert.deepEqual(detectFlags([retry(429, 1), reply(), retry(529, 1), reply(), retry(529, 2), reply()]), [FLAGS.apiStall], "a 529 counts with 429s");
    assert.deepEqual(detectFlags([retry(429, 1), reply()]), [], "one 429 a retry got past");
    assert.deepEqual(detectFlags([retry(429, 1), reply(), retry(429, 1), reply()]), [], "two, each got past");
    assert.deepEqual(detectFlags([retry(429, 1, { retryAfterMs: 90_000 }), reply()]), [FLAGS.apiStall], "a long wait");
    assert.deepEqual(detectFlags([retry(429, 10), reply()]), [FLAGS.apiStall], "the last retry allowed");
    // The turn ended on it: Claude Code's surfaced API Error message, a Codex usage_limit_exceeded turn failure.
    assert.deepEqual(detectFlags([reply(), ev("error", { message: "API Error: Rate limit reached", source: "api" })]), [FLAGS.apiStall]);
    assert.deepEqual(detectFlags([ev("error", { message: "limit", source: "api", errorType: "usage_limit_exceeded", errorClass: "rate_limit" })]), [FLAGS.apiStall]);
    // Proxy or OTel model calls that failed, then one that worked.
    const call = (p: Record<string, unknown>) => ev("llm.call", p);
    assert.deepEqual(detectFlags([call({ ok: false, statusCode: 429 }), call({ ok: true })]), []);
    assert.deepEqual(detectFlags([call({ ok: false, statusCode: 429 }), call({ ok: false, statusCode: 429 }), call({ ok: false, statusCode: 529 }), call({ ok: true })]), [FLAGS.apiStall]);
    // Not capacity: a bad request, a 500, an auth error, a refusal message. No api-stall; the last one
    // was never got past, so llm-error.
    assert.deepEqual(detectFlags([call({ ok: false, statusCode: 400 }), call({ ok: false, statusCode: 500 }), call({ ok: false, statusCode: 401 }), call({ ok: false, statusCode: 500 })]), [FLAGS.llmError]);
    assert.deepEqual(detectFlags([call({ ok: false, statusCode: 500 }), call({ ok: true })]), [], "a 500 a later call got past");
    assert.deepEqual(detectFlags([ev("error", { message: "Claude Code can't respond to this message", source: "api" })]), [FLAGS.llmError]);
    assert.deepEqual(detectFlags([ev("error", { message: "stop hook failed: rate limit" })]), [], "not an API error");
  });

  it("filesChanged counts files a shell call writes, keyed with edit-tool paths", () => {
    const cwd = "/work/demo";
    const at = { cwd };
    const sh = (command: string, ok = true, extra: Record<string, unknown> = {}, tool = "Bash") => {
      const id = `tu${t + 1}`;
      return [ev("tool.start", { tool, toolUseId: id, input: { command } }, at), ev("tool.end", { tool, toolUseId: id, ok, ...extra }, at)];
    };
    const files = (events: AgentEvent[]) => buildSession(events).stats.filesChanged;
    assert.equal(files(sh("sed -i 's/a/b/' src/a.ts")), 1);
    assert.equal(files(sh("cat > src/new.ts <<'EOF'\nconst x = 1; // > not/a/file.ts\nEOF")), 1, "a heredoc to a file; its body is data");
    assert.equal(files(sh("printf 'x' > out.txt && echo y >> log/run.log")), 2);
    assert.equal(files(sh("echo x | tee a.txt b.txt > /dev/null 2>&1")), 2, "tee, not /dev/null or a fd dup");
    assert.equal(files(sh("perl -pi -e 's/a/b/' lib/x.pm")), 1);
    assert.equal(files(sh("cp a.ts b.ts && mv c.ts d.ts")), 2, "the targets of cp and mv");
    assert.equal(files(sh("Set-Content -Path notes.txt -Value 'hi'; 'x' | Out-File -FilePath out\\log.txt; Add-Content c.md 'y'", true, {}, "PowerShell")), 3);
    assert.equal(files(sh("Get-Content a.txt > copy.txt", true, {}, "PowerShell")), 1);
    // Reads, deletes, scratch files, globs, variables and branches do not count.
    assert.equal(files(sh("cat src/a.ts && grep -r foo src > /dev/null; sed -n 1,5p b.ts; head c.ts")), 0);
    assert.equal(files(sh("rm -rf dist/out.js")), 0);
    assert.equal(files(sh("npm test > /tmp/test.log 2>&1; echo x > ~/.bashrc")), 0, "outside the working directory");
    assert.equal(files(sh('sed -i s/a/b/ src/*.ts; echo x > "$OUT"; echo y > $HOME/z.txt')), 0);
    assert.equal(files(sh("git checkout feature/x")), 0, "a branch name");
    assert.equal(files(sh("git checkout -- src/a.ts")), 1, "a file after --");
    // A call the user turned down never ran; one that ran and failed still wrote.
    assert.equal(files(sh("sed -i 's/a/b/' a.ts", false, { output: "The user doesn't want to proceed with this tool use." })), 0);
    assert.equal(files(sh("echo x > a.txt && npm test", false, { output: "Exit code 1\n1 failing" })), 1);
    // Not a shell tool: an MCP tool with a `command` field.
    assert.equal(files([ev("tool.start", { tool: "mcp__x__run", toolUseId: "m1", input: { command: "echo x > a.txt" } }, at), ev("tool.end", { tool: "mcp__x__run", toolUseId: "m1", ok: true }, at)]), 0);
    // A file edited through Edit and through Bash counts once, absolute or relative, ./ or not.
    const both = [
      ev("file.change", { path: "src/a.ts", op: "modify" }, at),
      ...sh("sed -i 's/x/y/' ./src/a.ts && echo z > /work/demo/src/b.ts"),
      ev("file.change", { path: "/work/demo/src/b.ts", op: "modify" }, at),
      ...sh("cd src && echo q >> a.ts"),
    ];
    assert.equal(files(both), 2);
    // Codex: the call's workdir.
    assert.equal(files([ev("tool.start", { tool: "exec_command", toolUseId: "c1", input: { cmd: "echo x > a.txt", workdir: "/work/demo/pkg" } }, at), ev("tool.end", { tool: "exec_command", toolUseId: "c1", ok: true }, at)]), 1);
    // A started call with no end yet does not count; one with no id counts as it starts.
    assert.equal(files([ev("tool.start", { tool: "Bash", toolUseId: "open", input: { command: "echo x > a.txt" } }, at)]), 0);
    assert.equal(files([ev("tool.start", { tool: "Bash", input: { command: "echo x > a.txt" } }, at)]), 1);
  });

  it("filesChanged counts a file named the Git Bash way (/c/x) and the Windows way once", () => {
    const at = { cwd: "C:\\work\\demo" };
    const sh = (id: string, command: string) => [ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }, at), ev("tool.end", { tool: "Bash", toolUseId: id, ok: true }, at)];
    const files = (events: AgentEvent[]) => buildSession(events).stats.filesChanged;
    const both = [
      ev("file.change", { path: "C:\\work\\demo\\src\\a.ts", op: "modify" }, at),
      ...sh("g1", "sed -i 's/x/y/' /c/work/demo/src/a.ts && echo z > /c/work/demo/src/b.ts"),
      ev("file.change", { path: "/c/work/demo/src/a.ts", op: "modify" }, at),
      ev("file.change", { path: "c:/work/demo/src/a.ts", op: "modify" }, at),
    ];
    assert.equal(files(both), 2, "src/a.ts three ways, and src/b.ts the shell call wrote");
    assert.equal(files(sh("g2", "echo x > /c/other/a.txt; echo y > /c")), 0, "outside the working directory, and a drive");
    assert.equal(files([ev("file.change", { path: "/c/work/demo/a.ts", op: "modify" }, { cwd: "/work/demo" }), ev("file.change", { path: "a.ts", op: "modify" }, { cwd: "/work/demo" })]), 2, "in a POSIX folder, /c is a folder, not a drive");
  });

  it("text-tool-call: a tool call written out as text, not markup quoted in a code block or in prose", () => {
    const say = (text: string) => detectFlags([ev("assistant.message", { text }, { agent: "claude-code" })]);
    // What a Claude Code subagent with a map-form `tools:` wrote, its calls never run.
    assert.deepEqual(say('I\'ll read it first.\n\n\n<invoke name="Read">\n<parameter name="file_path">/work/demo/README.md</parameter>\n</invoke>\n'), [FLAGS.textToolCall]);
    assert.deepEqual(say('<invoke name="mcp__docs__search"></invoke>'), [FLAGS.textToolCall]);
    assert.deepEqual(say('Calls look like this:\n```xml\n<invoke name="Read">\n<parameter name="file_path">a.ts</parameter>\n</invoke>\n```'), [], "fenced");
    assert.deepEqual(say('The subagent wrote `<invoke name="Read">` as text.'), [], "mid-line, in prose");
    assert.deepEqual(say('<invoke name="Read"> is the markup it used'), [], "no parameter or close after it");
    assert.ok(writesToolCallAsText('  <invoke name="Bash">\n  <parameter name="command">ls</parameter>'));
  });

  it("test-tamper: a test edit that alone turns a failing run green", () => {
    const tamper = [
      ev("test.result", { passed: 1, failed: 1 }),
      ev("tool.start", { tool: "Edit", toolUseId: "tx", input: { file_path: "tests/sum.test.js" } }),
      ev("file.change", { path: "tests/sum.test.js", op: "modify", toolUseId: "tx", diff: "-  assert.equal(sum(2, 2), 4);\n+  assert.ok(true);" }),
      ev("tool.end", { tool: "Edit", toolUseId: "tx", ok: true }),
      ev("test.result", { passed: 2, failed: 0 }),
    ];
    assert.ok(detectFlags(tamper).includes(FLAGS.testTamper));
    assert.ok(!detectFlags(tamper.slice(1)).includes(FLAGS.testTamper), "no failing run before, nothing flipped");
  });
});

describe("OTel session ends and traceIds", () => {
  const ev = (id: string, sessionId: string, traceId: string, kind: EventKind, ts: number, durationMs?: number): AgentEvent => ({
    id,
    v: 0,
    sessionId,
    ts,
    agent: "x",
    kind,
    traceId,
    source: "otel-span",
    payload: {},
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  it("conversation-keyed sessions end at the last activity and collect their traces", () => {
    const s = buildSession([ev("a", "conv-1", "t1", "llm.call", 1000, 500), ev("b", "conv-1", "t2", "llm.call", 5000, 250)]);
    assert.equal(s.endedAt, 5250);
    assert.deepEqual(s.traceIds, ["t1", "t2"]);
  });
  it("trace-keyed sessions stay open until the root span's session.end", () => {
    assert.equal(buildSession([ev("a", "t1", "t1", "llm.call", 1000, 500)]).endedAt, undefined);
    assert.equal(buildSession([ev("a", "t1", "t1", "llm.call", 1000, 500), ev("b", "t1", "t1", "session.end", 2000)]).endedAt, 2000);
  });
  it("hook sessions never infer an end", () => {
    const s = buildSession([{ ...ev("a", "conv-1", "t1", "llm.call", 1000, 500), source: "hook" }]);
    assert.equal(s.endedAt, undefined);
  });
});

describe("session duration (QA regressions)", () => {
  const otel = (o: Partial<AgentEvent> & Pick<AgentEvent, "id" | "kind" | "ts">, sessionId = "qa-dup-1"): AgentEvent => ({
    v: 0, sessionId, agent: "x", traceId: "t1", source: "otel-span", payload: {}, ...o,
  });

  it("does not count a span's length twice: *.end events are stamped at the end", () => {
    // One 1.5 s chat span keyed by gen_ai.conversation.id: llm.call at the start, turn.end at the end.
    const s = buildSession([
      otel({ id: "a", kind: "session.start", ts: 10_000 }),
      otel({ id: "b", kind: "llm.call", ts: 10_000, durationMs: 1500 }),
      otel({ id: "c", kind: "turn.end", ts: 11_500, durationMs: 1500 }),
    ]);
    assert.equal(s.endedAt! - s.startedAt, 1500);
    assert.equal(s.stats.latency?.wallMs, 1500);
    // Trace-keyed: root span's session.end carries the end time and the span length.
    const t = buildSession([
      otel({ id: "a", kind: "session.start", ts: 0 }, "t1"),
      otel({ id: "b", kind: "turn.end", ts: 5000, durationMs: 5000 }, "t1"),
      otel({ id: "c", kind: "session.end", ts: 5000, durationMs: 5000 }, "t1"),
    ]);
    assert.equal(t.endedAt, 5000);
    assert.equal(t.stats.latency?.wallMs, 5000);
    // A hook tool.end with a filled-in duration is stamped at the end too.
    assert.equal(latencyStats([ev("tool.start", {}, { ts: 0 }), ev("tool.end", {}, { ts: 800, durationMs: 800 })]).wallMs, 800);
    // A span stamped at its start still extends the session past later-starting events.
    assert.equal(latencyStats([ev("llm.call", {}, { ts: 0, durationMs: 3000 }), ev("notification", {}, { ts: 1000 })]).wallMs, 3000);
  });

  it("log-keyed OTel sessions (no traceId) end at their last activity", () => {
    const log = (id: string, ts: number): AgentEvent => ({ id, v: 0, sessionId: "qa-cc-1", agent: "claude-code", kind: "llm.call", ts, source: "otel-log", payload: {} });
    const s = buildSession([log("a", 1000), log("b", 6000)]);
    assert.equal(s.endedAt, 6000);
    assert.equal(s.endedAt! - s.startedAt, 5000);
  });

  it("SDK sessions (source sdk, no session.end) end at their last activity, also mixed with OTel spans", () => {
    const sdk = (id: string, kind: EventKind, ts: number, o: Partial<AgentEvent> = {}): AgentEvent => ({ id, v: 0, sessionId: "demo/chat-1", agent: "my-api", kind, ts, source: "sdk", payload: {}, ...o });
    const s = buildSession([sdk("a", "user.message", 1000), sdk("b", "llm.call", 2000, { durationMs: 1500 })]);
    assert.equal(s.endedAt, 3500, "ends when the last call finished, not running forever");
    // aiSdkTracer() spans for the same conversation arrive over OTLP next to native events.
    const mixed = buildSession([sdk("a", "user.message", 1000), { ...sdk("c", "llm.call", 4000, { durationMs: 1000 }), source: "otel-span", traceId: "t9" }]);
    assert.equal(mixed.endedAt, 5000);
    // An explicit session.end still wins; a client-set non-sdk source keeps waiting for one.
    assert.equal(buildSession([sdk("a", "llm.call", 1000, { durationMs: 9000 }), sdk("e", "session.end", 2000)]).endedAt, 2000);
    assert.equal(buildSession([sdk("a", "llm.call", 1000, { source: "hook" })]).endedAt, undefined);
  });

  it("transcript-only (backfilled) sessions end at their last event; live ones wait for session.end", () => {
    const tr = (kind: EventKind, ts: number, o: Partial<AgentEvent> = {}) => ev(kind, {}, { ts, source: "transcript", ...o });
    const s = buildSession([tr("session.start", 1000), tr("user.message", 1000), tr("turn.end", 375_021, { durationMs: 374_021 })]);
    assert.equal(s.endedAt, 375_021);
    assert.equal(s.endedAt! - s.startedAt, s.stats.latency?.wallMs);
    const live = buildSession([tr("session.start", 1000), ev("turn.end", {}, { ts: 2000, source: "hook" })]);
    assert.equal(live.endedAt, undefined, "a hook-captured session may still be running");
  });
});

describe("harness-injected prompts (QA regression)", () => {
  const um = (text: string) => ev("user.message", { text });
  const clear = "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
  const note = "<task-notification> <task-id>bigcaph7k</task-id> <status>completed</status></task-notification>";

  it("titles come from the first real prompt, not command echoes or task notifications", () => {
    const s = buildSession([um(clear), um("<local-command-stdout></local-command-stdout>"), um(note), um("Fix the parser"), um(note), um("and add tests")]);
    assert.equal(s.title, "Fix the parser");
    assert.equal(s.stats.turns, 3, "the slash command and the two real prompts; not the notices or the command output");
  });

  it("a session with only slash commands is titled by the command", () => {
    const s = buildSession([um("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"), um(note)]);
    assert.equal(s.title, "/model opus");
  });

  it("a session with no prompt is titled by its start event's name, and a prompt still wins", () => {
    const start = ev("session.start", { name: "edit  layer 15\n mlp" });
    const edit = ev("notification", { kind: "weights.edit", tensor: "w", changed: 1 });
    assert.equal(buildSession([start, edit]).title, "edit layer 15 mlp");
    assert.equal(buildSession([start, um("Fix the parser")]).title, "Fix the parser");
    assert.equal(buildSession([start, um("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>")]).title, "/model opus");
    assert.equal(buildSession([ev("session.start", { name: "  " }), edit]).title, undefined);
  });

  it("isSyntheticPrompt", () => {
    for (const t of [clear, note, "<local-command-caveat>Caveat: …</local-command-caveat>", "  <system-reminder>x</system-reminder>"]) assert.ok(isSyntheticPrompt(t), t);
    for (const t of ["Fix <command-name> parsing", "hello", "<div>html question</div>"]) assert.ok(!isSyntheticPrompt(t), t);
  });
});

describe("session usage rollup", () => {
  const llm = (spanId: string, parentSpanId: string | undefined, usage: AgentEvent["usage"], payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}) =>
    ev("llm.call", payload, { traceId: "t1", spanId, ...(parentSpanId ? { parentSpanId } : {}), usage, ...o });
  const span = (spanId: string, parentSpanId?: string) => ev("span", { name: "agent" }, { traceId: "t1", spanId, ...(parentSpanId ? { parentSpanId } : {}) });

  it("counts a wrapper span and the provider span inside it once", () => {
    const evs = [llm("a", undefined, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 }), span("mid", "a"), llm("b", "mid", { inputTokens: 100, outputTokens: 20, costUsd: 0.01 })];
    const r = rollupUsage(evs);
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 120, costUsd: 0.01 });
    assert.deepEqual(buildSession(evs).stats.duplicateUsage, r.duplicate);
  });

  it("sibling calls both count", () => {
    const r = rollupUsage([span("root"), llm("a", "root", { inputTokens: 10 }), llm("b", "root", { inputTokens: 5 })]);
    assert.deepEqual(r, { usage: { inputTokens: 15 } });
  });

  it("a wrapper with no cost (or only an estimate) takes the nested calls' reported cost", () => {
    const r = rollupUsage([llm("a", undefined, { inputTokens: 100, outputTokens: 20 }), llm("b", "a", { inputTokens: 100, outputTokens: 20, costUsd: 0.01 })]);
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 120 });
    const est = rollupUsage([llm("a", undefined, { inputTokens: 100, costUsd: 0.5 }, { costEstimated: true }), llm("b", "a", { inputTokens: 100, costUsd: 0.01 })]);
    assert.equal(est.usage.costUsd, 0.01);
    assert.equal(est.usage.estimatedCostUsd, undefined);
  });

  it("token totals skip a count below 0 or not a finite number, as pricing bills it as 0", () => {
    const bad = { inputTokens: -50_000, outputTokens: Number.NaN, cacheReadTokens: Number.POSITIVE_INFINITY, cacheWriteTokens: -1 };
    // No spans: the session folds each call as it comes (the simple fold).
    const plain = buildSession([ev("llm.call", {}, { usage: { ...bad, costUsd: 0.5 } }), ev("llm.call", {}, { usage: { inputTokens: 2000, outputTokens: 100 } })]);
    assert.deepEqual(plain.stats.usage, { inputTokens: 2000, outputTokens: 100, costUsd: 0.5 });
    // Spans: rollupUsage. A wrapper whose own count is bad takes its nested calls' count.
    const wrapper = ev("llm.call", {}, { traceId: "t", spanId: "w", usage: { ...bad, outputTokens: 100 } });
    const kid = ev("llm.call", {}, { traceId: "t", spanId: "k", parentSpanId: "w", usage: { inputTokens: 2000, cacheWriteTokens: 30 } });
    const other = ev("llm.call", {}, { traceId: "t", spanId: "o", usage: { inputTokens: -7, outputTokens: 5 } });
    const s = buildSession([wrapper, kid, other]);
    assert.deepEqual(s.stats.usage, { inputTokens: 2000, outputTokens: 105, cacheWriteTokens: 30 });
    // The nested call is left out as a call; its tokens count, through the wrapper.
    assert.deepEqual(s.stats.duplicateUsage, { calls: 1, tokens: 0 });
    // A usage snapshot: its bad counts are skipped as well.
    const snap = ev("notification", { type: "usage-summary" }, { usage: { inputTokens: -1, outputTokens: 40 } });
    assert.deepEqual(rollupUsage([snap]).usage, { outputTokens: 40 });
    assert.deepEqual(buildSession([snap]).stats.usage, { outputTokens: 40 });
  });

  it("a nested call that reports a cost of 0 beats the wrapper's estimate, as does a reported part too small to change the sum", () => {
    // A free model, or a gateway that bills nothing, under a wrapper priced at $4.
    const wrapper = ev("llm.call", { costEstimated: true }, { model: "claude-opus-5-5", traceId: "t", spanId: "w", usage: { inputTokens: 1_000_000, costUsd: 4 } });
    const free = ev("llm.call", {}, { model: "claude-opus-5-5", traceId: "t", spanId: "n", parentSpanId: "w", usage: { inputTokens: 1_000_000, costUsd: 0 } });
    const s = buildSession([wrapper, free]);
    assert.deepEqual(s.stats.usage, { inputTokens: 1_000_000, costUsd: 0 });
    assert.deepEqual(s.stats.duplicateUsage, { calls: 1, tokens: 1_000_000, costUsd: 4 });
    // 1e-12 reported beside 1e6 estimated: the nested sum less its estimates rounds to 0, and the nested calls count all the same.
    const big = ev("llm.call", { costEstimated: true }, { traceId: "t", spanId: "e", parentSpanId: "w", usage: { inputTokens: 999_999, costUsd: 1e6 } });
    const tiny = ev("llm.call", {}, { traceId: "t", spanId: "r", parentSpanId: "w", usage: { inputTokens: 1, costUsd: 1e-12 } });
    const mixed = rollupUsage([wrapper, big, tiny]).usage;
    assert.equal(mixed.costUsd, 1e6);
    assert.equal(mixed.estimatedCostUsd, 1e6);
  });

  it("a nested call's reported cost beats the wrapper's estimate when that estimate is $0 (a [prices] row of 0)", () => {
    // api.md: "A cost a nested call reported, even $0, beats an estimate on the outer call."
    const wrapper = ev("llm.call", { costEstimated: true }, { model: "house-coder", traceId: "t", spanId: "w", usage: { inputTokens: 1_000_000, costUsd: 0 } });
    const billed = ev("llm.call", {}, { model: "house-coder", traceId: "t", spanId: "n", parentSpanId: "w", usage: { inputTokens: 1_000_000, costUsd: 3 } });
    assert.equal(buildSession([wrapper, billed]).stats.usage?.costUsd, 3);
  });

  it("fills fields the wrapper lacks from its nested calls", () => {
    const r = rollupUsage([llm("a", undefined, { inputTokens: 100 }), llm("b", "a", { inputTokens: 90, cacheReadTokens: 10 }), llm("c", "a", { cacheReadTokens: 5 })]);
    assert.deepEqual(r.usage, { inputTokens: 100, cacheReadTokens: 15 });
    assert.equal(r.duplicate?.calls, 2);
  });

  it("a repeated response id counts once", () => {
    const r = rollupUsage([ev("llm.call", { responseId: "resp_1" }, { usage: { outputTokens: 7 } }), ev("llm.call", { responseId: "resp_1" }, { usage: { outputTokens: 7 } }), ev("llm.call", { responseId: "resp_2" }, { usage: { outputTokens: 3 } })]);
    assert.deepEqual(r, { usage: { outputTokens: 10 }, duplicate: { calls: 1, tokens: 7 } });
  });

  it("calls without trace ids sum as before, and a child seen before its parent folds on rebuild", () => {
    assert.deepEqual(rollupUsage([ev("llm.call", {}, { usage: { inputTokens: 1 } }), ev("llm.call", {}, { usage: { inputTokens: 2 } })]), { usage: { inputTokens: 3 } });
    const child = llm("b", "a", { inputTokens: 100, costUsd: 0.01 });
    assert.equal(buildSession([child]).stats.usage?.inputTokens, 100);
    assert.equal(buildSession([child, llm("a", undefined, { inputTokens: 100, costUsd: 0.01 })]).stats.usage?.inputTokens, 100);
  });

  it("keeps a parent walk bounded on a span cycle", () => {
    const r = rollupUsage([span("x", "y"), span("y", "x"), llm("a", "x", { inputTokens: 1 })]);
    assert.deepEqual(r, { usage: { inputTokens: 1 } });
  });

  it("says which part of the cost is estimated, and never counts a gateway-billed call as estimated", () => {
    const reported = ev("llm.call", {}, { usage: { inputTokens: 10, costUsd: 1 } });
    const estimated = ev("llm.call", { costEstimated: true }, { usage: { inputTokens: 10, costUsd: 0.25 } });
    assert.deepEqual(rollupUsage([reported, estimated]).usage, { inputTokens: 20, costUsd: 1.25, estimatedCostUsd: 0.25 });
    assert.equal(rollupUsage([reported]).usage.estimatedCostUsd, undefined);
    // Gateway enrich: the companion holds billed minus the estimate, so the sum is the bill.
    const gw = ev("span", {}, { source: "gateway", parentId: estimated.id, usage: { costUsd: 0.75 } });
    assert.deepEqual(rollupUsage([estimated, gw]).usage, { inputTokens: 10, costUsd: 1 });
    const snap = ev("notification", { type: "usage-summary", costEstimated: true }, { usage: { outputTokens: 5, costUsd: 0.5 } });
    assert.deepEqual(rollupUsage([snap]).usage, { outputTokens: 5, costUsd: 0.5, estimatedCostUsd: 0.5 });
  });

  // qa:proxy-4: `gateway enrich --gateway cliproxyapi` with usage records that have no cost made the estimate read as billed.
  it("a gateway companion with no cost leaves the call's estimate an estimate; one with a billed cost clears it", () => {
    const estimated = ev("llm.call", { costEstimated: true }, { usage: { inputTokens: 10, costUsd: 0.25 } });
    const noCost = ev("span", { gateway: "cliproxyapi", promptTokens: 10 }, { source: "gateway", parentId: estimated.id });
    assert.deepEqual(rollupUsage([estimated, noCost]).usage, { inputTokens: 10, costUsd: 0.25, estimatedCostUsd: 0.25 });
    assert.equal(buildSession([estimated, noCost]).stats.usage?.estimatedCostUsd, 0.25);
    // Billed exactly what was estimated: no correction in usage, and still a bill.
    const same = ev("span", { gateway: "cliproxyapi", billedCostUsd: 0.25 }, { source: "gateway", parentId: estimated.id });
    assert.deepEqual(rollupUsage([estimated, same]).usage, { inputTokens: 10, costUsd: 0.25 });
    const more = ev("span", { gateway: "cliproxyapi", billedCostUsd: 1 }, { source: "gateway", parentId: estimated.id, usage: { costUsd: 0.75 } });
    assert.deepEqual(buildSession([estimated, more]).stats.usage, { inputTokens: 10, costUsd: 1 });
  });

  it("a gateway companion of a call that was not counted is dropped with it", () => {
    const outer = llm("a", undefined, { inputTokens: 100, costUsd: 0.01 });
    const inner = llm("b", "a", { inputTokens: 100, costUsd: 0.01 });
    const gw = ev("span", {}, { source: "gateway", parentId: inner.id, usage: { costUsd: 0.02 } });
    const r = rollupUsage([outer, inner, gw]);
    assert.equal(r.usage.costUsd, 0.01);
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 100, costUsd: 0.03 });
  });

  it("a nested call a gateway billed counts at the bill when its wrapper's cost is an estimate, whatever cost the call carried", () => {
    // Reported $0, estimated $3, no cost at all: the companion holds the bill minus the call's own cost.
    for (const [own, estimated] of [[0, false], [3, true], [undefined, false]] as const) {
      const wrapper = llm("w", undefined, { inputTokens: 1_000_000, costUsd: 4 }, { costEstimated: true });
      const inner = llm("n", "w", own === undefined ? { inputTokens: 1_000_000 } : { inputTokens: 1_000_000, costUsd: own }, estimated ? { costEstimated: true } : {});
      const gw = ev("span", { gateway: "vercel", billedCostUsd: 5 }, { source: "gateway", parentId: inner.id, usage: { costUsd: 5 - (own ?? 0) } });
      const s = buildSession([wrapper, inner, gw]);
      assert.deepEqual(s.stats.usage, { inputTokens: 1_000_000, costUsd: 5 }, `a nested call at ${own}`);
      assert.deepEqual(s.stats.duplicateUsage, { calls: 1, tokens: 1_000_000, costUsd: 4 }, `a nested call at ${own}`);
    }
  });

  it("a call a gateway billed counts at the bill, without its nested calls' cost on top", () => {
    const outer = llm("a", undefined, { inputTokens: 100 });
    const inner = llm("b", "a", { inputTokens: 100, costUsd: 0.5 });
    const gw = ev("span", { gateway: "vercel", billedCostUsd: 2 }, { source: "gateway", parentId: outer.id, usage: { costUsd: 2 } });
    const r = rollupUsage([outer, inner, gw]);
    assert.deepEqual(r.usage, { inputTokens: 100, costUsd: 2 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 100, costUsd: 0.5 });
  });

  // `gateway enrich` links one generation to each call that carries its id: the proxy's copy of a call and the agent's own record of it.
  const billFor = (call: AgentEvent, own: number) =>
    ev("span", { gateway: "vercel", generationId: "gen_x", billedCostUsd: 1.5 }, { source: "gateway", parentId: call.id, usage: { costUsd: 1.5 - own } });

  it("a gateway generation linked to two copies of one call is billed once, by the companion of the copy that counts", () => {
    for (const nested of [false, true]) {
      const proxied = ev("llm.call", { responseId: "gen_x" }, { source: "proxy", usage: { inputTokens: 1000, costUsd: 1 } });
      const wrapper = llm("w", undefined, { inputTokens: 1000, costUsd: 2 }, { costEstimated: true });
      const own = llm("k", nested ? "w" : undefined, { inputTokens: 1000, costUsd: 1 }, { responseId: "gen_x" });
      // The proxy's copy is left out of the totals, so its companion's bill is the copy that does not count.
      const evs = [proxied, own, billFor(proxied, 1), billFor(own, 1)];
      if (nested) evs.splice(1, 0, wrapper);
      const s = buildSession(evs);
      assert.equal(s.stats.usage?.costUsd, 1.5, nested ? "under an estimated wrapper" : "at the top");
      // Whichever companion comes first.
      assert.equal(buildSession([...evs.slice(0, -2), evs.at(-1)!, evs.at(-2)!].map((e, i) => ({ ...e, ts: 1 + i }))).stats.usage?.costUsd, 1.5);
      // The wrapper's estimate and the bill's copy are what was left out.
      if (nested) assert.deepEqual(s.stats.duplicateUsage, { calls: 1, tokens: 1000, costUsd: 2.5 });
    }
  });

  it("a gateway generation linked to the proxy's copy and to the agent's record with no usage counts the whole bill, in either order", () => {
    // The agent's record carries no usage (a Codex call without usage), so its companion holds the whole bill. The proxy's
    // copy is left out of the totals with its own cost, so its companion's difference is not the bill.
    const proxied = ev("llm.call", { responseId: "gen_x", costEstimated: true }, { source: "proxy", usage: { inputTokens: 1000, outputTokens: 100, costUsd: 1 } });
    const own = ev("llm.call", { responseId: "gen_x" });
    const [a, b, c, d] = [proxied, billFor(proxied, 1), own, billFor(own, 0)];
    for (const order of [[a, b, c, d], [c, d, a, b]]) {
      const s = buildSession(order.map((e, i) => ({ ...e, ts: 1 + i })));
      assert.equal(s.stats.usage?.costUsd, 1.5, order[0] === a ? "the proxy's copy first" : "the agent's record first");
    }
  });

  it("a gateway generation linked to two counted calls adds its bill once", () => {
    // The agent's record of one response at the top of one trace and nested in another. The call still counts twice, as
    // before (the wrapper takes the nested call's cost though it repeats a counted response), but its bill's 0.5 counts once.
    const root = ev("llm.call", { responseId: "gen_x" }, { traceId: "t2", spanId: "r", usage: { inputTokens: 1000, costUsd: 1 } });
    const wrapper = llm("w", undefined, { inputTokens: 1000, costUsd: 2 }, { costEstimated: true });
    const own = llm("k", "w", { inputTokens: 1000, costUsd: 1 }, { responseId: "gen_x" });
    const r = rollupUsage([root, wrapper, own, billFor(root, 1), billFor(own, 1)]);
    assert.equal(r.usage.costUsd, 1 + 1 + 0.5);
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 1000, costUsd: 2.5 });
    // A companion with no generation id keeps the rule before generations: each counted call's companion counts.
    const plain = (call: AgentEvent) => ev("span", { gateway: "vercel", billedCostUsd: 1.5 }, { source: "gateway", parentId: call.id, usage: { costUsd: 0.5 } });
    assert.equal(rollupUsage([root, wrapper, own, plain(root), plain(own)]).usage.costUsd, 1 + 1 + 0.5 + 0.5);
  });

  // A nested call with no usage of its own was not seen as nested, so its bill added to its wrapper's cost.
  it("a nested call a gateway billed with no usage of its own replaces its wrapper's estimate, and goes with it under a reported cost", () => {
    // No usage, an empty one, and a reported $0 with no tokens: none carries usage, and the gateway billed each $5.
    for (const own of [undefined, {}, { costUsd: 0 }] as AgentEvent["usage"][]) {
      for (const estimated of [true, false]) {
        const wrapper = llm("w", undefined, { inputTokens: 10, costUsd: 4 }, estimated ? { costEstimated: true } : {});
        const inner = llm("k", "w", own);
        const gw = ev("span", { gateway: "vercel", billedCostUsd: 5 }, { source: "gateway", parentId: inner.id, usage: { costUsd: 5 } });
        const label = `${estimated ? "an estimated" : "a reported"} wrapper over ${JSON.stringify(own)}`;
        const r = rollupUsage([wrapper, inner, gw]);
        // Estimated: the bill replaces the $4. Reported: the wrapper keeps its $4, and the bill is left out with the call.
        assert.deepEqual(r.usage, { inputTokens: 10, costUsd: estimated ? 5 : 4 }, label);
        assert.deepEqual(r.duplicate, { calls: 1, tokens: 0, costUsd: estimated ? 4 : 5 }, label);
        const s = buildSession([wrapper, inner, gw]);
        assert.deepEqual(s.stats.usage, r.usage, label);
        assert.deepEqual(s.stats.duplicateUsage, r.duplicate, label);
      }
    }
  });

  it("a wrapper a gateway billed with no usage of its own counts its nested calls' tokens at the bill, without their cost on top", () => {
    const wrapper = llm("w", undefined, undefined);
    const inner = llm("k", "w", { inputTokens: 10, costUsd: 4 }, { costEstimated: true });
    const gw = ev("span", { gateway: "vercel", billedCostUsd: 5 }, { source: "gateway", parentId: wrapper.id, usage: { costUsd: 5 } });
    const r = rollupUsage([wrapper, inner, gw]);
    assert.deepEqual(r.usage, { inputTokens: 10, costUsd: 5 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 0, costUsd: 4 });
    assert.deepEqual(buildSession([wrapper, inner, gw]).stats.usage, r.usage);
  });

  // A gateway companion billing `x` for generation `g`: its usage holds the bill less the call's own cost, and is left out at 0.
  const bill = (call: AgentEvent, x: number, g?: string) => {
    const rest = x - (call.usage?.costUsd ?? 0);
    const payload: Record<string, unknown> = { gateway: "vercel", billedCostUsd: x };
    if (g) payload.generationId = g;
    const o: Partial<AgentEvent> = { source: "gateway", parentId: call.id };
    if (rest) o.usage = { costUsd: rest };
    return ev("span", payload, o);
  };

  // A billed wrapper with no usage took only its own bill, so the bills of the calls nested in it went missing.
  it("a billed wrapper adds the bills of the calls nested in it, except a bill for its own generation", () => {
    const wrapper = llm("w", undefined, undefined);
    const a = llm("a", "w", { inputTokens: 10, costUsd: 0.25 }, { costEstimated: true });
    const b = llm("b", "w", { inputTokens: 20, costUsd: 0.5 }, { costEstimated: true });
    // b's bill is for the wrapper's generation: one request the gateway billed, seen on both spans.
    const evs = [wrapper, a, b, bill(wrapper, 2, "gen_w"), bill(a, 1, "gen_a"), bill(b, 2, "gen_w")];
    const r = rollupUsage(evs);
    assert.deepEqual(r.usage, { inputTokens: 30, costUsd: 3 });
    assert.deepEqual(r.duplicate, { calls: 2, tokens: 0, costUsd: 2 });
    assert.deepEqual(buildSession(evs).stats.usage, r.usage);
    // With no generation ids, every bill counts.
    assert.deepEqual(rollupUsage([wrapper, a, b, bill(wrapper, 0.5), bill(a, 1), bill(b, 2)]).usage, { inputTokens: 30, costUsd: 3.5 });
  });

  it("a billed call with no usage nested in a billed wrapper adds its bill, at any depth", () => {
    const wrapper = llm("w", undefined, undefined);
    const inner = llm("k", "w", undefined);
    const evs = [wrapper, inner, bill(wrapper, 2), bill(inner, 1)];
    const r = rollupUsage(evs);
    assert.deepEqual(r.usage, { costUsd: 3 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 0 });
    const s = buildSession(evs);
    assert.deepEqual(s.stats.usage, r.usage);
    assert.deepEqual(s.stats.duplicateUsage, r.duplicate);
    // An estimated call a level down counts its tokens, and the bills replace its estimate.
    const deep = llm("j", "k", { inputTokens: 10, costUsd: 0.25 }, { costEstimated: true });
    assert.deepEqual(rollupUsage([wrapper, inner, deep, bill(wrapper, 2, "gen_w"), bill(inner, 1, "gen_k")]).usage, { inputTokens: 10, costUsd: 3 });
  });

  // A billed wrapper with no usage skipped the replay and response id checks, and so did the calls nested in it.
  it("a billed wrapper with no usage and the calls nested in it count once when replayed or repeated", () => {
    // A durable engine replays a recorded step: the wrapper and the call inside it come again.
    const w0 = llm("w0", undefined, undefined, { responseId: "gen_g" });
    const k0 = llm("k0", "w0", { inputTokens: 10, costUsd: 0.25 }, { costEstimated: true, responseId: "resp_1" });
    const w1 = llm("w1", undefined, undefined, { replay: true, responseId: "gen_g" });
    const k1 = llm("k1", "w1", { inputTokens: 10 }, { replay: true, responseId: "resp_1" });
    const replayed = [w0, k0, bill(w0, 1, "gen_g"), w1, k1, bill(w1, 1, "gen_g")];
    const r = rollupUsage(replayed);
    assert.deepEqual(r.usage, { inputTokens: 10, costUsd: 1 });
    assert.deepEqual(r.duplicate, { calls: 3, tokens: 10, costUsd: 1.25 });
    assert.deepEqual(buildSession(replayed).stats.usage, r.usage);
    // A call nested in a billed wrapper with no usage repeats an earlier call's response id.
    const first = llm("a", undefined, { inputTokens: 10, costUsd: 0.25 }, { costEstimated: true, responseId: "resp_2" });
    const wrapper = llm("w", undefined, undefined);
    const again = llm("b", "w", { inputTokens: 10 }, { responseId: "resp_2" });
    const repeated = rollupUsage([first, wrapper, again, bill(wrapper, 1)]);
    assert.deepEqual(repeated.usage, { inputTokens: 10, costUsd: 1.25, estimatedCostUsd: 0.25 });
    assert.deepEqual(repeated.duplicate, { calls: 1, tokens: 10 });
    // A billed copy with no usage and nothing nested in it has no tokens to check, so the copy after it that carries them counts.
    const bare = llm("x", undefined, undefined, { responseId: "resp_3" });
    const copy = llm("y", undefined, { inputTokens: 10, costUsd: 0.25 }, { costEstimated: true, responseId: "resp_3" }, { traceId: "t2" });
    assert.deepEqual(rollupUsage([bare, copy, bill(bare, 1, "gen_h"), bill(copy, 1, "gen_h")]).usage, { inputTokens: 10, costUsd: 1 });
  });

  // Zeros counted as the wrapper's own token counts and hid its nested calls' tokens.
  it("a billed wrapper whose usage is all zeros counts its nested calls' tokens", () => {
    const wrapper = llm("w", undefined, { inputTokens: 0, outputTokens: 0 });
    const inner = llm("k", "w", { inputTokens: 10, outputTokens: 5, costUsd: 1 }, { costEstimated: true });
    const evs = [wrapper, inner, bill(wrapper, 5)];
    const r = rollupUsage(evs);
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, costUsd: 5 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 0, costUsd: 1 });
    assert.deepEqual(buildSession(evs).stats.usage, r.usage);
    const cached = llm("c", undefined, { cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.deepEqual(rollupUsage([cached, llm("d", "c", { cacheReadTokens: 7 }), bill(cached, 5)]).usage, { cacheReadTokens: 7, costUsd: 5 });
  });

  it("a bill of $0 counts as $0, above an estimate or below one", () => {
    const wrapper = llm("w", undefined, undefined);
    const inner = llm("k", "w", { inputTokens: 10, costUsd: 4 }, { costEstimated: true });
    assert.deepEqual(rollupUsage([wrapper, inner, bill(wrapper, 0)]).usage, { inputTokens: 10, costUsd: 0 });
    const estimated = llm("e", undefined, { inputTokens: 10, costUsd: 4 }, { costEstimated: true });
    const free = llm("f", "e", undefined);
    const evs = [estimated, free, bill(free, 0)];
    assert.deepEqual(rollupUsage(evs).usage, { inputTokens: 10, costUsd: 0 });
    assert.deepEqual(buildSession(evs).stats.usage, { inputTokens: 10, costUsd: 0 });
  });

  it("model calls nested in each other in a loop count under the first of them", () => {
    const a = llm("a", "b", undefined);
    const b = llm("b", "a", undefined);
    const r = rollupUsage([a, b, bill(a, 1), bill(b, 2)]);
    assert.deepEqual(r.usage, { costUsd: 3 });
    assert.deepEqual(r.duplicate, { calls: 1, tokens: 0 });
    assert.deepEqual(rollupUsage([llm("x", "y", { inputTokens: 5 }), llm("y", "x", { inputTokens: 5 })]), { usage: { inputTokens: 5 }, duplicate: { calls: 1, tokens: 5 } });
  });
});

describe("the estimate by token type (stats.usage.estimatedCostByTokenType)", () => {
  const table = pricesFor();
  // Opus 4.5: $5 in, $25 out, $0.50 cache read, $6.25 cache write per million.
  const priced = (usage: AgentEvent["usage"], o: Partial<AgentEvent> = {}) => priceEvent(ev("llm.call", {}, { model: "claude-opus-4-5", usage, ...o }), table);
  const near = (a: CostByTokenType | undefined, b: CostByTokenType) => {
    assert.ok(a, "a split");
    assert.deepEqual(Object.keys(a), Object.keys(b));
    for (const k of Object.keys(b) as (keyof CostByTokenType)[]) assert.ok(Math.abs(a[k] - b[k]) < 1e-12, `${k}: ${a[k]} vs ${b[k]}`);
  };
  const sum = (p: CostByTokenType) => p.cacheRead + p.cacheWrite + p.input + p.output;

  it("splits the estimate into cache reads, cache writes, uncached input and output that add up to it", () => {
    const a = priced({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 });
    const b = priced({ inputTokens: 4000, cacheReadTokens: 50_000 });
    const u = buildSession([a, b]).stats.usage!;
    near(u.estimatedCostByTokenType, { cacheRead: 0.075, cacheWrite: 0.0625, input: 0.025, output: 0.05 });
    assert.ok(Math.abs(sum(u.estimatedCostByTokenType!) - u.estimatedCostUsd!) < 1e-12);
    assert.equal(u.estimatedCostUsd, u.costUsd);
  });

  it("leaves reported and gateway-billed costs out, so the split never contradicts the total", () => {
    const est = priced({ inputTokens: 100_000 }); // $0.50
    const reported = ev("llm.call", {}, { model: "claude-opus-4-5", usage: { inputTokens: 10, costUsd: 1 } });
    const u = buildSession([est, reported]).stats.usage!;
    assert.deepEqual([u.costUsd, u.estimatedCostUsd], [1.5, 0.5]);
    near(u.estimatedCostByTokenType, { cacheRead: 0, cacheWrite: 0, input: 0.5, output: 0 });
    // A gateway billed the estimated call: nothing is estimated, so nothing is split.
    const gw = ev("span", { gateway: "cliproxyapi", billedCostUsd: 0.75 }, { source: "gateway", parentId: est.id, usage: { costUsd: 0.25 } });
    const billed = buildSession([est, reported, gw]).stats.usage!;
    assert.deepEqual([billed.costUsd, billed.estimatedCostUsd, billed.estimatedCostByTokenType], [1.75, undefined, undefined]);
    // Costs that cut the total below the estimate: the estimate is capped, and no split claims more than the total.
    const credit = ev("llm.call", {}, { usage: { costUsd: -0.3 } });
    const capped = buildSession([est, credit]).stats.usage!;
    assert.ok(Math.abs(capped.estimatedCostUsd! - 0.2) < 1e-12);
    assert.equal(capped.estimatedCostByTokenType, undefined);
  });

  it("is absent when nothing has a known price, and when an estimated call has no split that adds up to it", () => {
    assert.equal(buildSession([ev("llm.call", {}, { model: "no-such-model", usage: { inputTokens: 10 } })]).stats.usage?.estimatedCostByTokenType, undefined);
    assert.equal(buildSession([ev("llm.call", {}, { usage: { inputTokens: 10, costUsd: 1 } })]).stats.usage?.estimatedCostByTokenType, undefined);
    // Estimated before splits: the estimate stays, and no split covers only part of it.
    const old = ev("llm.call", { costEstimated: true }, { usage: { inputTokens: 10, costUsd: 0.25 } });
    const u = buildSession([priced({ inputTokens: 100_000 }), old]).stats.usage!;
    assert.deepEqual([u.estimatedCostUsd, u.estimatedCostByTokenType], [0.75, undefined]);
    const p = priced({ inputTokens: 100_000 });
    const wrong = { ...p, payload: { ...p.payload, costByTokenType: { cacheRead: 0, cacheWrite: 0, input: 0.4, output: 0 } } };
    assert.equal(buildSession([wrong]).stats.usage?.estimatedCostByTokenType, undefined);
  });

  it("a nested call's split folds into the call that wraps it", () => {
    const span = (spanId: string, parentSpanId: string | undefined, e: AgentEvent): AgentEvent => {
      const s: AgentEvent = { ...e, traceId: "t1", spanId };
      if (parentSpanId) s.parentSpanId = parentSpanId;
      return s;
    };
    const inner1 = span("b", "a", priced({ inputTokens: 100, cacheReadTokens: 60_000 }));
    const inner2 = span("c", "a", priced({ inputTokens: 100, cacheReadTokens: 40_000, outputTokens: 1000 }));
    // A wrapper with tokens and no model has no price: its cost and split come from the calls inside it.
    const wrapper = span("a", undefined, ev("llm.call", {}, { usage: { inputTokens: 200, cacheReadTokens: 100_000 } }));
    const r = rollupUsage([wrapper, inner1, inner2]);
    near(r.usage.estimatedCostByTokenType, { cacheRead: 0.05, cacheWrite: 0, input: 0.001, output: 0.025 });
    assert.ok(Math.abs(r.usage.estimatedCostUsd! - 0.076) < 1e-12);
    assert.deepEqual(buildSession([wrapper, inner1, inner2]).stats.usage, r.usage);
    // A priced wrapper keeps its own cost and split; the calls inside it are copies.
    const own = span("a", undefined, priced({ inputTokens: 200, cacheReadTokens: 100_000 }));
    near(rollupUsage([own, inner1, inner2]).usage.estimatedCostByTokenType, { cacheRead: 0.05, cacheWrite: 0, input: 0.001, output: 0 });
  });

  it("a usage snapshot's split counts, and the incremental fold agrees with the full rollup", () => {
    // gpt-5.4: $15 out; snapshots are priced at standard rates.
    const snap = priceEvent(ev("notification", { type: "usage-summary" }, { model: "gpt-5.4", usage: { outputTokens: 1_000_000 } }), table);
    assert.deepEqual(rollupUsage([snap]).usage.estimatedCostByTokenType, { cacheRead: 0, cacheWrite: 0, input: 0, output: 15 });
    const evs = [
      priced({ inputTokens: 1000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 }, { payload: { cacheWrite1hTokens: 4000 } }),
      priced({ inputTokens: 300_000, outputTokens: 123_457 }, { payload: { serviceTier: "batch" } }),
      ev("llm.call", {}, { usage: { inputTokens: 10, costUsd: 1 } }),
      snap,
    ];
    const u = buildSession(evs).stats.usage!;
    assert.deepEqual(u, rollupUsage(evs).usage);
    assert.ok(Math.abs(sum(u.estimatedCostByTokenType!) - u.estimatedCostUsd!) < 1e-9);
  });
});

describe("a session captured over OTLP logs and from its transcript", () => {
  const call = (id: string, source: string, ts: number, inputTokens: number): AgentEvent => ({
    id, v: 0, sessionId: "dual", ts, agent: "claude-code", kind: "llm.call", source, durationMs: 100, model: "claude-sonnet-4-5",
    usage: { inputTokens, outputTokens: 10 }, payload: { provider: "anthropic", ok: true },
  });
  const logs = [call("l1", "otel-log", 1000, 100), call("l2", "otel-log", 2000, 200)];
  const transcript = [call("t1", "transcript", 1001, 100), call("t2", "transcript", 2001, 200)];
  const totals = (events: AgentEvent[]) => {
    const s = buildSession(events);
    return { input: s.stats.usage?.inputTokens, output: s.stats.usage?.outputTokens, calls: s.stats.latency?.llmCalls, models: s.stats.models };
  };

  it("counts each model call once, in either order", () => {
    const want = totals(transcript);
    assert.equal(want.input, 300);
    assert.equal(want.calls, 2);
    assert.deepEqual(totals([...logs, ...transcript]), want);
    assert.deepEqual(totals([...transcript, ...logs]), want);
    assert.deepEqual(totals([logs[0]!, transcript[0]!, logs[1]!, transcript[1]!]), want);
  });

  it("counts the logs' calls when only they arrive", () => {
    assert.deepEqual(totals(logs), { input: 300, output: 20, calls: 2, models: totals(transcript).models });
  });
});

describe("stats.waiting (core/waiting.ts)", () => {
  it("is set while a Claude Code permission prompt is open, and absent once the call ends or nothing waits", () => {
    const o = { agent: "claude-code" as const };
    const head = [ev("session.start", {}, o), ev("user.message", { text: "publish it" }, o)];
    const start = ev("tool.start", { tool: "Bash", toolUseId: "w1", input: { command: "npm publish" } }, o);
    const prompt = ev("notification", { type: "permission_prompt", text: "Claude needs your permission to use Bash" }, o);
    const s = buildSession([...head, start, prompt]);
    assert.deepEqual(s.stats.waiting, { kind: "permission", at: prompt.ts, toolUseId: "w1", text: "Claude needs your permission to use Bash" });
    const done = buildSession([...head, start, prompt, ev("tool.end", { tool: "Bash", toolUseId: "w1", ok: true }, o)]);
    assert.equal("waiting" in done.stats, false);
    assert.equal("waiting" in buildSession([ev("user.message", { text: "hi" }), ev("turn.end")]).stats, false, "a turn end waits only in a session launched interactively");
  });
});
