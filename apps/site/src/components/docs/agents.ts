// Coding-agent adapters as they exist in packages/coding.sh/src/adapters
// (registry: src/adapters/index.ts + src/adapters/more/index.ts), checked
// against each adapter's header comment and docs/ADAPTERS.md on 2026-11-06.
// Every adapter here has fixture tests under test/adapters. "verified" means it
// has also been checked on real sessions; "real-install" means its current release
// was installed and run against a local stub model, with the captured payloads kept
// as fixtures (2026-11-07).

export interface AdapterRow {
  name: string;
  /** Agent id used by --agent and in the trace. */
  id: string;
  /** verified: real sessions; real-install: real binary against a stub model; fixture-tested: recorded payloads only. */
  status: "verified" | "real-install" | "fixture-tested" | "tested";
  /** How live events reach the spool. */
  live: string;
  /** Where `ingest --backfill` reads history from; undefined = no backfill. */
  backfill?: string;
  /** Headless command the eval runner drives. */
  headless: string;
  /** How a subagent shows up. */
  subagents: string;
}

export const ADAPTER_ROWS: AdapterRow[] = [
  {
    name: "Claude Code",
    id: "claude-code",
    status: "verified",
    live: "settings.json hooks",
    backfill: "projects/<slug>/<session>.jsonl transcripts",
    headless: "claude -p --output-format stream-json",
    subagents: "SubagentStart/Stop hooks; subagents/agent-*.jsonl transcripts",
  },
  {
    name: "Codex CLI",
    id: "codex",
    status: "verified",
    live: "hooks.json hooks (you approve them with /hooks)",
    backfill: "sessions/**/rollout-*.jsonl",
    headless: "codex exec --json",
    subagents: "SubagentStart/Stop hooks; subagent threads in rollouts",
  },
  {
    name: "OpenCode",
    id: "opencode",
    status: "real-install",
    live: "plugin (2.x and 1.x)",
    backfill: "opencode.db (1.x and 2.x), JSON storage (older 1.x)",
    headless: "opencode run --format json",
    subagents: "Child sessions, linked to the parent session",
  },
  {
    name: "Cursor CLI",
    id: "cursor",
    status: "fixture-tested",
    live: "hooks.json, partial in -p mode",
    backfill: "agent-transcripts/*.jsonl (undocumented format)",
    headless: "agent -p --output-format stream-json",
    subagents: "subagentStop only (subagentStart is a permission gate, not registered)",
  },
  {
    name: "T3 Code",
    id: "t3code",
    status: "real-install",
    live: "its Codex and Claude Code hooks, tagged as T3",
    backfill: "~/.t3/userdata/statev2.sqlite (and v1 state.sqlite)",
    headless: "none (desktop app; it runs codex app-server or the Claude Agent SDK)",
    subagents: "Subagent threads become child sessions",
  },
  {
    name: "Antigravity CLI (formerly Gemini CLI)",
    id: "antigravity",
    status: "verified",
    live: "hooks.json",
    backfill: "brain/<id>/…/transcript.jsonl",
    headless: "agy -p --output-format stream-json",
    subagents: "invoke_subagent tool call spans the subagent; its internals are not exposed",
  },
  {
    name: "Gemini CLI, older installs",
    id: "gemini-cli",
    status: "fixture-tested",
    live: "settings.json hooks",
    backfill: "tmp/<slug>/chats/*.jsonl",
    headless: "gemini -p -o stream-json",
    subagents: "Child chat files become child sessions",
  },
  {
    name: "GitHub Copilot CLI",
    id: "copilot-cli",
    status: "real-install",
    live: "hooks/coding-sh.json",
    backfill: "session-state/<id>/events.jsonl",
    headless: "copilot -p --output-format=json",
    subagents: "subagentStart/Stop hooks; events inside carry the subagent id",
  },
  {
    name: "Amp",
    id: "amp",
    status: "fixture-tested",
    live: "plugin",
    headless: "amp -x --stream-json",
    subagents: "Task, oracle, librarian, finder tool calls span the subagent",
  },
  {
    name: "Pi",
    id: "pi",
    status: "real-install",
    live: "extension",
    backfill: "sessions/--<cwd>--/*.jsonl",
    headless: "pi -p --mode json",
    subagents: "None (Pi has no subagents)",
  },
  {
    name: "Factory Droid",
    id: "droid",
    status: "real-install",
    live: "hooks.json",
    backfill: "sessions/-<cwd>/*.jsonl",
    headless: "droid exec -o json",
    subagents: "Task tool call is the start, SubagentStop the end",
  },
  {
    name: "Goose",
    id: "goose",
    status: "real-install",
    live: "plugin hooks.json",
    backfill: "sessions.db",
    headless: "goose run --output-format stream-json",
    subagents: "sub_agent sessions become child sessions",
  },
  {
    name: "Any other command",
    id: "wrapper",
    status: "tested",
    live: "coding.sh run -- <cmd>",
    headless: "the command itself",
    subagents: "None",
  },
];

/** Researched in docs/ADAPTERS.md, no adapter in code yet. */
export const PLANNED_AGENTS = ["Cline CLI", "Kiro CLI", "Qwen Code", "Crush"] as const;

export const STATUS_LABEL: Record<AdapterRow["status"], string> = {
  verified: "Verified on real sessions",
  "real-install": "Verified on a real install",
  "fixture-tested": "Fixture-tested",
  tested: "Tested",
};
