// What coding.sh plans to record, and how. Nothing here ships until its adapter
// passes the conformance suite of recorded sessions.
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
  { name: "Claude Code", capture: "hooks, transcript, subagents", tier: "A", status: "in progress" },
  { name: "Codex", capture: "hooks, rollout files", tier: "A", status: "planned" },
  { name: "OpenCode", capture: "plugin, session db", tier: "A", status: "planned" },
  { name: "Cursor", capture: "hooks, transcript", tier: "A", status: "planned" },
  { name: "Gemini CLI / Antigravity CLI", capture: "hooks, transcript", tier: "A", status: "planned" },
  { name: "Copilot CLI", capture: "hooks, transcript", tier: "A", status: "planned" },
  { name: "Amp", capture: "plugin, stream JSON", tier: "A", status: "planned" },
  { name: "Pi (pi.dev)", capture: "extension, transcript", tier: "A", status: "planned" },
  { name: "Factory Droid", capture: "hooks, transcript", tier: "A", status: "planned" },
  { name: "Goose", capture: "hooks, session db", tier: "A", status: "planned" },
  { name: "Aider", capture: "chat history, headless", tier: "B", status: "planned" },
  { name: "anything else", capture: "wrapper, repo snapshots", tier: "C", status: "planned" },
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
