// Two sessions for the ClickHouse how-to (docs/how-to/self-host-team.md): one clean run, one that
// failed tool calls and tests. Shared by test/docs/clickhouse-howto.test.ts and the Docker-gated
// deploy/test/clickhouse.test.mjs, which sends it through a real collector into ClickHouse.
import type { AgentEvent, Session } from "../../src/schema/index.ts";

export function clickhouseFixture(now = Date.now()): { batch: AgentEvent[]; sessions: Session[] } {
  const t0 = now - 60_000;
  const ev = (o: Partial<AgentEvent> & Pick<AgentEvent, "id" | "sessionId" | "kind" | "ts">): AgentEvent => ({ v: 0, agent: "claude-code", payload: {}, ...o });
  const ok: Session = {
    id: "ch-howto-ok",
    agent: "claude-code",
    model: "claude-sonnet-4-5",
    title: "add a retry to the uploader",
    startedAt: t0,
    endedAt: t0 + 20_000,
    repo: { root: "/work/app", head: "4f1c2e9" },
    stats: {
      events: 6,
      turns: 2,
      toolCalls: 2,
      toolErrors: 0,
      filesChanged: 1,
      testsPassed: 12,
      testsFailed: 0,
      usage: { inputTokens: 12_000, outputTokens: 1_500, cacheReadTokens: 8_000, cacheWriteTokens: 2_000, costUsd: 0.42 },
    },
    flags: [],
  };
  const failed: Session = {
    id: "ch-howto-failed",
    agent: "codex",
    model: "gpt-5",
    title: "fix the flaky date test",
    startedAt: t0 + 5_000,
    endedAt: t0 + 50_000,
    repo: { root: "/work/app", head: "4f1c2e9" },
    stats: {
      events: 7,
      turns: 3,
      toolCalls: 3,
      toolErrors: 2,
      filesChanged: 2,
      testsPassed: 10,
      testsFailed: 2,
      usage: { inputTokens: 30_000, outputTokens: 4_000, costUsd: 1.25 },
    },
    flags: ["repeated-tool-failure", "no-verification"],
  };
  const tool = (s: Session, n: number, name: string, start: number, ms: number, okFlag: boolean): AgentEvent[] => [
    ev({ id: `${s.id}-ts${n}`, sessionId: s.id, agent: s.agent, kind: "tool.start", ts: start, payload: { tool: name, toolUseId: `${s.id}-tu${n}`, input: { command: "npm test" } } }),
    ev({ id: `${s.id}-te${n}`, sessionId: s.id, agent: s.agent, kind: "tool.end", ts: start + ms, payload: { tool: name, toolUseId: `${s.id}-tu${n}`, ok: okFlag, output: "..." } }),
  ];
  const llm = (s: Session, n: number, ts: number, costUsd: number): AgentEvent =>
    ev({
      id: `${s.id}-llm${n}`,
      sessionId: s.id,
      agent: s.agent,
      kind: "llm.call",
      ts,
      durationMs: 900,
      model: s.model,
      usage: { inputTokens: 6_000, outputTokens: 700, costUsd },
      payload: { provider: s.agent === "codex" ? "openai" : "anthropic", requestModel: s.model, ttftMs: 300, ok: true },
    });
  const batch: AgentEvent[] = [
    ev({ id: `${ok.id}-start`, sessionId: ok.id, kind: "session.start", ts: ok.startedAt }),
    llm(ok, 1, t0 + 1_000, 0.2),
    ...tool(ok, 1, "Read", t0 + 2_000, 40, true),
    ...tool(ok, 2, "Bash", t0 + 3_000, 4_200, true),
    llm(ok, 2, t0 + 8_000, 0.22),
    ev({ id: `${ok.id}-end`, sessionId: ok.id, kind: "session.end", ts: ok.endedAt! }),
    ev({ id: `${failed.id}-start`, sessionId: failed.id, agent: failed.agent, kind: "session.start", ts: failed.startedAt }),
    llm(failed, 1, t0 + 6_000, 0.6),
    ...tool(failed, 1, "Bash", t0 + 8_000, 9_000, false),
    ...tool(failed, 2, "Bash", t0 + 18_000, 11_000, false),
    ...tool(failed, 3, "Edit", t0 + 30_000, 30, true),
    llm(failed, 2, t0 + 31_000, 0.65),
    ev({ id: `${failed.id}-end`, sessionId: failed.id, agent: failed.agent, kind: "session.end", ts: failed.endedAt! }),
  ];
  return { batch, sessions: [ok, failed] };
}
