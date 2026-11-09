// Five sessions and their events that exercise every --where key, and queries over
// them (shared by the SQL-vs-scan test, the cross-surface test and the Postgres and
// ClickHouse store plugins' tests).
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { event, session, T0 } from "./_seed.ts";

const H = 3_600_000;
export function fixture(): { sessions: Session[]; events: AgentEvent[] } {
  const repo = (root: string, branch?: string) => ({ root, head: "abc", ...(branch ? { branch } : {}) });
  const sessions: Session[] = [
    session("s1", { agent: "codex", model: "gpt-5.1-codex", repo: repo("/work/demo", "main"), cwd: "/work/demo", startedAt: T0, endedAt: T0 + 20 * 60_000, flags: ["no-verification", "skill:pdf"], title: "Fix the Build", stats: { events: 6, turns: 3, toolCalls: 4, toolErrors: 1, filesChanged: 2, testsFailed: 2, usage: { inputTokens: 900_000, outputTokens: 200_000, cacheReadTokens: 50_000, costUsd: 1.25 }, cacheBreaks: { count: 2, lostTokens: 30_000, extraUsd: 0.14, byCause: { idle: { count: 2, lostTokens: 30_000, extraUsd: 0.14 } } } } }),
    session("s2", { agent: "claude-code", model: "claude-sonnet-4-5", repo: repo("/work/other", "feat/x"), cwd: "/work/other/sub", startedAt: T0 + H, endedAt: T0 + H + 5 * 60_000, flags: ["compaction", "unapproved-action"], title: "write docs", stats: { events: 4, turns: 25, toolCalls: 120, toolErrors: 0, filesChanged: 0, testsPassed: 10, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.02 }, unapprovedActions: { count: 2, byKind: { "rm-rf": 1, paid: 1 }, first: { kind: "rm-rf", command: "rm -rf src", at: T0 + H + 60_000, afterError: true } } } }),
    session("s3", { agent: "claude-code", model: "claude-opus-4-1", cwd: "C:\\Users\\me\\proj", startedAt: T0 + 2 * H, flags: [], title: "50% done_now", stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }),
    session("s4", { agent: "codex", model: "gpt-5.1-codex", repo: repo("/work/demo", "main"), cwd: "/work/demo", startedAt: T0 + 3 * H, endedAt: T0 + 3 * H + 2 * H, parent: { sessionId: "s1", type: "explorer" }, flags: ["skill:docx", "gateway:vercel"], stats: { events: 2, turns: 1, toolCalls: 2, toolErrors: 2, filesChanged: 0, llmErrors: { count: 1, statusCode: 429 }, usage: { inputTokens: 10, outputTokens: 5 }, cacheBreaks: { count: 1, lostTokens: 5000, byCause: { other: { count: 1, lostTokens: 5000 } }, unpriced: 1 } } }),
    session("s5", { agent: "gemini", runId: "run_42", startedAt: T0 + 4 * H, endedAt: T0 + 4 * H + 30_000, flags: ["repeated-tool-failure"], stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 5, outputTokens: 5, costUsd: 0 } } }),
  ];
  const tool = (sid: string, n: number, kind: "tool.start" | "tool.end", payload: Record<string, unknown>, over: Partial<AgentEvent> = {}) => event(sid, n, { kind, payload, ...over, agent: sessions.find((s) => s.id === sid)!.agent });
  const events: AgentEvent[] = [
    event("s1", 1, { agent: "codex", payload: { text: "please fix the flaky migration test" } }),
    tool("s1", 2, "tool.start", { tool: "Bash", input: { command: "npm test" } }),
    tool("s1", 3, "tool.end", { tool: "Bash", ok: false, error: "Exit code 1: ENOENT missing file" }, { durationMs: 45_000 }),
    tool("s1", 4, "tool.end", { tool: "Edit", ok: true }, { durationMs: 200 }),
    event("s2", 1, { payload: { text: "write the docs for the deploy" } }),
    tool("s2", 2, "tool.start", { tool: "mcp__github__search", server: "github", input: { query: "deploy docs" } }),
    tool("s2", 3, "tool.end", { tool: "mcp__github__search", ok: true }, { durationMs: 1200 }),
    tool("s2", 4, "tool.end", { tool: "Read", ok: true }),
    event("s3", 1, { payload: { text: "hello there migration" } }),
    tool("s3", 2, "tool.end", { tool: "Bash", ok: true }, { durationMs: 10 }),
    tool("s4", 1, "tool.end", { tool: "Bash", ok: false, error: "permission denied" }),
    tool("s4", 2, "tool.end", { tool: "Grep", ok: false }),
    { ...event("s4", 3, { agent: "codex", kind: "llm.call", payload: { ok: false, statusCode: 429 } }) },
  ];
  return { sessions, events };
}

