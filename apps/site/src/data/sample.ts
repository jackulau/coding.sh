// Sample data for the viewer on the landing page. Shapes and labels follow the
// real viewer (packages/coding.sh/src/viewer/ui): sessions with agent, repo,
// duration and tool counts; a timeline of llm.call, tool and subagent spans.
// The stats tiles are computed from these spans, so they always agree.

export type SpanKind = "prompt" | "llm" | "tool" | "subagent";

export interface Span {
  kind: SpanKind;
  /** Tool name, model, subagent type, or "Prompt". */
  name: string;
  /** Short detail: file path, command, query. */
  detail?: string;
  /** Seconds from session start. */
  start: number;
  end: number;
  ok?: boolean;
  ttft?: number;
  /** Tokens in / out for model calls. */
  tin?: number;
  tout?: number;
  children?: Span[];
}

export interface Session {
  id: string;
  title: string;
  agent: string;
  model: string;
  repo: string;
  /** Short status for the list: tests or outcome. */
  outcome: { ok: boolean; text: string };
  ago: string;
  costUsd: number;
  cachedTokens?: number;
  spans: Span[];
}

const llm = (model: string, start: number, end: number, ttft: number, tin: number, tout: number): Span => ({
  kind: "llm", name: model, start, end, ttft, tin, tout, ok: true,
});
const tool = (name: string, detail: string, start: number, end: number, ok = true): Span => ({
  kind: "tool", name, detail, start, end, ok,
});

