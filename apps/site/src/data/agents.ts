// The agents coding.sh records, and how. Every row here has an adapter in
// packages/coding.sh/src/adapters with fixture tests; Claude Code, Codex and
// Antigravity CLI are also verified on real sessions (CHANGELOG 0.1.0). The full
// per-adapter table is src/components/docs/agents.ts.
//
// Tier A: live hooks or plugin + local transcript + headless runner.
// Tier B: local transcript + headless runner.
// Tier C: wrapper only (`coding.sh run -- <cmd>`): repo snapshots before/after.

export type Tier = "A" | "B" | "C";
export type Status = "planned" | "in progress" | "supported";

export interface Agent {
  name: string;
  /** How events are captured, shortest first. */
  capture: string;
  tier: Tier;
  status: Status;
}

export const AGENTS: Agent[] = [
  { name: "Claude Code", capture: "hooks, transcript, subagents", tier: "A", status: "supported" },
  { name: "Codex", capture: "hooks, rollout files", tier: "A", status: "supported" },
  { name: "OpenCode", capture: "plugin, session db", tier: "A", status: "supported" },
  { name: "Cursor", capture: "hooks, transcript", tier: "B", status: "supported" },
  { name: "Antigravity CLI", capture: "hooks, transcript", tier: "A", status: "supported" },
  { name: "Copilot CLI", capture: "hooks, transcript", tier: "A", status: "supported" },
  { name: "Amp", capture: "plugin, stream JSON", tier: "A", status: "supported" },
  { name: "Pi (pi.dev)", capture: "extension, transcript", tier: "A", status: "supported" },
  { name: "Factory Droid", capture: "hooks, transcript", tier: "A", status: "supported" },
  { name: "Goose", capture: "hooks, session db", tier: "A", status: "supported" },
  { name: "T3 Code", capture: "its Codex and Claude Code hooks, local state db", tier: "B", status: "supported" },
  { name: "Aider", capture: "wrapper, headless", tier: "C", status: "supported" },
  // No adapter yet; `coding.sh run --` records it (docs/agents, "Kiro CLI").
  { name: "Kiro CLI", capture: "wrapper, repo snapshots", tier: "C", status: "supported" },
  { name: "anything else", capture: "wrapper, repo snapshots", tier: "C", status: "supported" },
];

/** Agent frameworks that export OpenTelemetry GenAI spans to the local receiver. */
export const FRAMEWORKS = [
  "Vercel AI SDK",
  "Claude Agent SDK",
  "OpenAI Agents SDK",
  "LangGraph",
  "any OTel GenAI exporter",
] as const;

export const OTLP_ENDPOINT = "http://127.0.0.1:4318";
