// The agents coding.sh records, and how. Every row here has an adapter in
// packages/coding.sh/src/adapters with fixture tests; Claude Code, Codex and
// Antigravity CLI are also verified on real sessions (CHANGELOG 0.1.0). The full
// per-adapter table is src/components/docs/agents.ts.
//

export type Status = "planned" | "in progress" | "supported";

export interface Agent {
  name: string;
  /** How events are captured, shortest first. */
  capture: string;
  status: Status;
}

export const AGENTS: Agent[] = [
  { name: "Claude Code", capture: "hooks, transcript, subagents", status: "supported" },
  { name: "Codex", capture: "hooks, rollout files", status: "supported" },
  { name: "OpenCode", capture: "plugin, session db", status: "supported" },
  { name: "Cursor", capture: "hooks, transcript", status: "supported" },
  { name: "Antigravity CLI", capture: "hooks, transcript", status: "supported" },
  { name: "Copilot CLI", capture: "hooks, transcript", status: "supported" },
  { name: "Amp", capture: "plugin, stream JSON", status: "supported" },
  { name: "Pi (pi.dev)", capture: "extension, transcript", status: "supported" },
  { name: "Factory Droid", capture: "hooks, transcript", status: "supported" },
  { name: "Goose", capture: "hooks, session db", status: "supported" },
  { name: "T3 Code", capture: "its Codex and Claude Code hooks, local state db", status: "supported" },
  // No adapter yet; `coding.sh run --` records it (docs/agents, "Kiro CLI").
  { name: "Kiro CLI", capture: "wrapper, repo snapshots", status: "supported" },
  { name: "anything else", capture: "wrapper, repo snapshots", status: "supported" },
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
