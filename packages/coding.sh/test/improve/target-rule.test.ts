// Where improve puts a fix line and what the line says. The file is the one
// the issue's agents load (Codex reads AGENTS.md, not CLAUDE.md). With no test
// command in the repo the line names the one AGENTS.md or the sessions use,
// else it says "the tests" in plain words, never as a code span. A wrapper
// session that never said anything is not flagged for claiming done unchecked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { rankIssues } from "../../src/improve/issues.ts";
import { findIssues, namedTestCommand, targetFile, testCommandOf } from "../../src/improve/report.ts";
import { claimSession, sessionEvents } from "../helpers-decision.ts";

const dirs: string[] = [];
const tmp = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "csh-improve-target-"));
  dirs.push(d);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** An index that answers listEvents from memory, the one call findIssues makes without a repo root. */
function memIndex(all: AgentEvent[]): IndexStore {
  return {
    listEvents: async (id: string, o: { kinds?: string[]; limit?: number } = {}) => all.filter((e) => e.sessionId === id && (!o.kinds || o.kinds.includes(e.kind))).slice(0, o.limit ?? Infinity),
  } as unknown as IndexStore; // slop-allow chained-as: a stub of the one IndexStore method findIssues calls here
}

const PLAIN = "Run the tests before you say you are done, and say what it printed.";

describe("improve: target file", () => {
  it("Codex sessions target AGENTS.md even when only CLAUDE.md exists", () => {
    const root = tmp({ "CLAUDE.md": "Keep answers short.\n" });
    assert.equal(targetFile(root, ["codex", "codex"]), "AGENTS.md");
    assert.equal(targetFile(root, ["claude-code"]), "CLAUDE.md");
  });

  it("Claude Code sessions target CLAUDE.md even when only AGENTS.md exists; no agents keeps the repo's file", () => {
    const root = tmp({ "AGENTS.md": "Keep answers short.\n" });
    assert.equal(targetFile(root, ["claude-code", "claude-code", "codex"]), "CLAUDE.md");
    assert.equal(targetFile(root, []), "AGENTS.md");
  });
});

describe("improve: the no-verification line", () => {
  const cwd = "/work/demo";
  // Edits a file, then says it is done without running anything.
  const claim = (id: string) => {
    const ev = claimSession(id, { cwd, startedAt: 1_700_000_000_000, agent: "codex" });
    const done = ev.findIndex((e) => e.kind === "assistant.message" && String(e.payload.text).startsWith("Fixed"));
    return [...ev.slice(0, done), { ...ev[done]!, id: `${id}-fc`, kind: "file.change" as const, payload: { path: "src/range.js", op: "modify" } }, ...ev.slice(done)];
  };

  it("rankIssues with no test command says the tests in plain words", () => {
    const sessions = [buildSession(claim("s1")), buildSession(claim("s2"))];
    assert.ok(sessions.every((s) => s.flags?.includes("no-verification")));
    const [i] = rankIssues(sessions, new Map()).filter((x) => x.id === "flag:no-verification");
    assert.equal(i!.rule, PLAIN);
    assert.doesNotMatch(i!.rule!, /`/);
  });

  it("the test command AGENTS.md names is used when the repo has no manifest", async () => {
    const root = tmp({ "AGENTS.md": "# Notes\n\nRun `cargo test -p core` before a commit.\n" });
    assert.equal(namedTestCommand(root), "cargo test -p core");
    assert.equal(await testCommandOf(root), "cargo test -p core");
    assert.equal(await testCommandOf(tmp({ "AGENTS.md": "Keep answers short.\n" })), undefined);
  });

  it("findIssues falls back to the test command most sessions ran", async () => {
    const ran = (id: string, command: string) =>
      sessionEvents(id, { cwd, startedAt: 1_700_000_000_000, agent: "codex" }, [
        ["session.start", {}],
        ["user.message", { text: "Check it." }],
        ["tool.start", { tool: "Bash", toolUseId: `${id}-t`, input: { command } }],
        ["tool.end", { tool: "Bash", toolUseId: `${id}-t`, ok: true, output: "ok" }],
        ["assistant.message", { text: "Looks fine." }],
        ["turn.end", {}],
      ]);
    const events = [...claim("c1"), ...claim("c2"), ...ran("r1", "pnpm test"), ...ran("r2", "pnpm test"), ...ran("r3", "go test ./...")];
    const sessions = ["c1", "c2", "r1", "r2", "r3"].map((id) => buildSession(events.filter((e) => e.sessionId === id)));
    const [i] = (await findIssues(memIndex(events), sessions)).filter((x) => x.id === "flag:no-verification");
    assert.equal(i!.rule, "Run `pnpm test` before you say you are done, and say what it printed.");
  });

  it("a wrapper session with no assistant messages is not flagged for claiming done", async () => {
    const quiet = (id: string) =>
      sessionEvents(id, { cwd, startedAt: 1_700_000_000_000, agent: "wrapper" }, [
        ["session.start", {}],
        ["file.change", { path: `${cwd}/src/a.js`, op: "modify" }],
        ["session.end", {}],
      ]);
    const events = [...quiet("w1"), ...quiet("w2")];
    const sessions = ["w1", "w2"].map((id) => buildSession(events.filter((e) => e.sessionId === id)));
    assert.ok(sessions.every((s) => s.flags?.includes("no-verification")), "the session fold flags them");
    const issues = await findIssues(memIndex(events), sessions);
    assert.equal(issues.find((x) => x.id === "flag:no-verification"), undefined);
  });
});
