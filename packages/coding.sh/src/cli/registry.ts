// Static command metadata: everything `--help` needs, with no imports beyond
// types. Command modules load lazily through `load()` only after dispatch, so
// help and typo suggestions never touch stores, adapters or the network.
import type { FlagSpec } from "./args.ts";
import type { CommandModule } from "./types.ts";
import { GATEWAY_IDS } from "../integrations/gateway/providers.ts";
import { WORKFLOWS_COMMAND } from "../workflows/cli-spec.ts";
import { BENCH_COMMAND } from "../bench/cli-spec.ts";
import { durableFlags } from "../jobs/flags.ts";
import { DEFAULT_MODELS } from "../core/pricing.ts";

export interface ArgSpec {
  name: string;
  desc: string;
  required?: boolean;
  /** Takes the rest of the positionals. */
  variadic?: boolean;
}

export interface ActionSpec {
  name: string;
  summary: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  examples?: string[];
  /** The first Ctrl-C lets trials in flight finish (c.drain); the second stops them (c.signal). */
  graceful?: boolean;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  group: "Capture" | "Explore" | "Evaluate" | "Harness" | "Maintain";
  summary: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  /** Subcommands (`eval new`, `config get`, …). */
  actions?: ActionSpec[];
  /** Takes `-- <cmd> [args...]`. */
  passthrough?: boolean;
  /** With actions: also runs with none (`serve` vs `serve keygen`); the command's own flags apply then. */
  actionOptional?: boolean;
  /** Handles SIGINT/SIGTERM itself (graceful shutdown) and returns its own exit code. */
  handlesSignals?: boolean;
  /** See ActionSpec.graceful (for a command without actions). */
  graceful?: boolean;
  examples?: string[];
  notes?: string[];
  load(): Promise<CommandModule>;
}

// ------------------------------------------------------------ shared flags

