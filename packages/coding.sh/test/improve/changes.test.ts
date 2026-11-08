// Did a harness change help? A temp git repo whose CLAUDE.md gains a line,
// synthetic sessions recorded at each HEAD, and the verdict per change.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { changeEffects, decide, harnessChanges, sessionVersions, withoutMcp } from "../../src/improve/changes.ts";
import { claimSession, sessionEvents } from "../helpers-decision.ts";

const T0 = 1_790_000_000_000;
let root = "";
const commits: Record<string, string> = {};

function git(args: string[], date?: string): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(name: string, file: string, text: string, day: number): void {
  writeFileSync(join(root, file), text);
  git(["add", "-A"]);
  git(["commit", "-qm", name], `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`);
  commits[name] = git(["rev-parse", "HEAD"]);
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-improve-changes-")));
  git(["init", "-q"]);
  commit("init", "CLAUDE.md", "Keep answers short.\n", 1);
  commit("add the test rule", "CLAUDE.md", "Keep answers short.\nRun `npm test` before you say you are done.\n", 5);
  commit("unrelated code", "index.js", "export {};\n", 6);
  commit("ask for a summary", "CLAUDE.md", "Keep answers short.\nRun `npm test` before you say you are done.\nEnd with a two-line summary.\n", 10);
});
after(() => rmSync(root, { recursive: true, force: true }));

const events = new Map<string, AgentEvent[]>();

/** A session at `head`; `tested` runs npm test, else it claims done without a check. */
function at(id: string, head: string, o: { flagged: boolean; tested: boolean; k: number }): Session {
  const opts = { cwd: root, startedAt: T0 + o.k * 3600_000 };
  const ev = o.tested
    ? sessionEvents(id, opts, [
        ["user.message", { text: "Fix it." }],
        ["tool.start", { tool: "Bash", toolUseId: `${id}-t`, input: { command: "npm test" } }],
        ["tool.end", { tool: "Bash", toolUseId: `${id}-t`, ok: true, output: "ok" }],
        ["assistant.message", { text: "Done; npm test passes." }],
      ])
    : claimSession(id, opts);
  events.set(id, ev);
  return { ...buildSession(ev), repo: { root, head }, flags: o.flagged ? ["no-verification"] : [] };
}

/** A session that only called MCP tools (asking coding.sh about other sessions). */
function mcpOnly(id: string, head: string, k: number): Session {
  const ev = sessionEvents(id, { cwd: root, startedAt: T0 + k * 3600_000 }, [
    ["user.message", { text: "Did my CLAUDE.md change help?" }],
    ["tool.start", { tool: "mcp__coding_sh__harness_changes", toolUseId: `${id}-m`, input: {}, server: "coding_sh" }],
    ["tool.end", { tool: "mcp__coding_sh__harness_changes", toolUseId: `${id}-m`, ok: true, output: "{}" }],
  ]);
  events.set(id, ev);
  return { ...buildSession(ev), repo: { root, head } };
}

describe("harnessChanges", () => {
  it("lists the commits that touched a harness file, newest first, with their added lines and previous version", async () => {
    const cs = await harnessChanges(root, { limit: 5 });
    assert.deepEqual(
      cs.map((c) => c.subject),
      ["ask for a summary", "add the test rule", "init"],
      "the code-only commit is not a harness change",
    );
    assert.deepEqual(cs[0]!.added, ["End with a two-line summary."]);
    assert.equal(cs[0]!.previous, commits["add the test rule"]);
    assert.equal(cs[1]!.previous, commits.init);
    assert.equal(cs[2]!.previous, undefined);
    assert.deepEqual(cs[1]!.files, [{ path: "CLAUDE.md", added: 1, removed: 0 }]);
  });

  it("a session's version is the newest harness commit its HEAD reaches", async () => {
    const s = [at("v1", commits["unrelated code"]!, { flagged: false, tested: true, k: 0 }), at("v2", "0000000000000000000000000000000000000000", { flagged: false, tested: true, k: 1 })];
    const v = await sessionVersions(root, s);
    assert.equal(v.get("v1"), commits["add the test rule"]);
    assert.equal(v.has("v2"), false, "a HEAD git does not have is left out");
  });
});

