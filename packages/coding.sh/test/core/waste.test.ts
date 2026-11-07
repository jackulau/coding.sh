import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession, failureFlags } from "../../src/core/sessions.ts";
import { findDuplicateFetches, isReadOnlyCommand, isReadOnlyToolStart, wasteOf } from "../../src/core/waste.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

let n = 0;
let clock = Date.UTC(2026, 10, 7, 9);
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => {
  clock += 1000;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", kind, payload, ...o };
};
/** A tool call: start and end. */
const call = (tool: string, input: unknown, o: { output?: unknown; ok?: boolean; blobs?: string[]; at?: Partial<AgentEvent> } = {}): AgentEvent[] => {
  const id = `tu${n + 1}`;
  return [
    ev("tool.start", { tool, toolUseId: id, input }, o.at),
    ev("tool.end", { tool, toolUseId: id, ok: o.ok ?? true, output: o.output ?? `out of ${JSON.stringify(input)}` }, { ...o.at, ...(o.blobs ? { blobs: o.blobs } : {}) }),
  ];
};
const read = (path: string, o: Parameters<typeof call>[2] = {}) => call("Read", { file_path: path }, { output: `contents of ${path}`, ...o });
const bash = (command: string, o: Parameters<typeof call>[2] = {}) => call("Bash", { command }, o);
const dups = (events: AgentEvent[]) => findDuplicateFetches(events).length;
const start = (tool: string, input: unknown) => ev("tool.start", { tool, toolUseId: "x", input });

