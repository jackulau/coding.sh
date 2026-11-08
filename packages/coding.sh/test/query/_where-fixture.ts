// Five sessions and their events that exercise every --where key (shared by the
// SQL-vs-scan test and the cross-surface test).
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { event, session, T0 } from "./_seed.ts";

const H = 3_600_000;
export function fixture(): { sessions: Session[]; events: AgentEvent[] } {
  const repo = (root: string, branch?: string) => ({ root, head: "abc", ...(branch ? { branch } : {}) });
  const sessions: Session[] = [
    session("s1", { agent: "codex", model: "gpt-5.1-codex", repo: repo("/work/demo", "main"), cwd: "/work/demo", startedAt: T0, endedAt: T0 + 20 * 60_000, flags: ["no-verification", "skill:pdf"], title: "Fix the Build", stats: { events: 6, turns: 3, toolCalls: 4, toolErrors: 1, filesChanged: 2, testsFailed: 2, usage: { inputTokens: 900_000, outputTokens: 200_000, cacheReadTokens: 50_000, costUsd: 1.25 } } }),
    session("s2", { agent: "claude-code", model: "claude-sonnet-4-5", repo: repo("/work/other", "feat/x"), cwd: "/work/other/sub", startedAt: T0 + H, endedAt: T0 + H + 5 * 60_000, flags: ["compaction"], title: "write docs", stats: { events: 4, turns: 25, toolCalls: 120, toolErrors: 0, filesChanged: 0, testsPassed: 10, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.02 } } }),
    session("s3", { agent: "claude-code", model: "claude-opus-4-1", cwd: "C:\\Users\\me\\proj", startedAt: T0 + 2 * H, flags: [], title: "50% done_now", stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }),
    session("s4", { agent: "codex", model: "gpt-5.1-codex", repo: repo("/work/demo", "main"), cwd: "/work/demo", startedAt: T0 + 3 * H, endedAt: T0 + 3 * H + 2 * H, parent: { sessionId: "s1", type: "explorer" }, flags: ["skill:docx", "gateway:vercel"], stats: { events: 2, turns: 1, toolCalls: 2, toolErrors: 2, filesChanged: 0, llmErrors: { count: 1, statusCode: 429 }, usage: { inputTokens: 10, outputTokens: 5 } } }),
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