/** Queries over the fixture: the SQL path and the scan fallback must return the same ids for each. */
/**
 * Sessions whose repo name is not simply the last part of the path: `claude -p` from a script
 * runs in $TMPDIR, on macOS /var/folders/<xx>/<yyy>/T, named "tmp" rather than "T".
 * REPO_NAMES: their repo facet, by value.
 */
export function repoNameSessions(): Session[] {
  const at = (k: number) => ({ startedAt: T0 - (k + 1) * 60_000, endedAt: T0 - k * 60_000 });
  return [
    session("mac-tmp", { cwd: "/var/folders/k2/x7q9b_1n0000gn/T", ...at(0) }),
    session("mac-private-tmp", { cwd: "/private/var/folders/k2/x7q9b_1n0000gn/T", ...at(1) }),
    session("under-tmp", { cwd: "/var/folders/k2/x7q9b_1n0000gn/T/tmp.Ab12", ...at(2) }),
    session("linux-tmp", { cwd: "/tmp", ...at(3) }),
    session("win-t", { cwd: "C:\\work\\T", ...at(4) }),
  ];
}
export const REPO_NAMES: [string, number][] = [["T", 1], ["tmp", 3], ["tmp.Ab12", 1]];

export const QUERIES = [
  "agent:codex",
  "agent:codex,gemini",
  "-agent:codex",
  "model:claude-*",
  "model:CLAUDE-*",
  "model:claude-sonnet-4-5",
  "repo:demo",
  "repo:/work/other",
  "repo:proj",
  "repo:sub",
  "branch:feat/*",
  "dir:/work/*",
  "title:build",
  "title:BUILD",
  'title:"50%"',
  "title:done_now",
  "title:done*now",
  "-title:build",
  "flag:compaction",
  "flag:skill:*",
  "skill:pdf",
  "skill:d*",
  "-flag:skill:pdf",
  "is:flagged",
  "-is:flagged",
  "is:root",
  "is:child",
  "is:run",
  "is:ended",
  "has:tests",
  "has:cost",
  "-has:cost",
  "has:repo",
  "has:error",
  "since:2d",
  "since:2026-11-01T11:30:00Z",
  "until:2026-11-01T12:00:00Z",
  "duration>10m",
  "duration:1m..3h",
  "-duration>10m",
  "turns>=3",
  "turns:1",
  "tools>100",
  "tool.errors>0",
  "llm.errors>0",
  "tests.failed>0",
  "tests.passed>=10",
  "tokens>1M",
  "tokens.in<1k",
  "-tokens>100",
  "cost>0.5",
  "cost:0",
  "cost<=0.02",
  "-cost>0.5",
  "cache.breaks>0",
  "cache.breaks>=2",
  "cache.lost>10k",
  "cache.cost>0.1",
  "-cache.breaks>0",
  "sort:-cache.lost",
  "unapproved>0",
  "unapproved>=2",
  "-unapproved>0",
  "files>=1",
  "events<3",
  "run:run_*",
  "parent:s1",
  "id:s*",
  "id:s4",
  "id:s4,s2",
  "-id:s4",
  "provider:x",
  "tool:Bash",
  "-tool:Bash",
  "tool:Bash ok:false",
  "tool:Bash -ok:true",
  "(tool:Bash OR tool:Read) ok:true",
  "tool:Bash ok:false agent:codex",
  "-(tool:Bash ok:false)",
  "kind:llm.call ok:false",
  "kind:tool.*",
  "mcp:github",
  "error:enoent",
  "error:*denied",
  "event.duration>30s",
  "event.duration:1s..2s",
  "migration",
  "migration flaky",
  "-migration",
  '"fix the"',
  "migration OR deploy",
  "agent:codex OR model:claude-opus-*",
  "(agent:codex OR agent:gemini) -is:child",
  "agent:claude-code (tool:Read OR cost>1)",
  "-(agent:codex OR has:tests)",
  "agent:codex sort:-cost",
  "sort:cost",
  "sort:-duration",
  "sort:tokens",
  "sort:started",
  "sort:-turns limit:2",
];