export const SESSIONS: Session[] = [
  {
    id: "s_8f3a21",
    title: "Add retry with backoff to the orders client",
    agent: "claude-code",
    model: "claude-sonnet-5-5",
    repo: "acme/api",
    outcome: { ok: true, text: "12/12 tests" },
    ago: "4m ago",
    costUsd: 0.31,
    cachedTokens: 141_200,
    spans: [
      { kind: "prompt", name: "Prompt", detail: "Add retry with backoff to fetchOrder", start: 0, end: 0 },
      llm("claude-sonnet-5-5", 0, 2.1, 0.41, 18_400, 310),
      tool("Read", "src/orders/client.ts", 2.1, 2.4),
      tool("Grep", "fetchOrder", 2.4, 2.8),
      llm("claude-sonnet-5-5", 2.8, 5.0, 0.38, 21_900, 240),
      {
        kind: "subagent", name: "Explore", detail: "find existing retry helpers", start: 5.0, end: 17.2, ok: true,
        children: [
          llm("claude-haiku-5-5", 5.1, 6.4, 0.22, 6_100, 120),
          tool("Glob", "src/**/retry*", 6.4, 6.6),
          tool("Read", "src/lib/backoff.ts", 6.6, 6.9),
          llm("claude-haiku-5-5", 6.9, 9.9, 0.25, 9_800, 410),
          tool("Grep", "withBackoff", 9.9, 10.3),
          llm("claude-haiku-5-5", 10.3, 16.9, 0.31, 12_400, 690),
        ],
      },
      llm("claude-sonnet-5-5", 17.2, 24.0, 0.44, 27_300, 1_850),
      tool("Edit", "src/orders/client.ts", 24.0, 24.3),
      tool("Bash", "npm test", 24.3, 39.8, false),
      llm("claude-sonnet-5-5", 39.8, 47.7, 0.52, 31_200, 1_420),
      tool("Edit", "src/orders/client.ts", 47.7, 48.0),
      tool("Bash", "npm test", 48.0, 63.1),
      llm("claude-sonnet-5-5", 63.1, 68.4, 0.39, 33_900, 520),
    ],
  },
  {
    id: "s_77c0e4",
    title: "support-triage",
    agent: "vercel-ai-sdk",
    model: "claude-haiku-5-5-mini",
    repo: "otlp :4318",
    outcome: { ok: true, text: "answered" },
    ago: "9m ago",
    costUsd: 0.004,
    spans: [
      { kind: "prompt", name: "Prompt", detail: "Where is order #4471?", start: 0, end: 0 },
      llm("claude-haiku-5-5-mini", 0, 1.2, 0.41, 1_900, 60),
      tool("lookup_order", "4471", 1.2, 1.45),
      tool("get_shipping", "UPS 1Z…88", 1.45, 1.7),
      llm("claude-haiku-5-5-mini", 1.7, 3.0, 0.38, 2_600, 180),
    ],
  },
  {
    id: "s_19be07",
    title: "Fix the flaky auth test",
    agent: "codex",
    model: "gpt-5.6-sol",
    repo: "acme/web",
    outcome: { ok: true, text: "48/48 tests, 5 repeats" },
    ago: "22m ago",
    costUsd: 0.19,
    cachedTokens: 64_000,
    spans: [
      { kind: "prompt", name: "Prompt", detail: "auth.spec.ts fails 1 in 5 runs", start: 0, end: 0 },
      llm("gpt-5.6-sol", 0, 4.2, 0.9, 12_000, 400),
      tool("shell", "rg -n \"login\" tests/", 4.2, 4.6),
      tool("shell", "sed -n 1,80p tests/auth.spec.ts", 4.6, 4.8),
      llm("gpt-5.6-sol", 4.8, 13.5, 1.1, 19_500, 1_200),
      tool("apply_patch", "tests/auth.spec.ts", 13.5, 13.8),
      tool("shell", "npm test -- auth --repeat 5", 13.8, 41.2),
      llm("gpt-5.6-sol", 41.2, 44.0, 0.8, 21_000, 300),
    ],
  },
  {
    id: "s_c2d950",
    title: "research-planner",
    agent: "openai-agents-sdk",
    model: "claude-haiku-5-5",
    repo: "otlp :4318",
    outcome: { ok: false, text: "hit max turns, no plan" },
    ago: "1h ago",
    costUsd: 0.12,
    spans: [
      { kind: "prompt", name: "Prompt", detail: "Plan a migration to Postgres 17", start: 0, end: 0 },
      llm("claude-haiku-5-5", 0, 1.9, 0.6, 3_100, 220),
      tool("web_search", "postgres 17 upgrade notes", 1.9, 3.1),
      llm("claude-haiku-5-5", 3.1, 5.0, 0.7, 6_800, 260),
      tool("web_search", "pg_upgrade --link", 5.0, 6.2),
      llm("claude-haiku-5-5", 6.2, 8.4, 0.7, 9_900, 240),
      tool("web_search", "pg_upgrade --link rollback", 8.4, 9.5),
      llm("claude-haiku-5-5", 9.5, 11.2, 0.8, 12_600, 90),
    ],
  },
  {
    id: "s_4e6b13",
    title: "Paginate the orders API",
    agent: "cursor",
    model: "claude-sonnet-5-5",
    repo: "acme/api",
    outcome: { ok: false, text: "3/7 tests" },
    ago: "2h ago",
    costUsd: 0.27,
    cachedTokens: 88_000,
    spans: [
      { kind: "prompt", name: "Prompt", detail: "Cursor-based pagination for /orders", start: 0, end: 0 },
      llm("claude-sonnet-5-5", 0, 3.4, 0.5, 15_200, 380),
      tool("read_file", "src/routes/orders.ts", 3.4, 3.7),
      llm("claude-sonnet-5-5", 3.7, 12.9, 0.6, 19_800, 2_400),
      tool("edit_file", "src/routes/orders.ts", 12.9, 13.3),
      tool("run_terminal_cmd", "npm test", 13.3, 24.6, false),
      llm("claude-sonnet-5-5", 24.6, 29.0, 0.5, 24_100, 610),
      tool("edit_file", "src/routes/orders.ts", 29.0, 29.3),
      tool("run_terminal_cmd", "npm test", 29.3, 40.1, false),
      llm("claude-sonnet-5-5", 40.1, 44.8, 0.6, 27_400, 540),
      tool("run_terminal_cmd", "npm test -- orders", 44.8, 51.2, false),
      llm("claude-sonnet-5-5", 51.2, 53.9, 0.5, 29_000, 310),
    ],
  },
  {
    id: "s_a90f3c",
    title: "Upgrade zod to v4",
    agent: "opencode",
    model: "kimi-k2",
    repo: "acme/web",
    outcome: { ok: true, text: "tsc clean, no tests" },
    ago: "3h ago",
    costUsd: 0.08,
    spans: [
      { kind: "prompt", name: "Prompt", detail: "Bump zod to v4 and fix the types", start: 0, end: 0 },
      llm("kimi-k2", 0, 3.0, 0.7, 9_000, 300),
      tool("bash", "npm i zod@4", 3.0, 9.4),
      tool("bash", "npx tsc --noEmit", 9.4, 21.0, false),
      llm("kimi-k2", 21.0, 29.5, 0.9, 16_400, 1_900),
      tool("edit", "src/schema/*.ts (6 files)", 29.5, 30.4),
      tool("bash", "npx tsc --noEmit", 30.4, 41.2, false),
      llm("kimi-k2", 41.2, 45.9, 0.8, 19_700, 640),
      tool("edit", "src/schema/order.ts", 45.9, 46.1),
      tool("bash", "npx tsc --noEmit", 46.1, 56.8),
    ],
  },
];

// ---------------------------------------------------------------- derived

export const flatten = (spans: Span[]): Span[] => spans.flatMap((s) => [s, ...(s.children ? flatten(s.children) : [])]);

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};

export function sessionStats(s: Session) {
  const all = flatten(s.spans);
  const calls = all.filter((x) => x.kind === "llm");
  const tools = all.filter((x) => x.kind === "tool");
  const durations = calls.map((c) => c.end - c.start);
  return {
    duration: Math.max(...all.map((x) => x.end)),
    tokensIn: calls.reduce((n, c) => n + (c.tin ?? 0), 0),
    tokensOut: calls.reduce((n, c) => n + (c.tout ?? 0), 0),
    p95: quantile(durations, 0.95),
    ttftP50: quantile(calls.map((c) => c.ttft ?? 0), 0.5),
    llmCalls: calls.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((t) => t.ok === false).length,
    subagents: all.filter((x) => x.kind === "subagent").length,
  };
}

export const fmtDuration = (sec: number) => {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const fmtCompact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`);
export const fmtCost = (usd: number) => (usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