describe("isReadOnlyToolStart", () => {
  const yes: [string, unknown][] = [
    ["Read", { file_path: "a.ts" }],
    ["read", { file_path: "a.ts" }],
    ["Grep", { pattern: "foo" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["LS", { path: "." }],
    ["WebFetch", { url: "https://example.com" }],
    ["WebSearch", { query: "x" }],
    ["view", { path: "a.ts" }],
    ["read_file", { path: "a.ts" }],
    ["mcp__github__get_issue", { n: 1 }],
    ["mcp__fs__list_directory", { path: "." }],
    ["mcp__fs__read_text_file", { path: "a" }],
    ["Bash", { command: "cat a | head -5" }],
    ["Bash", { command: "sed -n '1,20p' a.ts" }],
    ["Bash", { command: "rg foo src && git status" }],
    ["Bash", { command: "git log --oneline -5; git diff HEAD~1" }],
    ["Bash", { command: "find . -name '*.ts'" }],
    ["Bash", { command: "ls -la 2>&1" }],
    ["Bash", { command: "grep -r foo . 2>/dev/null" }],
    ["shell", { command: ["cat", "a.txt"] }],
    ["exec_command", { cmd: "wc -l a.ts" }],
  ];
  const no: [string, unknown][] = [
    ["Edit", { file_path: "a.ts" }],
    ["Write", { file_path: "a.ts" }],
    ["Task", { prompt: "x" }],
    ["mcp__github__create_issue", { title: "x" }],
    ["Bash", { command: "sed -i s/x/y/ a" }],
    ["Bash", { command: "sed -n -i 1p a" }],
    ["Bash", { command: "cat > a" }],
    ["Bash", { command: "cat a >> b" }],
    ["Bash", { command: "echo hi | tee out.txt" }],
    ["Bash", { command: "find . -delete" }],
    ["Bash", { command: "find . -name x -exec rm {} ;" }],
    ["Bash", { command: "npm test" }],
    ["Bash", { command: "cat $(ls)" }],
    ["Bash", { command: "cat `ls`" }],
    ["Bash", { command: "git commit -m x" }],
    ["Bash", { command: "" }],
  ];
  for (const [tool, input] of yes) it(`${tool} ${JSON.stringify(input)} only reads`, () => assert.equal(isReadOnlyToolStart(start(tool, input)), true));
  for (const [tool, input] of no) it(`${tool} ${JSON.stringify(input)} can write`, () => assert.equal(isReadOnlyToolStart(start(tool, input)), false));
  it("a wrapper call or a non-start event is never a read", () => {
    assert.equal(isReadOnlyToolStart(ev("tool.start", { tool: "Read", wrapper: true, input: {} })), false);
    assert.equal(isReadOnlyToolStart(ev("tool.end", { tool: "Read", input: {} })), false);
    assert.equal(isReadOnlyCommand(undefined), false);
  });
});

describe("duplicate fetches", () => {
  it("Read(a) then Read(a) with nothing between is one repeat of the first call", () => {
    const events = [...read("/w/a.ts"), ...read("/w/a.ts")];
    assert.deepEqual(findDuplicateFetches(events), [{ eventId: events[2]!.id, firstEventId: events[0]!.id, tool: "Read", estTokens: Math.ceil("contents of /w/a.ts".length / 4) }]);
  });

  it("an edit or file.change of the path in between clears it", () => {
    assert.equal(dups([...read("/w/a.ts"), ...call("Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" }), ...read("/w/a.ts")]), 0);
    assert.equal(dups([...read("/w/a.ts"), ev("file.change", { path: "a.ts", op: "modify" }), ...read("/w/a.ts")]), 0);
    assert.equal(dups([...read("/w/a.ts"), ...call("Edit", { file_path: "/w/b.ts" }), ...read("/w/a.ts")]), 1, "another file's edit keeps it");
  });

  it("a shell command that writes clears searches and listings, not reads", () => {
    assert.equal(dups([...read("/w/a.ts"), ...bash("npm test"), ...read("/w/a.ts")]), 1);
    assert.equal(dups([...call("Grep", { pattern: "foo" }), ...bash("touch x"), ...call("Grep", { pattern: "foo" })]), 0);
    assert.equal(dups([...bash("ls src"), ...bash("touch src/x"), ...bash("ls src")]), 0);
    assert.equal(dups([...call("Grep", { pattern: "foo" }), ...bash("cat a"), ...call("Grep", { pattern: "foo" })]), 1, "a read-only command keeps it");
  });

  it("a subagent's read is not a repeat of its parent's; a compaction clears the context", () => {
    assert.equal(dups([...read("/w/a.ts"), ...read("/w/a.ts", { at: { subagentId: "a1" } })]), 0);
    assert.equal(dups([...read("/w/a.ts"), ev("context.compact", {}), ...read("/w/a.ts")]), 0);
  });

  it("a different output, or a failed first call, is not a repeat", () => {
    assert.equal(dups([...read("/w/a.ts", { output: "v1" }), ...read("/w/a.ts", { output: "v2" })]), 0);
    assert.equal(dups([...read("/w/a.ts", { ok: false, output: "ENOENT" }), ...read("/w/a.ts", { ok: false, output: "ENOENT" })]), 0);
    assert.equal(dups([...read("/w/a.ts", { output: "v1", blobs: ["sha256:aa"] }), ...read("/w/a.ts", { output: "v1", blobs: ["sha256:bb"] })]), 0, "same head, different blob");
  });

  it("the same input with keys in another order, or a command with other spacing, is the same fetch", () => {
    assert.equal(dups([...call("Grep", { pattern: "x", path: "src" }, { output: "hit" }), ...call("Grep", { path: "src", pattern: "x" }, { output: "hit" })]), 1);
    assert.equal(dups([...bash("cat  a.ts", { output: "A" }), ...bash("cat a.ts", { output: "A" })]), 1);
  });

  it("estTokens counts the whole output: the blob's size when it can be read", () => {
    const events = [...read("/w/a.ts", { output: "head", blobs: ["sha256:cc"] }), ...read("/w/a.ts", { output: "head", blobs: ["sha256:cc"] })];
    assert.equal(findDuplicateFetches(events)[0]?.estTokens, 1);
    assert.equal(findDuplicateFetches(events, { blobBytes: (ref) => (ref === "sha256:cc" ? 40_000 : undefined) })[0]?.estTokens, 10_000);
  });

  it("buildSession: stats.waste only when a fetch repeated; the duplicate-fetch flag at 3 in one context, not 2", () => {
    const none = buildSession([...read("/w/a.ts"), ...read("/w/b.ts")]);
    assert.equal(none.stats.waste, undefined);
    const two = [...read("/w/a.ts"), ...read("/w/a.ts"), ...read("/w/a.ts")];
    const s2 = buildSession(two);
    assert.deepEqual(s2.stats.waste, { duplicateFetches: 2, duplicateFetchTokens: 2 * Math.ceil("contents of /w/a.ts".length / 4), readOnlyCalls: 3 });
    assert.ok(!s2.flags.includes("duplicate-fetch"));
    const s3 = buildSession([...two, ...read("/w/a.ts")]);
    assert.ok(s3.flags.includes("duplicate-fetch"));
    assert.ok(failureFlags(s3.flags).includes("duplicate-fetch"));
    assert.equal(wasteOf([...two, ...read("/w/a.ts", { at: { subagentId: "a1" } }), ...read("/w/a.ts", { at: { subagentId: "a1" } })])?.flags.length, 0, "2 + 1 across contexts");
  });
});