describe("changeEffects", () => {
  it("helped: fewer flagged sessions and the new line followed; MCP-only sessions are not scored on the line", async () => {
    const sessions: Session[] = [];
    for (let k = 0; k < 6; k++) sessions.push(at(`b${k}`, commits.init!, { flagged: k < 4, tested: false, k }));
    for (let k = 0; k < 6; k++) sessions.push(at(`a${k}`, k % 2 ? commits["unrelated code"]! : commits["add the test rule"]!, { flagged: false, tested: true, k: 10 + k }));
    sessions.push(mcpOnly("m0", commits["add the test rule"]!, 20));
    const effects = await changeEffects(root, sessions, { since: 0, limit: 5, events: async (id) => events.get(id) ?? [] });
    const e = effects.find((x) => x.change.subject === "add the test rule")!;
    assert.deepEqual([e.before.sessions, e.before.flagged, e.after.sessions, e.after.flagged], [6, 4, 6, 0], "the MCP-only session is not a work session");
    assert.equal(e.verdict, "helped", e.reason);
    assert.equal(e.rules.length, 1);
    assert.equal(e.rules[0]!.polarity, "require");
    assert.deepEqual([e.rules[0]!.before, e.rules[0]!.after], [{ acted: 0, n: 6 }, { acted: 6, n: 6 }], "the MCP-only session is left out of n");
    const first = effects.find((x) => x.change.subject === "init")!;
    assert.equal(first.verdict, "no-baseline");
    const last = effects.find((x) => x.change.subject === "ask for a summary")!;
    assert.equal(last.verdict, "no-sessions-after");
  });

  it("regressed: more sessions flagged after a change", async () => {
    const sessions: Session[] = [];
    for (let k = 0; k < 6; k++) sessions.push(at(`p${k}`, commits["add the test rule"]!, { flagged: false, tested: true, k }));
    for (let k = 0; k < 6; k++) sessions.push(at(`q${k}`, commits["ask for a summary"]!, { flagged: k < 5, tested: true, k: 10 + k }));
    const [e] = await changeEffects(root, sessions, { since: 0, limit: 1, events: async (id) => events.get(id) ?? [] });
    assert.equal(e!.change.subject, "ask for a summary");
    assert.equal(e!.verdict, "regressed", e!.reason);
    assert.match(e!.reason, /flagged sessions 0 of 6 before, 5 of 6 after/);
  });

  it("lists every flagged session on each side, newest first, with its diagnosed flags", async () => {
    const sessions: Session[] = [];
    for (let k = 0; k < 6; k++) sessions.push(at(`r${k}`, commits["add the test rule"]!, { flagged: k === 2, tested: true, k }));
    for (let k = 0; k < 6; k++) sessions.push(at(`s${k}`, commits["ask for a summary"]!, { flagged: k % 2 === 0, tested: true, k: 10 + k }));
    // A tag (has a colon) and an undiagnosed flag are not failures: s5 stays unflagged.
    sessions[11] = { ...sessions[11]!, flags: ["skill:pdf", "not-a-flag"] };
    const [e] = await changeEffects(root, sessions, { since: 0, limit: 1, events: async (id) => events.get(id) ?? [] });
    assert.deepEqual(
      e!.after.flaggedSessions.map((s) => [s.id, s.flags, s.startedAt]),
      [
        ["s4", ["no-verification"], T0 + 14 * 3600_000],
        ["s2", ["no-verification"], T0 + 12 * 3600_000],
        ["s0", ["no-verification"], T0 + 10 * 3600_000],
      ],
    );
    assert.equal(e!.after.flagged, e!.after.flaggedSessions.length);
    assert.deepEqual(e!.before.flaggedSessions.map((s) => s.id), ["r2"]);
  });
});

describe("decide", () => {
  const g = (sessions: number, flagged: number) => ({ sessions, flagged, byFlag: {}, examples: [], flaggedSessions: [] });
  it("too early with few sessions after; no clear change when it could be chance", () => {
    assert.equal(decide(g(6, 3), g(2, 0), []).verdict, "too-early");
    assert.equal(decide(g(6, 3), g(6, 2), []).verdict, "no-clear-change");
    assert.equal(decide(g(0, 0), g(6, 2), []).verdict, "no-baseline");
    assert.equal(decide(g(6, 2), g(0, 0), []).verdict, "no-sessions-after");
  });
});

describe("withoutMcp", () => {
  it("drops MCP tool calls, start and end, by tool name or server", () => {
    const ev = sessionEvents("x", { cwd: root, startedAt: T0 }, [
      ["tool.start", { tool: "mcp__coding_sh__improve", toolUseId: "1" }],
      ["tool.end", { tool: "mcp__coding_sh__improve", toolUseId: "1", ok: true }],
      ["tool.start", { tool: "search", toolUseId: "2", server: "docs" }],
      ["tool.end", { tool: "search", toolUseId: "2", ok: true }],
      ["tool.start", { tool: "Bash", toolUseId: "3", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "3", ok: true }],
    ]);
    assert.deepEqual(
      withoutMcp(ev).map((e) => e.payload.toolUseId),
      ["3", "3"],
    );
  });
});