export const YES: FlagSpec = { name: "yes", short: "y", type: "boolean", desc: "Answer yes to confirmation prompts" };
export const DRY_RUN: FlagSpec = { name: "dry-run", type: "boolean", desc: "Show the exact changes without writing anything" };
export const FORCE: FlagSpec = { name: "force", type: "boolean", desc: "Replace the named target when it already exists" };
const AGENT_LIST: FlagSpec = { name: "agent", short: "a", type: "list", value: "<AGENT>", desc: "Only this agent (repeatable)" };
const AGENT_ONE: FlagSpec = { name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Only sessions from this agent" };
const SINCE: FlagSpec = { name: "since", type: "string", value: "<WHEN>", desc: "Only after this time: 7d, 12h, 30m or a date" };
const FRESH: FlagSpec = { name: "fresh", type: "boolean", desc: "Wait for every pending capture to be ingested (default: answer after 1.5 s)" };
/** What a read answered before every capture was indexed says, for --json readers. */
const PENDING_NOTE = 'With --json, an answer given before every capture was indexed carries "pending": {"files": N, "indexing": true|false} (files still to ingest; indexing: an ingest is still running). The field is absent once all are indexed.';
const LIMIT = (d: number): FlagSpec => ({ name: "limit", short: "n", type: "number", value: "<N>", desc: "Maximum rows", default: String(d) });
const GATEWAY_NAME: FlagSpec = { name: "gateway", type: "string", value: "<NAME>", choices: GATEWAY_IDS, desc: "Only this gateway" };

/** The acceptance gate (compare --gate, exp compare --gate). */
const GATE_FLAGS: FlagSpec[] = [
  { name: "gate", type: "boolean", desc: "Ship-or-hold decision: exit 0 when B wins enough without breaking what A solved, 1 otherwise" },
  { name: "lambda", type: "number", value: "<N>", desc: "With --gate: what breaking one solved item costs, in fixed items", default: "2" },
  { name: "gate-alpha", type: "number", value: "<A>", desc: "With --gate: one-sided significance level", default: "0.05" },
  { name: "tau", type: "number", value: "<T>", desc: "With --gate: largest share of solved items B may break", default: "0.10" },
];

/** Flags that describe an experiment run (exp run, exp aa). */
const EXP_RUN_FLAGS: FlagSpec[] = [
  { name: "dataset", short: "d", type: "string", value: "<ID>", desc: "Dataset id" },
  { name: "task", type: "string", value: "<JSON|FILE>", desc: 'Task spec: {"kind":"command","command":"…"} (gets each case input as JSON on stdin) or {"kind":"http","url":"…"}' },
  { name: "grader", short: "g", type: "list", value: "<JSON|FILE>", desc: 'Grader spec, e.g. {"kind":"exact"} (repeatable)' },
  { name: "name", type: "string", value: "<NAME>", desc: "Experiment name" },
  { name: "trials", type: "number", value: "<N>", desc: "Attempts per case", default: "1" },
  { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel case runs", default: "4" },
  { name: "split", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Only cases in this split" },
];

const SCOPE: FlagSpec = { name: "scope", type: "string", value: "<SCOPE>", choices: ["user", "project"], desc: "Install into user or project config", default: "user" };

/** Global options accepted by every command (handled in main.ts). */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "json", type: "boolean", desc: "Print one JSON document on stdout" },
  { name: "no-color", type: "boolean", desc: "Disable color (also NO_COLOR=1)" },
  { name: "debug", type: "boolean", desc: "Show stack traces on errors" },
  { name: "help", short: "h", type: "boolean", desc: "Show help" },
  { name: "store", type: "string", value: "<URL>", desc: "Read and write this index store instead of the configured one (also CODING_SH_STORE_URL); skips auto-ingest" },
  { name: "blobs", type: "string", value: "<URL>", desc: "Blob store to use with --store (also CODING_SH_BLOB_URL; a postgres:// index keeps blobs in the same DB)" },
];

export const COMMANDS: CommandSpec[] = [
  // ---------------------------------------------------------- Capture
  {
    name: "init",
    group: "Capture",
    summary: "Set up capture hooks and the MCP server for every detected agent",
    flags: [
      AGENT_LIST,
      SCOPE,
      { name: "mcp", type: "boolean", desc: "Register the coding.sh MCP server too (--no-mcp to skip)", default: "true" },
      { name: "force", type: "boolean", desc: "Install hooks even when the agent already has coding.sh hooks in the other scope" },
      YES,
      { name: "dry-run", type: "boolean", desc: "Print the plan (agents, files, blockers) without writing anything" },
      { name: "diff", type: "boolean", desc: "With --dry-run, also print the full diff of every planned edit" },
    ],
    examples: ["coding.sh init", "coding.sh init --agent claude-code --yes", "coding.sh init --dry-run"],
    notes: [
      "Copies the hook to ~/.coding.sh/bin/hook.mjs and points each agent at it.",
      "Registers the MCP server with Claude Code, Codex, Cursor, OpenCode and Gemini CLI (user scope only).",
      "Every edited file is backed up to ~/.coding.sh/backups first; uninstall reverts it.",
    ],
    load: () => import("./commands/init.ts"),
  },
  {
    name: "doctor",
    group: "Capture",
    summary: "Check agents, hooks, spool, store and the OTLP port",
    flags: [AGENT_LIST, { name: "port", type: "number", value: "<PORT>", desc: "OTLP receiver port to check", default: "4318" }],
    examples: ["coding.sh doctor", "coding.sh doctor --json"],
    load: () => import("./commands/doctor.ts"),
  },
  {
    name: "status",
    group: "Capture",
    summary: "Show capture totals and the latest session",
    flags: [FRESH],
    notes: [PENDING_NOTE],
    load: () => import("./commands/status.ts"),
  },
  {
    name: "ingest",
    group: "Capture",
    summary: "Move captured hook events from the spool into the index",
    flags: [
      { name: "backfill", type: "boolean", desc: "Also import agents' local transcript history" },
      { name: "rebuild", type: "boolean", desc: "Re-parse every stored session (of --agent) from its transcript and spool with the current adapters" },
      AGENT_LIST,
      SINCE,
      { name: "background", type: "boolean", desc: "Don't wait for another ingest; exit quietly if one is running" },
    ],
    examples: ["coding.sh ingest", "coding.sh ingest --backfill --since 30d", "coding.sh ingest --rebuild --agent pi"],
    notes: [
      "Rarely needed: read commands, the viewer and the MCP server ingest first, and the hook starts one when a session ends.",
      "After an upgrade, sessions stored by an older adapter parse are re-parsed in the background. --rebuild does it for every session now; a session whose transcript and spool lines are gone keeps its rows, minus duplicates.",
    ],
    load: () => import("./commands/ingest.ts"),
  },
  {
    name: "run",
    group: "Capture",
    summary: "Run any agent command and capture the session",
    passthrough: true,
    args: [{ name: "cmd", desc: "Command and arguments after --", required: true, variadic: true }],
    flags: [{ name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Agent id to record", default: "wrapper" }],
    examples: ["coding.sh run -- aider --message 'fix the tests'"],
    notes: ["Exits with the command's exit code."],
    load: () => import("./commands/run.ts"),
  },
  {
    name: "collector",
    aliases: ["otel"],
    group: "Capture",
    summary: "Start a local OTLP/HTTP receiver for agents that export traces",
    flags: [
      { name: "port", short: "p", type: "number", value: "<PORT>", desc: "Port to listen on (0 = any free port)", default: "4318" },
      { name: "host", type: "string", value: "<HOST>", desc: "Interface to bind", default: "127.0.0.1" },
    ],
    examples: ["coding.sh collector", "coding.sh otel --port 0"],
    notes: ["Prints the OTEL_* environment to stdout; status goes to stderr."],
    load: () => import("./commands/collector.ts"),
  },
  {
    name: "serve",
    group: "Capture",
    summary: "Production server: OTLP + native ingest, viewer, health and metrics on one port",
    actionOptional: true,
    handlesSignals: true,
    flags: [
      { name: "host", type: "string", value: "<HOST>", desc: "Interface to bind (also CODING_SH_HOST)", default: "127.0.0.1" },
      { name: "port", short: "p", type: "number", value: "<PORT>", desc: "Port to listen on, 0 = any free port (also CODING_SH_PORT, PORT)", default: "4318" },
      { name: "config", type: "string", value: "<FILE>", desc: "Config file instead of ~/.coding.sh/config.toml" },
      { name: "role", type: "string", value: "<ROLE>", choices: ["all", "viewer"], desc: "viewer: a read replica with no ingest and no writer lock", default: "all" },
      { name: "insecure", type: "boolean", desc: "Allow a non-loopback bind with no keys (also CODING_SH_INSECURE=1)" },
    ],
    actions: [
      {
        name: "keygen",
        summary: "Print a new ingest (or read) key once, plus the sha256 line for a config file",
        flags: [
          { name: "project", type: "string", value: "<ID>", desc: "Project the key belongs to (read keys: * for all)", default: "default" },
          { name: "read", type: "boolean", desc: "A read key (viewer, /api, /metrics) instead of an ingest key" },
        ],
        examples: ["coding.sh serve keygen --project demo", "coding.sh serve keygen --read --project '*'"],
      },
      {
        name: "healthcheck",
        summary: "Exit 0 when the server answers 200, 1 otherwise (Docker HEALTHCHECK)",
        flags: [
          { name: "url", type: "string", value: "<URL>", desc: "URL to probe (default http://127.0.0.1:<port>/healthz)" },
          { name: "timeout", type: "number", value: "<MS>", desc: "Give up after this many milliseconds", default: "3000" },
        ],
        examples: ["coding.sh serve healthcheck", "coding.sh serve healthcheck --url http://127.0.0.1:4318/readyz"],
      },
    ],
    examples: [
      "coding.sh serve",
      "CODING_SH_STORE_URL=postgres://… CODING_SH_INGEST_KEYS=demo:$KEY CODING_SH_READ_KEYS='*:'$READ coding.sh serve --host 0.0.0.0",
      "coding.sh serve --role viewer --host 0.0.0.0",
    ],
    notes: [
      "Routes: POST /v1/traces, /v1/logs, /v1/metrics (OTLP/HTTP), POST /v1/ingest (native), GET / and /api/* (viewer), /healthz, /readyz, /metrics.",
      "Precedence: flags > env > --config file > defaults. See docs/PRODUCTION.md for every setting.",
      "A non-loopback bind needs an ingest key and a read key (or basic auth), or --insecure; on loopback with no keys, ingest is open to project default.",
      "Prints the URL (or one JSON document with --json) on stdout once ready; logs go to stderr. SIGTERM/SIGINT drain the queue (25s) and exit 0.",
    ],
    load: () => import("./commands/serve.ts"),
  },
  {
    name: "uninstall",
    group: "Capture",
    summary: "Remove coding.sh hooks and MCP entries from every agent",
    flags: [AGENT_LIST, SCOPE, YES, DRY_RUN],
    examples: ["coding.sh uninstall --dry-run", "coding.sh uninstall --yes"],
    notes: ["Captured data in ~/.coding.sh is kept."],
    load: () => import("./commands/uninstall.ts"),
  },
  // ---------------------------------------------------------- Explore
  {
    name: "sessions",
    group: "Explore",
    summary: "List captured sessions",
    flags: [
      AGENT_ONE,
      { name: "repo", short: "r", type: "string", value: "<PATH>", desc: "Only sessions in this repo root" },
      SINCE,
      LIMIT(20),
      { name: "subagents", type: "boolean", desc: "Include subagent sessions" },
      { name: "project", type: "string", value: "<ID>", desc: "Only sessions in this serve project (default: all)" },
      { name: "flag", type: "string", value: "<NAME>", desc: "Only sessions with this flag: looping, failure-streak, churn, no-progress, stalled, context-thrash, premature-completion, duplicate-fetch, …, or a tag such as skill:<name>" },
      FRESH,
    ],
    examples: ["coding.sh sessions", "coding.sh sessions --agent codex --since 7d", "coding.sh sessions --flag looping --since 7d", "coding.sh sessions --store postgres://… --project demo"],
    notes: [PENDING_NOTE],
    load: () => import("./commands/sessions.ts"),
  },
  {
    name: "show",
    group: "Explore",
    summary: "Show a session timeline with subagents and latency",
    args: [{ name: "session", desc: "Session id, a unique prefix of one (4+ characters, like a git short hash), or 'latest'", required: true }],
    flags: [
      { name: "limit", short: "n", type: "number", value: "<N>", desc: "List the first N events (default 200; a longer session shows as phases)" },
      { name: "all", type: "boolean", desc: "List every event, with phase and day lines and derail markers" },
      { name: "follow", short: "f", type: "boolean", desc: "Keep printing new events as a running session goes on (Ctrl-C to stop)" },
    ],
    examples: ["coding.sh show latest", "coding.sh show 9f1c2e", "coding.sh show 9f1c2e --all", "coding.sh show latest --follow"],
    notes: ["A session with more than 200 events shows one line per phase: the start, each resume, compaction and long idle gap, with where it derailed."],
    load: () => import("./commands/show.ts"),
  },
  {
    name: "search",
    group: "Explore",
    summary: "Full-text search over prompts, replies and tool calls",
    args: [{ name: "text", desc: "Search text", required: true, variadic: true }],
    flags: [AGENT_ONE, LIMIT(20), { name: "project", type: "string", value: "<ID>", desc: "Only matches in this serve project (default: all)" }, FRESH],
    examples: ["coding.sh search 'flaky test'"],
    notes: [PENDING_NOTE],
    load: () => import("./commands/search.ts"),
  },
  {
    name: "usage",
    group: "Explore",
    summary: "Tokens, cost, turns and cache hits by agent, model or day",
    flags: [
      { name: "by", type: "string", value: "<GROUP>", choices: ["agent", "model", "agent-model", "day", "repo"], desc: "Group rows by", default: "agent" },
      AGENT_ONE,
      { ...SINCE, default: "30d" },
      LIMIT(20),
      { name: "reprice", type: "boolean", desc: "Recompute estimated costs from the current price table first" },
    ],
    examples: ["coding.sh usage", "coding.sh usage --by agent-model --since 90d", "coding.sh usage --by model --reprice"],
    load: () => import("./commands/usage.ts"),
  },
  {
    name: "ui",
    group: "Explore",
    summary: "Open the local session viewer",
    flags: [
      { name: "port", short: "p", type: "number", value: "<PORT>", desc: "First port to try (0 = any free port)", default: "4319" },
      { name: "host", type: "string", value: "<HOST>", desc: "Interface to bind", default: "127.0.0.1" },
      { name: "open", type: "boolean", desc: "Open the browser (--no-open to skip)", default: "true" },
    ],
    examples: ["coding.sh ui", "coding.sh ui --no-open --port 0"],
    notes: ["Running coding.sh with no command opens the viewer (or sets up capture first)."],
    load: () => import("./commands/ui.ts"),
  },
  {
    name: "mcp",
    group: "Explore",
    summary: "Serve captured sessions to agents over MCP (stdio)",
    args: [{ name: "action", desc: "serve (default): run the server; config: print how to register it" }],
    examples: ["coding.sh mcp config", "coding.sh mcp"],
    notes: [
      "Agents start this themselves once coding.sh init has registered it.",
      "stdout carries MCP frames only.",
      "Tool calls ingest pending captures for up to 1.5 s (CODING_SH_READ_BUDGET_MS), then answer from what is indexed with a pending: {files, indexing} field.",
    ],
    load: () => import("./commands/mcp.ts"),
  },
  // ---------------------------------------------------------- Evaluate
  {
    name: "eval",
    group: "Evaluate",
    summary: "Turn sessions into replayable eval tasks",
    actions: [
      {
        name: "new",
        summary: "Draft a task from a captured session",
        args: [{ name: "session", desc: "Session id, or 'latest'", required: true }],
        flags: [
          { name: "name", type: "string", value: "<NAME>", desc: "Task name" },
          { name: "instruction", type: "string", value: "<TEXT|@FILE>", desc: "What the agent is asked to do (default: the session's first prompt)" },
          { name: "verifier", type: "string", value: "<CMD>", desc: "Command that passes only when the task is solved" },
          { name: "setup", type: "list", value: "<CMD>", desc: "Setup command (repeatable)" },
          { name: "hidden-test", type: "list", value: "<GLOB>", desc: "Test files to hide from the agent (repeatable)" },
          { name: "tag", type: "list", value: "<TAG>", desc: "Tag (repeatable)" },
        ],
        examples: ["coding.sh eval new latest --verifier 'npm test'", "coding.sh eval new latest --instruction @prompt.md --verifier 'npm test'"],
      },
      {
        name: "import",
        summary: "Add tasks from task directories (hand-written, or from eval export)",
        args: [{ name: "dir", desc: "Task directory: task.json, instruction.md, optional repo/ (the start tree) and tests/ (hidden verifier files)", required: true, variadic: true }],
        examples: ["coding.sh eval import tasks/*/"],
      },
      {
        name: "validate",
        summary: "Check the reference passes, near-misses fail and nothing leaks",
        args: [{ name: "task", desc: "Task id or name", required: true }],
        flags: [
          { name: "k", type: "number", value: "<N>", desc: "Reference must pass N of N runs", default: "5" },
          { name: "keep", type: "boolean", desc: "Keep work directories" },
          { name: "strict-coupling", type: "boolean", desc: "Fail validation when a hidden test names an identifier or file only the reference introduces" },
        ],
      },
      {
        name: "crosscheck",
        summary: "Ask a model whether stored solutions are valid and count where the verifier disagrees",
        args: [{ name: "task", desc: "Task id or name", required: true }],
        flags: [
          { name: "experiment", type: "string", value: "<ID>", desc: "Only runs from this experiment (default: every stored run of the task)" },
          { name: "max", type: "number", value: "<N>", desc: "Runs to review (one model call each)", default: "5" },
          { name: "judge", type: "string", value: "<JSON|FILE>", desc: 'Reviewer model: {"provider":"anthropic"|"openai"|"gateway"|"mock","model":…}', default: '{"provider":"anthropic"}' },
          { name: "solver", type: "string", value: "<BUNDLE>", desc: "First solve the task once with this harness bundle and review that attempt too" },
        ],
        examples: ["coding.sh eval crosscheck my-task --experiment exp_01J…", "coding.sh eval crosscheck my-task --solver claude-default --max 3"],
      },
      {
        name: "audit",
        summary: "Replay a witness test on an experiment's passing runs and count the passes it refutes",
        args: [{ name: "task", desc: "Task id or name", required: true }],
        flags: [
          { name: "experiment", type: "string", value: "<ID>", desc: "Experiment whose passing runs to replay (required)" },
          { name: "witness", type: "string", value: "<FILE|PATH=FILE>", desc: "Test for a requirement the verifier misses; written at its path relative to here, or at PATH" },
          { name: "witness-cmd", type: "string", value: "<CMD>", desc: "Command that runs the witness from the repo root" },
          { name: "requirement", type: "string", value: "<TEXT>", desc: "The requirement it checks, in the instruction's words" },
          { name: "promote", type: "boolean", desc: "Add the witnesses to the verifier afterwards (the task needs validating again)" },
          { name: "count-ambiguous", type: "boolean", desc: "Also count refutations by a witness that refutes over half the passing runs" },
        ],
        examples: [
          "coding.sh eval audit add-neg --experiment exp_01J… --witness test/neg.test.js --witness-cmd 'node test/neg.test.js' --requirement 'handle negative numbers'",
          "coding.sh eval audit add-neg --experiment exp_01J…",
        ],
      },
      {
        name: "list",
        summary: "List eval tasks",
        flags: [
          { name: "status", type: "string", value: "<STATUS>", choices: ["draft", "validated", "rejected"], desc: "Only tasks with this status" },
          { name: "tag", type: "string", value: "<TAG>", desc: "Only tasks with this tag" },
        ],
      },
      {
        name: "export",
        summary: "Write a task to a directory",
        args: [{ name: "task", desc: "Task id or name", required: true }],
        flags: [
          { name: "out", short: "o", type: "string", value: "<DIR>", desc: "Output directory (required)" },
          { name: "format", type: "string", value: "<FORMAT>", choices: ["coding.sh", "harbor"], desc: "Directory layout", default: "coding.sh" },
          FORCE,
        ],
      },
    ],
    load: () => import("./commands/eval.ts"),
  },
  {
    name: "dataset",
    group: "Evaluate",
    summary: "Manage versioned datasets of cases",
    actions: [
      {
        name: "add",
        summary: "Add cases to a dataset (creates it when missing)",
        args: [{ name: "name", desc: "Dataset name", required: true }],
        flags: [
          { name: "case", type: "list", value: "<JSON>", desc: 'Case as JSON: {"input":…,"expected":…} (repeatable)' },
          { name: "session", type: "list", value: "<ID>", desc: "Case from a captured session (repeatable)" },
          { name: "split", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Split for the added cases (default: stable hash of the case id, 60/20/20)" },
          { name: "note", type: "string", value: "<TEXT>", desc: "Version note" },
        ],
        examples: ['coding.sh dataset add smoke --case \'{"input":"2+2","expected":"4"}\'', "coding.sh dataset add labelled --session <ID> --split test"],
      },
      {
        name: "import",
        summary: "Import cases from a JSONL, JSON or CSV file",
        args: [{ name: "file", desc: "Path to the file", required: true }],
        flags: [
          { name: "name", type: "string", value: "<NAME>", desc: "Dataset name (default: file name)" },
          { name: "note", type: "string", value: "<TEXT>", desc: "Version note" },
        ],
      },
      { name: "list", summary: "List datasets" },
    ],
    load: () => import("./commands/dataset.ts"),
  },
  {
    name: "exp",
    group: "Evaluate",
    summary: "Run a task over a dataset, compare experiments and sweep configs",
    actions: [
      {
        name: "ab",
        summary: "A/B a CLAUDE.md, AGENTS.md, rule or skill edit on the decision points your agent recently got wrong",
        args: [{ name: "spec", desc: "JSON file with the same fields as the options (behavior, since, a, b, model, …); options override it" }],
        flags: [
          { name: "a", type: "string", value: "<FILE|DIR|git:REV|BUNDLE|none>", desc: "Baseline harness (default: git HEAD when B is omitted, else the repo's current files)" },
          { name: "b", type: "string", value: "<FILE|DIR|git:REV|BUNDLE|none>", desc: "Candidate harness; a file replaces the file of the same path in A (default: your uncommitted edits)" },
          { name: "behavior", type: "list", value: "<ID[,ID]>", desc: "Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all)" },
          { name: "anchor", type: "list", value: "<FILE>", desc: "Module exporting your own anchor(s) (see the evals guide)" },
          { name: "since", type: "string", value: "<DURATION|DATE>", desc: "Sessions started since", default: "14d" },
          { name: "agent", type: "list", value: "<AGENT>", desc: "Only sessions of this agent" },
          { name: "repo", type: "string", value: "<DIR|all>", desc: "Only sessions under this directory (default: this git repo)" },
          { name: "limit", short: "n", type: "number", value: "<N>", desc: "Maximum decision points", default: "40" },
          { name: "provider", type: "string", value: "<NAME>", choices: ["anthropic", "openai", "openai-compatible"], desc: "API that answers the next turn and judges it", default: "anthropic" },
          { name: "model", type: "string", value: "<MODEL>", desc: `Model for the next turn (default: the one the decision points were recorded with, else ${DEFAULT_MODELS.anthropic} or ${DEFAULT_MODELS.openai})` },
          { name: "judge-model", type: "string", value: "<MODEL>", desc: "Model for the judge (default: --model)" },
          { name: "base-url", type: "string", value: "<URL>", desc: "API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's)" },
          { name: "trials", type: "number", value: "<N>", desc: "Next turns per case and arm", default: "1" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel model calls", default: "4" },
          { name: "max-cost", type: "number", value: "<USD>", desc: "Refuse to start when the estimate is over this, and stop once the spend passes it" },
          { name: "dry-run", type: "boolean", desc: "Show the decision points and the cost estimate; make no model calls" },
          { name: "watch", type: "boolean", desc: "Rerun when B's files change, one line per run; Ctrl-C to stop" },
          { name: "cache", type: "boolean", desc: "Reuse stored model responses (--no-cache to ask the model again)", default: "true" },
          { name: "name", type: "string", value: "<NAME>", desc: "Experiment name (default: the dataset's)" },
          ...GATE_FLAGS,
          ...durableFlags("A/B"),
        ],
        graceful: true,
        examples: [
          "coding.sh exp ab",
          "coding.sh exp ab --b ./drafts/CLAUDE.md --behavior unverified-claim",
          "coding.sh exp ab --a git:main --b . --since 30d --dry-run",
          "coding.sh exp ab --watch",
        ],
      },
      {
        name: "run",
        summary: "Run an experiment, or two tasks as one interleaved A/B",
        args: [{ name: "spec", desc: "Experiment spec JSON file (fields can be overridden by options)" }],
        flags: [
          ...EXP_RUN_FLAGS,
          { name: "arm", type: "list", value: "<NAME=JSON|FILE>", desc: "One arm's task spec; give two (A then B) to interleave them case by case in one run" },
          { name: "stop-early", type: "boolean", desc: "With --arm: stop once a group sequential test (O'Brien-Fleming) is decisive" },
          { name: "looks", type: "number", value: "<N>", desc: "With --stop-early: planned looks over the case budget", default: "4" },
          { name: "max-cases", type: "number", value: "<N>", desc: "With --arm: run at most N cases (a random subset)" },
          { name: "seed", type: "number", value: "<N>", desc: "With --arm: seed for the case and arm order (default random, recorded)" },
          {
            name: "control",
            type: "boolean",
            desc: "A continuation task needs a control arm (A, the recorded config) to measure replay noise; --no-control runs one task alone and marks the result",
            default: "true",
          },
          ...durableFlags("experiment"),
        ],
        graceful: true,
        examples: [
          "coding.sh exp run -d smoke -g '{\"kind\":\"exact\"}' --arm base=base.json --arm cand=cand.json",
          "coding.sh exp run -d smoke -g '{\"kind\":\"exact\"}' --arm base=base.json --arm cand=cand.json --stop-early --max-cases 400",
          "coding.sh exp run spec.json --resume",
        ],
      },
      {
        name: "compare",
        summary: "Compare two experiments case by case",
        args: [
          { name: "a", desc: "Baseline experiment id or name (newest)", required: true },
          { name: "b", desc: "Candidate experiment id or name (newest)", required: true },
        ],
        flags: [
          { name: "force", type: "boolean", desc: "Compare a cancelled (partial) experiment too" },
          { name: "cluster", type: "string", value: "<KEY>", desc: "Case metadata field (e.g. repo, session) whose clusters the bootstrap resamples instead of single cases" },
          { name: "pairwise", type: "string", value: "<JSON|FILE>", desc: 'Pairwise judge spec, {"kind":"pairwise","name":…,"rubric":…}: judges A and B\'s outputs side by side, in both orders' },
          { name: "labels", type: "string", value: "<FILE>", desc: 'With --pairwise: human labels (JSON array or JSONL of {"caseId","winner":"a"|"b"|"tie"}) to calibrate the judge on the test split' },
          { name: "matrix", type: "boolean", desc: "Also print the success-count matrix: cases by passes out of k in A (rows) and B (columns)" },
          { name: "margin", type: "number", value: "<D>", desc: "Non-inferiority: exit 1 unless the 95% CI lower bound of B − A is above −D (0.05 = 5pp)" },
          ...GATE_FLAGS,
        ],
        examples: [
          "coding.sh exp compare base cand",
          "coding.sh exp compare base cheaper --margin 0.03",
          "coding.sh exp compare base cand --cluster repo",
          "coding.sh exp compare base cand --gate",
          "coding.sh exp compare base cand --matrix",
          "coding.sh exp compare base cand --pairwise judge.json",
        ],
      },
      {
        name: "aa",
        summary: "Run one config twice (A/A) and store its run-to-run noise",
        args: [
          { name: "a", desc: "Spec JSON file to run twice, or the first of two stored runs of one config" },
          { name: "b", desc: "The second stored run (compares the two instead of running)" },
        ],
        flags: [...EXP_RUN_FLAGS, ...durableFlags("A/A run")],
        graceful: true,
        examples: ["coding.sh exp aa --dataset smoke --task '{\"kind\":\"command\",\"command\":\"node agent.mjs\"}' --grader '{\"kind\":\"exact\"}'", "coding.sh exp aa smoke-aa1 smoke-aa2"],
      },
      {
        name: "sweep",
        summary: "Race task configs with sequential halving, then re-score the winner on held-out cases",
        args: [{ name: "configs", desc: "Task configs, [NAME=]<JSON|FILE>; the first is the start config", required: true, variadic: true }],
        flags: [
          ...EXP_RUN_FLAGS.filter((f) => ["dataset", "grader", "name", "concurrency"].includes(f.name)),
          { name: "budget", type: "number", value: "<N>", desc: "Case runs for the race, over all configs (default: each race case used once by the last round)" },
          { name: "split", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Split the race runs on", default: "train" },
          { name: "held-out", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Split the winner is re-scored on (a seeded 30% when the dataset has no splits)", default: "test" },
          { name: "seed", type: "number", value: "<N>", desc: "Seed for the case and job order (default random, recorded)" },
          ...durableFlags("sweep"),
        ],
        graceful: true,
        examples: ["coding.sh exp sweep base=base.json t2=temp2.json t5=temp5.json -d smoke -g '{\"kind\":\"exact\"}' --budget 300"],
      },
      {
        name: "metrics",
        summary: "A/B two metric commands (ms, bytes) in interleaved pairs",
        flags: [
          { name: "arm", type: "list", value: "<NAME=CMD|JSON|FILE>", desc: "One arm: a command line, a task spec or a spec file; give two (A then B). The command prints a JSON object of numbers" },
          { name: "pairs", type: "number", value: "<N>", desc: "Interleaved pairs (each runs A and B once, in balanced random order)", default: "11" },
          { name: "warmup", type: "number", value: "<N>", desc: "Runs of each arm before the pairs, not counted", default: "0" },
          { name: "higher", type: "list", value: "<METRIC>", desc: "Metric where higher is better (repeatable, * wildcard); lower is better otherwise" },
          { name: "metric", type: "list", value: "<METRIC>", desc: "Only report these metrics (repeatable, * wildcard)" },
          { name: "correction", type: "string", value: "<METHOD>", choices: ["holm", "none"], desc: "Multiple-comparison correction across metrics", default: "holm" },
          { name: "timeout", type: "number", value: "<SEC>", desc: "Per-run timeout for arms that don't set timeoutMs", default: "600" },
          { name: "seed", type: "number", value: "<N>", desc: "Seed for the arm order (default random, recorded)" },
          { name: "name", type: "string", value: "<NAME>", desc: "Experiment name" },
          { name: "fail-on-worse", type: "boolean", desc: "Exit 1 when any metric is worse in B" },
        ],
        examples: [
          "coding.sh exp metrics --arm base='node bench.mjs --dir a' --arm cand='node bench.mjs --dir b'",
          "coding.sh exp metrics --arm base=base.json --arm cand=cand.json --pairs 21 --higher score --json",
        ],
      },
      {
        name: "show",
        summary: "Show a stored experiment: pass rate, graders and failures",
        args: [{ name: "experiment", desc: "Experiment id or name (newest, cancelled ones included)", required: true }],
      },
      { name: "list", summary: "List experiments", flags: [LIMIT(20)] },
      {
        name: "status",
        summary: "Progress, ETA and cost so far of long runs (exp, compare, bench, workflows), and how to resume them",
        args: [{ name: "run", desc: "One run: its id, or the id of an experiment it produced" }],
        flags: [LIMIT(20)],
        examples: ["coding.sh exp status", "coding.sh exp status exp_01JC3T6Z2Q8W1S5V0R7N4K9M2D --json"],
      },
    ],
    load: () => import("./commands/exp.ts"),
  },
  {
    name: "judge",
    group: "Evaluate",
    summary: "Grade one output, or check an LLM judge or a test verifier against human labels",
    actions: [
      {
        name: "grade",
        summary: "Run one grader on one output and trace (exit 0 on pass); inside a verifier both default to the agent's",
        flags: [
          { name: "grader", short: "g", type: "string", value: "<JSON|FILE>", desc: "Grader spec, the same JSON as `exp run --grader` (llm, llm-checklist with trace checks, contains, regex, …)" },
          { name: "output", type: "string", value: "<FILE|->", desc: "The output to grade (default: $CODING_SH_AGENT_OUTPUT, the agent's final answer in a verifier)" },
          { name: "trace", type: "string", value: "<FILE>", desc: "Claude stream-json or transcript, or coding.sh events as JSONL (default: $CODING_SH_AGENT_STDOUT)" },
          { name: "input", type: "string", value: "<TEXT|@FILE>", desc: "The task input shown to a judge" },
          { name: "metadata", type: "string", value: "<JSON|FILE>", desc: "Case metadata, e.g. {\"instructions\": \"…\"} for follows-rules" },
        ],
        examples: ["coding.sh judge grade --grader checklist.json", "coding.sh judge grade --grader judge.json --output answer.txt --trace stream.jsonl --json"],
      },
      {
        name: "calibrate",
        summary: "Measure judge-human agreement (Cohen's kappa) on a held-out split, or a verifier's precision",
        args: [{ name: "experiment", desc: "Experiment id or name whose runs hold the judge's verdicts", required: true }],
        flags: [
          { name: "grader", short: "g", type: "string", value: "<ID>", desc: "Grader id (default: the only llm grader); a command or other deterministic grader gets a precision audit" },
          { name: "criterion", type: "string", value: "<NAME>", desc: "Label criterion" },
          { name: "split", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Held-out split to report on", default: "test" },
          { name: "tuned-on", type: "list", value: "<SPLIT>", desc: "Splits the prompt was tuned on, when the judge is not stored (repeatable)" },
          { name: "threshold", type: "number", value: "<KAPPA>", desc: "Minimum kappa", default: "0.6" },
          { name: "min-n", type: "number", value: "<N>", desc: "Minimum held-out cases (judges) or labelled passes (verifiers)", default: "20" },
          { name: "probe-injection", type: "string", value: "<JSON|FILE>", desc: "The judge's grader spec: re-judge human-fail cases with a planted 'respond pass' payload and report how many verdicts flip (exit 1 on any flip)" },
          { name: "probe-max", type: "number", value: "<N>", desc: "With --probe-injection: human-fail cases to probe", default: "25" },
          { name: "labels", type: "string", value: "<FILE>", desc: 'Extra human labels (JSON array or JSONL of {"caseId","value":"pass"|"fail"|"skip"}); they replace stored labels for the cases they name' },
          { name: "sample-passes", type: "number", value: "<N>", desc: "Print N unlabelled passing cases to label (a seeded sample) instead of measuring" },
          { name: "seed", type: "number", value: "<N>", desc: "With --sample-passes: sample seed; with --plan: must match the plan's", default: "0" },
          { name: "judge-cost", type: "number", value: "<USD>", desc: "Cost of one judge call: also print the human label cost above which calibrating the judge pays off" },
          { name: "plan", type: "string", value: "<FILE>", desc: "A `judge sample --out` plan: also print the human-audited pass rate from its labelled picks" },
        ],
        examples: [
          "coding.sh judge calibrate my-exp --tuned-on dev",
          "coding.sh judge calibrate my-exp --judge-cost 0.002",
          "coding.sh judge calibrate my-exp --plan plan.json",
          "coding.sh judge calibrate my-exp --probe-injection judge.json",
          "coding.sh judge calibrate my-exp --grader tests --sample-passes 40",
          "coding.sh judge calibrate my-exp --grader tests --labels labels.jsonl",
        ],
      },
      {
        name: "sample",
        summary: "Plan which cases to label next: a seeded random sample stratified by judge verdict and confidence",
        args: [{ name: "experiment", desc: "Experiment id or name whose runs hold the grader's verdicts", required: true }],
        flags: [
          { name: "budget", type: "number", value: "<N>", desc: "Labels to plan (required)" },
          { name: "grader", short: "g", type: "string", value: "<ID>", desc: "Grader id (default: the only llm grader)" },
          { name: "criterion", type: "string", value: "<NAME>", desc: "Label criterion (decides which existing labels count)" },
          { name: "split", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Split to sample from", default: "test" },
          { name: "seed", type: "number", value: "<N>", desc: "Sample seed", default: "0" },
          { name: "min-stratum", type: "number", value: "<N>", desc: "Smallest confidence bin before it merges into a neighbour", default: "25" },
          { name: "out", short: "o", type: "string", value: "<FILE>", desc: "Write the plan for `judge calibrate --plan`" },
        ],
        examples: ["coding.sh judge sample my-exp --budget 60 --out plan.json", "coding.sh judge sample my-exp --budget 60 --json"],
      },
    ],
    notes: ["judge grade appends each model call's tokens and price to $CODING_SH_GRADER_USAGE when it is set. coding.sh compare sets it for every verifier, so judge spend counts toward --max-cost."],
    load: () => import("./commands/judge.ts"),
  },
  {
    name: "toolevals",
    group: "Evaluate",
    summary: "Measure how well agents use a CLI, MCP server or API",
    actions: [
      {
        name: "init",
        summary: "Add a target to coding.sh.toml and write starter tasks",
        flags: [
          { name: "cli", type: "string", value: "<BIN>", desc: "CLI binary to evaluate" },
          { name: "mcp", type: "string", value: "<CMD>", desc: "MCP server command (stdio)" },
          { name: "mcp-url", type: "string", value: "<URL>", desc: "MCP server URL (Streamable HTTP)" },
          { name: "http", type: "string", value: "<URL>", desc: "HTTP API base URL" },
          { name: "name", type: "string", value: "<NAME>", desc: "Target name (default: from the binary or host)" },
          DRY_RUN,
        ],
        examples: ["coding.sh toolevals init --cli gh", 'coding.sh toolevals init --mcp "npx -y @modelcontextprotocol/server-everything" --name everything'],
      },
      {
        name: "surface",
        summary: "Surface bytes, description bytes and tokens per tool or subcommand",
        args: [{ name: "target", desc: "Target name (default: the only one)" }],
        flags: [{ name: "variant", type: "string", value: "<VARIANT>", desc: "Variant to measure", default: "base" }],
      },
      {
        name: "validate",
        summary: "Check no-op trials fail, references pass and nothing leaks",
        args: [{ name: "target", desc: "Target name (default: all)" }],
      },
      {
        name: "run",
        summary: "Run tasks x variants x drivers x k and summarize each arm",
        args: [{ name: "target", desc: "Target name (default: the only one)" }],
        flags: [
          { name: "driver", short: "d", type: "list", value: "<DRIVER>", desc: "agent:<id>[:model] or model:<provider>/<model> (repeatable)" },
          { name: "variant", type: "list", value: "<VARIANT>", desc: "Variant (repeatable; default: base)" },
          { name: "k", short: "k", type: "number", value: "<N>", desc: "Trials per task and arm", default: "3" },
          { name: "split", type: "string", value: "<SPLIT>", choices: ["dev", "heldout", "all"], desc: "Task split", default: "dev" },
          { name: "task", short: "t", type: "list", value: "<ID>", desc: "Only this task (repeatable)" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel trials" },
          { name: "keep", type: "boolean", desc: "Keep trial sandboxes" },
          YES,
        ],
        examples: ["coding.sh toolevals run gh --driver agent:claude-code -k 3", "coding.sh toolevals run everything --driver model:anthropic/claude-sonnet-5-5 --variant base --variant terse"],
      },
      {
        name: "compare",
        summary: "Compare two arms of an experiment (paired by task)",
        args: [{ name: "experiment", desc: "Experiment id", required: true }],
        flags: [
          { name: "baseline", type: "string", value: "<ARM>", desc: "Baseline arm, <variant>@<driver>" },
          { name: "candidate", type: "string", value: "<ARM>", desc: "Candidate arm, <variant>@<driver>" },
        ],
      },
      {
        name: "compress",
        summary: "Shorten MCP tool descriptions without losing success",
        args: [{ name: "target", desc: "MCP target name (default: the only one)" }],
        flags: [
          { name: "driver", short: "d", type: "string", value: "<DRIVER>", desc: "Driver to evaluate with" },
          { name: "k", short: "k", type: "number", value: "<N>", desc: "Trials per task", default: "3" },
          { name: "margin", type: "number", value: "<DELTA>", desc: "Allowed success drop (CI lower bound)", default: "0.03" },
          { name: "max-evals", type: "number", value: "<N>", desc: "Maximum candidate evaluations", default: "40" },
          { name: "batch", type: "boolean", desc: "Compress every tool at one level per step" },
          YES,
        ],
      },
      {
        name: "show",
        summary: "Show a trial's metrics, tap records and session tree",
        args: [{ name: "trial", desc: "Trial id", required: true }],
      },
    ],
    notes: ["Arms are named <variant>@<driver>.", "Runs above [toolevals] confirmAboveUsd (default $5) need --yes when not on a TTY."],
    load: () => import("./commands/toolevals.ts"),
  },
  WORKFLOWS_COMMAND,
  BENCH_COMMAND,
  // ---------------------------------------------------------- Harness
  {
    name: "harness",
    group: "Harness",
    summary: "Snapshot and list agent harness bundles",
    actions: [
      {
        name: "snapshot",
        summary: "Snapshot an agent's harness files into a bundle",
        flags: [
          { name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Agent id (required)" },
          { name: "name", type: "string", value: "<NAME>", desc: "Bundle name (default: agent and date)" },
          { name: "dir", type: "string", value: "<DIR>", desc: "Project directory (default: current directory)" },
          { name: "file", type: "string", value: "<TOML>", desc: "Build the bundle from a harness TOML instead" },
          { name: "model", type: "string", value: "<MODEL>", desc: "Model to record" },
        ],
      },
      { name: "list", summary: "List harness bundles" },
    ],
    load: () => import("./commands/harness.ts"),
  },
  {
    name: "compare",
    group: "Harness",
    summary: "A/B two harness bundles on eval tasks",
    args: [
      { name: "a", desc: "Baseline bundle id or name", required: true },
      { name: "b", desc: "Candidate bundle id or name (omit with --without)" },
    ],
    flags: [
      { name: "task", short: "t", type: "list", value: "<ID>", desc: "Task id (repeatable; default: all validated tasks)" },
      { name: "tag", type: "string", value: "<TAG>", desc: "Run every non-archived task with this tag, drafts included (e.g. the tag given to eval import)" },
      { name: "k", type: "number", value: "<N>", desc: "Attempts per task and arm", default: "1" },
      { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel runs" },
      { name: "max-cost", type: "number", value: "<USD>", desc: "Spend cap: once finished runs (agent plus judge grade calls) reach it, no new run starts" },
      { name: "experiment", type: "string", value: "<ID>", desc: "Compare the stored runs of this experiment instead of running" },
      { name: "without", type: "list", value: "<PATH>", desc: "Ablation: B is A without this file, dir or glob (repeatable)" },
      {
        name: "gateway",
        type: "string",
        optionalValue: true,
        value: "<NAME>",
        choices: ["vercel", "openrouter", "litellm", "ramp"],
        desc: "Route both arms through a gateway. Without a name: [gateway] default, else the one with a key, else vercel",
      },
      ...GATE_FLAGS,
      { name: "by", type: "string", value: "<PREFIX>", desc: "With --gate: also gate each task group (first tag with this prefix, e.g. suite:); any group's don't-ship blocks" },
      { name: "promote", type: "boolean", desc: "Pareto promotion gate: exit 0 when B is credibly better on quality or cheaper (cost, else tokens), 1 otherwise" },
      { name: "gamma", type: "number", value: "<G>", desc: "With --promote: support needed to promote", default: "0.7" },
      { name: "eps-q", type: "number", value: "<Q>", desc: "With --promote: pass rate a cheaper B may give up", default: "0.1" },
      { name: "eps-c", type: "string", value: "<C|inf>", desc: "With --promote: relative cost rise a better B may take (0.2 = +20%)", default: "inf" },
      { name: "draws", type: "number", value: "<N>", desc: "With --promote: bootstrap draws", default: "10000" },
      {
        name: "item-gate",
        type: "boolean",
        desc: "One-item gate (shown automatically when B adds or removes one rule, skill or context file): exit 0 on KEEP or ACCEPT, 1 otherwise; --no-item-gate hides it",
      },
      { name: "audited", type: "boolean", desc: "Count passes a witness refuted (eval audit) as fails in the verdict; needs every pass in both arms audited" },
      ...durableFlags("comparison"),
      YES,
    ],
    graceful: true,
    examples: [
      "coding.sh compare base candidate --k 3",
      "coding.sh compare base candidate --k 3 --resume",
      "coding.sh compare base candidate --experiment exp_01",
      "coding.sh compare base candidate --experiment exp_01 --audited",
      "coding.sh compare base candidate --k 3 --gate",
      "coding.sh compare base candidate --k 3 --gate --by suite:",
      "coding.sh compare no-skill with-skill --tag skill-eval --gate --by suite: --max-cost 15",
      "coding.sh compare base candidate --k 3 --promote",
      "coding.sh compare base --without .claude/rules/clock.md --k 3 --item-gate",
      "coding.sh compare sonnet gpt5 --gateway",
      "coding.sh compare sonnet gpt5 --gateway openrouter",
    ],
    load: () => import("./commands/compare.ts"),
  },
  // ---------------------------------------------------------- Maintain
  {
    name: "gateway",
    group: "Maintain",
    summary: "LLM gateways: detect routing, enrich sessions with billed cost",
    actions: [
      {
        name: "status",
        summary: "Show which agents route through a gateway, key sources and tagged sessions",
        flags: [GATEWAY_NAME, { name: "credits", type: "boolean", desc: "Also fetch the credit balance (Vercel, OpenRouter; needs the key)" }],
        examples: ["coding.sh gateway status", "coding.sh gateway status --gateway openrouter --credits"],
      },
      {
        name: "enrich",
        summary: "Attach billed cost and serving provider to llm calls with a gateway request id",
        flags: [
          GATEWAY_NAME,
          { name: "session", short: "s", type: "list", value: "<ID>", desc: "Only this session (repeatable; or latest)" },
          { name: "since", type: "string", value: "<WHEN>", desc: "Sessions after this time: 7d, 12h, 30m or a date", default: "30d" },
          LIMIT(500),
          { name: "offline", type: "boolean", desc: "Use only the cache and drained traces; no API calls" },
          DRY_RUN,
        ],
        examples: ["coding.sh gateway enrich", "coding.sh gateway enrich --session latest --dry-run", "coding.sh gateway enrich --gateway openrouter"],
      },
    ],
    notes: [
      "Keys come from each gateway's standard env var (AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, LITELLM_PROXY_API_KEY, CLOUDFLARE_API_TOKEN, PORTKEY_API_KEY, HELICONE_API_KEY) or [gateway] / [gateway.<name>] apiKeyEnv / apiKey in config.toml, and are never printed or stored.",
      "Lookups use each gateway's per-request API (Vercel and OpenRouter /generation, LiteLLM /spend/logs, Cloudflare logs, Portkey logs, Helicone /v1/request); results are cached in the index, so re-runs make no calls.",
    ],
    load: () => import("./commands/gateway.ts"),
  },
  {
    name: "gc",
    group: "Maintain",
    summary: "Delete expired spool files, blobs and judge cache",
    flags: [{ name: "compact", type: "boolean", desc: "Also compact the index (VACUUM)" }, DRY_RUN],
    load: () => import("./commands/gc.ts"),
  },
  {
    name: "config",
    group: "Maintain",
    summary: "Read and write ~/.coding.sh/config.toml",
    actions: [
      { name: "get", summary: "Print the effective config or one key", args: [{ name: "key", desc: "Dotted key, e.g. capture.mode" }] },
      {
        name: "set",
        summary: "Set one key",
        args: [
          { name: "key", desc: "Dotted key, e.g. capture.mode", required: true },
          { name: "value", desc: "Value (numbers, true/false and JSON arrays are parsed)", required: true },
        ],
        flags: [DRY_RUN],
      },
      { name: "path", summary: "Print the config file path" },
    ],
    load: () => import("./commands/config.ts"),
  },
  {
    name: "update",
    group: "Maintain",
    summary: "Install the latest coding.sh release",
    flags: [
      { name: "check", type: "boolean", desc: "Only report whether an update is available" },
      { name: "refresh-bin", type: "boolean", hidden: true, desc: "Only refresh the hook, MCP launcher and CLI path in ~/.coding.sh/bin from this install (runs after every update)" },
      DRY_RUN,
    ],
    examples: ["coding.sh update", "coding.sh update --check"],
    notes: [
      "Other commands print one line when a newer release is out (checked at most daily, in the background).",
      "Turn that off with NO_UPDATE_NOTIFIER=1, CODING_SH_NO_UPDATE_CHECK=1 or `[update] check = false` in ~/.coding.sh/config.toml.",
    ],
    load: () => import("./commands/update.ts"),
  },
  {
    name: "version",
    group: "Maintain",
    summary: "Print the version",
    load: () => import("./commands/version.ts"),
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}
