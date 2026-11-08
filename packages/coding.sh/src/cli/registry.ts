// Static command metadata: everything `--help` needs, with no imports beyond
// types. Command modules load lazily through `load()` only after dispatch, so
// help and typo suggestions never touch stores, adapters or the network.
import type { FlagSpec } from "./args.ts";
import type { CommandModule } from "./types.ts";
import { GATEWAY_IDS } from "../integrations/gateway/providers.ts";
import { WORKFLOWS_COMMAND } from "../workflows/cli-spec.ts";
import { BENCH_COMMAND } from "../bench/cli-spec.ts";
import { durableFlags, RETRIES_FLAG, TRIAL_TIMEOUT_FLAG } from "../jobs/flags.ts";
import { DEFAULT_MODELS } from "../core/pricing.ts";
import { FACET_KEYS, keyDocs } from "../query/where.ts";

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
  /** Handles secrets: usage errors never repeat what was typed (see ParseOptions.sensitive). */
  sensitive?: boolean;
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
/** `--where`: the query language in src/query/where.ts. */
const WHERE = (what: string): FlagSpec => ({ name: "where", type: "string", dashValue: true, value: "<QUERY>", desc: `Only ${what} matching a query, e.g. 'agent:codex cost>0.5 tool:Bash -flag:compaction' (keys: coding.sh sessions --help)` });
/** Help notes for the query language, generated from its key table. */
const WHERE_NOTES: string[] = [
  "--where: key:value clauses, AND by default; OR between clauses; ( ) to group; - to negate; a,b for either value; * as a wildcard in text; > >= < <= and a..b on numbers. Bare words search prompts, replies and tool calls (every word in one event).",
  `Session keys: ${keyDocs().filter((k) => k.level === "session").map((k) => k.name).join(", ")}. Event keys (the session has a matching event; event keys in one group match the same event): ${keyDocs().filter((k) => k.level === "event").map((k) => k.name).join(", ")}. Also sort:-cost and limit:N. Full list with examples: docs/reference/query.md.`,
];
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
  { name: "grader", short: "g", type: "list", value: "<JSON|FILE>", desc: 'Grader spec, e.g. {"kind":"exact"} (repeatable); added to the spec file\'s graders' },
  { name: "replace-graders", type: "boolean", desc: "Use only the --grader graders, not the spec file's" },
  { name: "name", type: "string", value: "<NAME>", desc: "Experiment name" },
  { name: "trials", type: "number", value: "<N>", desc: "Attempts per case", default: "1" },
  { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel case runs", default: "4" },
  { name: "split", type: "string", value: "<SPLIT>", choices: ["train", "dev", "test"], desc: "Only cases in this split" },
];

/** Where improve looks (improve, improve fix, improve check). */
const IMPROVE_FLAGS = (since: string, limit: number): FlagSpec[] => [
  { name: "since", type: "string", value: "<WHEN>", desc: "Only sessions (check: changes) after this time: 7d, 12h or a date", default: since },
  { name: "repo", type: "string", value: "<DIR|all>", desc: "Only sessions under this directory, or all (default: this git repo)" },
  AGENT_LIST,
  LIMIT(limit),
  FRESH,
];

/** Tie-break sampling (exp run, toolevals run). */
const SAMPLES_FLAG: FlagSpec = {
  name: "samples",
  type: "string",
  value: "<MODE>",
  choices: ["fixed", "adaptive"],
  default: "fixed",
  desc: "adaptive: 2 trials each, a 3rd when they disagree; it fails at half or more failing. Reports no CI",
};

/** Stop a gating run on the first regression against a stored run (exp run, toolevals run). */
const regressionFlags = (what: string, unit: string): FlagSpec[] => [
  { name: "stop-on-regression", type: "boolean", desc: `Stop and exit 1 once a ${unit} that passed every trial of --baseline fails` },
  { name: "baseline", type: "string", value: `<${what.toUpperCase()}>`, desc: `With --stop-on-regression: the stored ${what} to hold the run to` },
];

/** Waive the protected-line check for one protected line (refine check, exp ab). */
const PROTECTED_EDIT: FlagSpec = { name: "allow-protected-edit", type: "list", value: "<PATH:LINE>", desc: "Allow the edit to delete, reword or relax this protected line (repeatable; never implied by --force)" };

/** Where refine finds its decision points and who answers and judges them (refine propose, test, run). */
const REFINE_SOURCE_FLAGS: FlagSpec[] = [
  { name: "behavior", type: "list", value: "<ID[,ID]>", desc: "Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all)" },
  { name: "anchor", type: "list", value: "<FILE>", desc: "Module exporting your own anchor(s) (see the evals guide)" },
  { name: "since", type: "string", value: "<DURATION|DATE>", desc: "Sessions started since", default: "14d" },
  { name: "agent", type: "list", value: "<AGENT>", desc: "Only sessions of this agent" },
  { name: "repo", type: "string", value: "<DIR|all>", desc: "Only sessions under this directory (default: this git repo)" },
  { name: "provider", type: "string", value: "<NAME>", choices: ["anthropic", "openai", "openai-compatible", "claude-code", "codex"], desc: "Who proposes, answers the next turn and judges it: an API, or claude-code / codex to run `claude -p` / `codex exec` on your subscription (default: anthropic; with no API key set, a logged-in Claude Code, else Codex)" },
  { name: "base-url", type: "string", value: "<URL>", desc: "API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's)" },
  { name: "judge-model", type: "string", value: "<MODEL>", desc: "Model for the judge (default: --model)" },
];

const REFINE_TRIAL_FLAGS: FlagSpec[] = [
  { name: "limit", short: "n", type: "number", value: "<N>", desc: "Maximum decision points", default: "40" },
  { name: "model", type: "string", value: "<MODEL>", desc: `Model for the next turn (default: the one the decision points were recorded with, else ${DEFAULT_MODELS.anthropic} or ${DEFAULT_MODELS.openai})` },
  { name: "trials", type: "number", value: "<N>", desc: "Next turns per case and arm", default: "1" },
  { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel model calls", default: "4" },
  { name: "max-cost", type: "number", value: "<USD>", desc: "Refuse to start when the estimate is over this, and stop once the spend passes it" },
  { name: "max-guard", type: "number", value: "<N>", desc: "Most tasks in the guard set (the tasks earlier kept edits won), newest kept edits first", default: "24" },
  { name: "cache", type: "boolean", desc: "Reuse stored model responses (--no-cache to ask the model again)", default: "true" },
  { name: "lambda", type: "number", value: "<N>", desc: "Acceptance gate: what breaking one solved decision point costs, in fixed ones", default: "2" },
  { name: "gate-alpha", type: "number", value: "<A>", desc: "Acceptance gate: one-sided significance level", default: "0.05" },
  { name: "tau", type: "number", value: "<T>", desc: "Acceptance gate: largest share of solved decision points B may break", default: "0.10" },
  PROTECTED_EDIT,
];

const PROPOSER_MODEL: FlagSpec = { name: "proposer-model", type: "string", value: "<MODEL>", desc: `Model that writes the edit (default: --judge-model, else --model, else ${DEFAULT_MODELS.anthropic} or ${DEFAULT_MODELS.openai})` };
const REFINE_TARGET: FlagSpec = { name: "target", type: "string", value: "<PATH>", desc: "Harness file the proposal edits, or a skill directory for its SKILL.md (default: AGENTS.md, else CLAUDE.md, else GEMINI.md)" };
const PROPOSER_COMMAND: FlagSpec = { name: "proposer-command", type: "string", value: "<CMD>", desc: "Shell command that writes the edit instead of the proposer model: the prompt on stdin, the JSON reply on stdout (e.g. 'claude -p')" };

/** Judge candidates on an eval suite of repo tasks (refine test, run). */
const REFINE_SUITE_FLAGS: FlagSpec[] = [
  { name: "suite", type: "string", value: "<NAME>", desc: "Judge candidates on this eval suite of repo tasks (evals/<NAME>) instead of mined decision points; a skill --target uses evals/<skill> when it exists" },
  { name: "objective", type: "list", value: "<OBJ[,OBJ]>", desc: "With --suite: what to improve, primary first: pass, cost, tokens, wall, llm, turns, size (default: pass). The pass rate must hold within --margin whatever the list" },
  { name: "margin", type: "string", value: "<SHARE>", desc: "With --suite: how far the pass rate may drop for a cheaper or faster candidate to be kept, e.g. 5pp", default: "2pp" },
  { name: "min-gain", type: "string", value: "<SHARE>", desc: "With --suite: smallest relative gain in cost, tokens, time, turns or size that counts, e.g. 20%", default: "10%" },
  { name: "harness", type: "string", value: "<BUNDLE>", desc: "With --suite: stored harness bundle the suite runs, the repo's harness files laid over it (default: the suite's, else a snapshot of the repo)" },
  ...durableFlags("round"),
  YES,
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
      { name: "import", type: "boolean", desc: "Import each agent's past sessions so the viewer opens on your history (--no-import to skip)", default: "true" },
      { name: "proxy", type: "boolean", desc: "Also route Claude Code and Codex model calls through the local proxy, and start it" },
      { name: "force", type: "boolean", desc: "Install hooks even when the agent already has coding.sh hooks in the other scope; with --proxy, replace a base URL or provider you set instead of chaining through it" },
      YES,
      { name: "dry-run", type: "boolean", desc: "Print the plan (agents, files, blockers) without writing anything" },
      { name: "diff", type: "boolean", desc: "With --dry-run, also print the full diff of every planned edit" },
      { name: "remote", type: "string", value: "<URL>", desc: "Also send new sessions to a team's coding.sh serve at this URL (an http sink named team)" },
      { name: "key", type: "string", value: "<KEY>", desc: "With --remote, the server's ingest key, csh_ik_… (also CODING_SH_INGEST_KEY)" },
      { name: "remote-mode", type: "string", value: "<MODE>", desc: "With --remote: metadata sends no prompts, code or tool output; full sends them", default: "metadata" },
    ],
    examples: ["coding.sh init", "coding.sh init --agent claude-code --yes", "coding.sh init --no-import", "coding.sh init --proxy", "coding.sh init --dry-run", "coding.sh init --remote https://obs.example.com --key csh_ik_…"],
    notes: [
      "Copies the hook to ~/.coding.sh/bin/hook.mjs and points each agent at it.",
      "Then imports the sessions each agent already keeps on this machine, for up to 8 seconds (CODING_SH_INIT_IMPORT_BUDGET_MS changes it). The rest imports in the background and shows up in the viewer as it lands. Running init again reads only new or changed transcripts.",
      "--remote checks that the server takes the key before writing anything, then adds the sink to ~/.coding.sh/config.toml (mode 600). Run it again to change the URL, key or mode.",
      "Registers the MCP server with Claude Code, Codex, Cursor, OpenCode and Gemini CLI (user scope only).",
      "--proxy sets ANTHROPIC_BASE_URL in Claude Code's settings.json and a coding-sh model provider in Codex's config.toml. A base URL the agent already used (a gateway, CLIProxyAPI, your own Codex provider) becomes the proxy's upstream instead of being replaced. The hook restarts a stopped proxy when a session starts.",
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
    name: "statusline",
    group: "Capture",
    summary: "Print a Claude Code status line (model, cost, worst flag), or install it",
    actionOptional: true,
    actions: [
      {
        name: "install",
        summary: "Set coding.sh as Claude Code's status line in the user settings.json",
        flags: [
          { name: "force", type: "boolean", desc: "Replace an existing status line (restored on uninstall)" },
          { name: "dry-run", type: "boolean", desc: "Show what would change, write nothing" },
        ],
        examples: ["coding.sh statusline install", "coding.sh statusline install --force"],
      },
      {
        name: "uninstall",
        summary: "Remove the coding.sh status line, restoring the previous one",
        flags: [{ name: "dry-run", type: "boolean", desc: "Show what would change, write nothing" }],
        examples: ["coding.sh statusline uninstall"],
      },
    ],
    notes: [
      "With no subcommand it reads the status-line JSON Claude Code sends on stdin and prints one line: model, this session's cost, today's cost, and the single worst flag. It exits 0 even on error, so it never disrupts the agent.",
      "install writes settings.statusLine and backs the file up; uninstall restores it byte-for-byte (the previous status line, if any, comes back).",
    ],
    examples: ["coding.sh statusline install", "coding.sh statusline uninstall"],
    load: () => import("./commands/statusline.ts"),
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
      { name: "background", type: "boolean", desc: "Don't wait for another ingest; exit quietly if one is running. With --backfill, imports history unless another import is running" },
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
    name: "proxy",
    group: "Capture",
    summary: "Run a local Anthropic/OpenAI API proxy that logs every model call",
    actionOptional: true,
    flags: [
      { name: "port", short: "p", type: "number", value: "<PORT>", desc: "Port to listen on, 0 = any free port ([proxy] port)", default: "4320" },
      { name: "host", type: "string", value: "<HOST>", desc: "Interface to bind ([proxy] host)", default: "127.0.0.1" },
      { name: "anthropic-upstream", type: "string", value: "<URL>", desc: "Where Anthropic calls go, e.g. a gateway ([proxy] anthropic_upstream)", default: "https://api.anthropic.com" },
      { name: "openai-upstream", type: "string", value: "<URL>", desc: "Where OpenAI calls go ([proxy] openai_upstream)", default: "https://api.openai.com" },
      { name: "background", type: "boolean", desc: "Start detached, print the URL once it answers (log: ~/.coding.sh/proxy.log)" },
      { name: "quiet", short: "q", type: "boolean", desc: "No line per call on stderr" },
    ],
    actions: [
      { name: "status", summary: "Show whether a proxy is running, and where (exit 1 when not)", examples: ["coding.sh proxy status"] },
      { name: "stop", summary: "Stop the background proxy", examples: ["coding.sh proxy stop"] },
      { name: "env", summary: "Print the ANTHROPIC_BASE_URL / OPENAI_BASE_URL exports for the proxy", examples: ['eval "$(coding.sh proxy env)"'] },
    ],
    examples: ["coding.sh proxy", "coding.sh proxy --background", "coding.sh init --proxy", "coding.sh proxy --anthropic-upstream https://gateway.example.com/anthropic"],
    notes: [
      "Forwards /v1/messages (and count_tokens), /v1/chat/completions, /v1/responses and every other path to the real API with the client's own auth headers. Auth headers are never stored.",
      "Streams pass through as they arrive. A failed store write never fails the request.",
      "Calls from Claude Code and Codex land in the session their hooks capture; other clients get a proxy-<hash> session per conversation (or send x-coding-sh-session: <id>).",
      "Prints the environment to stdout; one line per call goes to stderr.",
    ],
    load: () => import("./commands/proxy.ts"),
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
    flags: [AGENT_LIST, SCOPE, { name: "proxy", type: "boolean", desc: "Only stop routing agents through the proxy (undo init --proxy)" }, YES, DRY_RUN],
    examples: ["coding.sh uninstall --dry-run", "coding.sh uninstall --yes", "coding.sh uninstall --proxy"],
    notes: ["Captured data in ~/.coding.sh is kept.", "Also undoes init --proxy. The proxy itself keeps running until coding.sh proxy stop."],
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
      { name: "empty", type: "boolean", desc: "Include sessions with no turn, tool call or model call (hidden by default)" },
      { name: "project", type: "string", value: "<ID>", desc: "Only sessions in this serve project (default: all)" },
      { name: "flag", type: "string", value: "<NAME>", desc: "Only sessions with this flag: looping, failure-streak, churn, no-progress, stalled, context-thrash, premature-completion, duplicate-fetch, …, or a tag such as skill:<name>" },
      WHERE("sessions"),
      { name: "facets", type: "string", optionalValue: true, valuePattern: /^[a-z.]+(,[a-z.]+)*$/, value: "<KEYS>", desc: `Count sessions per value instead of listing them: ${FACET_KEYS.join(", ")} (default: agent, model, repo, flag, skill, tool)` },
      FRESH,
    ],
    examples: ["coding.sh sessions --where 'agent:codex cost>0.5 since:7d'", "coding.sh sessions --where 'tool:Bash ok:false -flag:compaction'", "coding.sh sessions --facets model,tool --where 'repo:coding-sh'", "coding.sh sessions --agent codex --since 7d"],
    notes: [...WHERE_NOTES, "--facets counts each key over the query without that key's own clauses, so every value of a picked key still shows. --limit sets the values per key (default 10).", PENDING_NOTE],
    load: () => import("./commands/sessions.ts"),
  },
  {
    name: "show",
    group: "Explore",
    summary: "Show a session timeline with subagents and latency",
    args: [{ name: "session", desc: "Session id, a unique prefix of one (4+ characters, like a git short hash), or 'latest'; or a model call (its id, or <session>#<n>)", required: true }],
    flags: [
      { name: "limit", short: "n", type: "number", value: "<N>", desc: "List the first N events (default 200; a longer session shows as phases)" },
      { name: "all", type: "boolean", desc: "List every event, with phase and day lines and derail markers" },
      { name: "follow", short: "f", type: "boolean", desc: "Keep printing new events as a running session goes on (Ctrl-C to stop)" },
    ],
    examples: ["coding.sh show latest", "coding.sh show 9f1c2e", "coding.sh show 9f1c2e --all", "coding.sh show latest --follow", "coding.sh show 'latest#-1'"],
    notes: [
      "A session with more than 200 events shows one line per phase: the start, each resume, compaction and long idle gap, with where it derailed.",
      "A model call logged by coding.sh proxy shows its system prompt, tools, settings, cache use, usage and cost (--all: the whole system prompt).",
    ],
    load: () => import("./commands/show.ts"),
  },
  {
    name: "tree",
    group: "Explore",
    summary: "Show a whole multi-agent run as one tree, with rolled-up totals",
    args: [{ name: "session|run", desc: "A session id or prefix (its whole tree, from the top-level agent down), or a run id (every agent of the fan-out)", required: true }],
    flags: [{ name: "run", type: "boolean", desc: "Read the argument as a run id (CODING_SH_RUN_ID), not a session" }],
    examples: ["coding.sh tree latest", "coding.sh tree 9f1c2e", "coding.sh tree my-fanout-123 --run"],
    notes: [
      "From any session, the tree is its top-level agent and every subagent under it, with per-node model, cost, tokens, duration and tool calls, and the run's totals and worst flag.",
      "Separate agent processes group into one run when they share a run id: set CODING_SH_RUN_ID on the orchestrator that launches your fan-out, then pass that id.",
    ],
    load: () => import("./commands/tree.ts"),
  },
  {
    name: "replay",
    group: "Explore",
    summary: "Step through a session and see what it did to each file it touched",
    args: [{ name: "session", desc: "Session id, a unique prefix of one (4+ characters, like a git short hash), or 'latest'", required: true }],
    flags: [
      { name: "step", type: "number", value: "<N>", desc: "Show step N: its command and output, the diff it made, and the files touched so far" },
      { name: "to", type: "number", value: "<M>", desc: "Show what steps --step (default 1) through M changed together" },
      { name: "file", type: "string", value: "<PATH>", desc: "Print this file as of --step (default: the last step)" },
      { name: "fork", type: "boolean", desc: "With --step: send the model call that made step N again, with the harness changed, and show the recorded and forked next action side by side" },
      { name: "with", type: "list", value: "<DEST=SRC>", desc: "With --fork: the fork's DEST (CLAUDE.md, AGENTS.md, a rule or skill, ~/.claude/CLAUDE.md) has SRC's text; a bare PATH uses that file as it is now; DEST= drops it (repeatable)" },
      { name: "harness", type: "string", value: "<BUNDLE>", desc: "With --fork: take the context files and model from this stored harness bundle" },
      { name: "model", type: "string", value: "<MODEL>", desc: "With --fork: send the call to this model" },
      { name: "system", type: "string", value: "<TEXT|@FILE>", desc: "With --fork: replace the system prompt" },
      { name: "trials", short: "k", type: "number", value: "<N>", desc: "With --fork: forked calls to send", default: "1" },
      { name: "run", type: "boolean", desc: "With --fork: run Claude Code from step N in a copy of the session's directory, the stored history spliced into its requests, and show the recorded and forked steps" },
      { name: "verify", type: "string", value: "<CMD>", desc: "With --run: run this command in the fork's directory afterwards; exit 1 when it fails" },
      { name: "workdir", type: "string", value: "<DIR>", desc: "With --run: put the fork's copy here (default: a new temp dir), kept afterwards" },
      { name: "save-case", type: "string", value: "<SUITE>", desc: "With --fork: save step N as a case in evals/<SUITE> (eval run sends its stored request with the project's context files and fails it when it repeats the recorded action)" },
    ],
    examples: [
      "coding.sh replay latest",
      "coding.sh replay 9f1c2e --step 12",
      "coding.sh replay 9f1c2e --step 5 --to 20",
      "coding.sh replay 9f1c2e --step 12 --file src/app.ts",
      "coding.sh replay 9f1c2e --step 12 --fork --with CLAUDE.md=fixed.md -k 3",
      "coding.sh replay 9f1c2e --step 12 --fork --with CLAUDE.md --run --verify 'npm test'",
      "coding.sh replay 9f1c2e --step 12 --fork --with CLAUDE.md --save-case forks",
    ],
    notes: [
      "File content is rebuilt from the agent's own tool calls: full writes, full reads and the edits applied to them. A file edited before any step showed it reads as unknown, with the reason, until a later read or write. A session run with `coding.sh run` also starts from its snapshot.",
      "The viewer has the same replay: the Replay button on a session page, or a link ending in ?step=N.",
      "--fork needs the session captured through coding.sh proxy (capture mode full): the stored request of the call that made step N is the fork's starting context. It calls the model with $ANTHROPIC_API_KEY (or $CLAUDE_CODE_OAUTH_TOKEN) or $OPENAI_API_KEY, at your cost. A context file is changed where the agent put it in the request; one it did not have is added the way Claude Code adds CLAUDE.md.",
    ],
    load: () => import("./commands/replay.ts"),
  },
  {
    name: "diff-calls",
    group: "Explore",
    summary: "Show what changed between two model calls, and why the second missed the prompt cache",
    args: [
      { name: "a", desc: "A model call: its id, a unique prefix of one (6+ characters), or <session>#<n> (#-1 is the last)", required: true },
      { name: "b", desc: "The call to compare it with (default: compare a with the call before it in its session)" },
    ],
    examples: ["coding.sh diff-calls 9f1c2e4a7b3d", "coding.sh diff-calls 'latest#3' 'latest#4'", "coding.sh diff-calls 9f1c2e 4b7d1a --json"],
    notes: ["Compares model, settings, tool definitions, the system prompt (line by line) and the message history, in the order the prompt cache reads them. Needs calls logged by coding.sh proxy; in capture mode metadata it compares hashes only."],
    load: () => import("./commands/diff-calls.ts"),
  },
  {
    name: "search",
    group: "Explore",
    summary: "Full-text search over prompts, replies and tool calls",
    args: [{ name: "text", desc: "Search text", required: true, variadic: true }],
    flags: [AGENT_ONE, LIMIT(20), { name: "project", type: "string", value: "<ID>", desc: "Only matches in this serve project (default: all)" }, WHERE("matches"), FRESH],
    examples: ["coding.sh search 'flaky test'", "coding.sh search migration --where 'agent:codex kind:tool.start'"],
    notes: ["--where applies to each match: event keys (kind, tool, ok, …) to the matching event, session keys (agent, repo, cost, …) to its session. Keys: coding.sh sessions --help.", PENDING_NOTE],
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
      WHERE("sessions"),
    ],
    examples: ["coding.sh usage", "coding.sh usage --by agent-model --since 90d", "coding.sh usage --by model --where 'repo:coding-sh tool:Bash'"],
    load: () => import("./commands/usage.ts"),
  },
  {
    name: "sql",
    group: "Explore",
    summary: "Run one read-only SQL query against the SQLite index",
    args: [{ name: "query", desc: "One SELECT or WITH statement", required: true, variadic: true }],
    flags: [
      { name: "csv", type: "boolean", desc: "Print CSV instead of a table" },
      { name: "limit", short: "n", type: "number", value: "<N>", desc: "Most rows to return", default: "1000" },
      { name: "timeout", type: "number", value: "<SECONDS>", desc: "Stop the query after this long", default: "10" },
      FRESH,
    ],
    examples: [
      'coding.sh sql "select agent, count(*) as n from sessions group by agent"',
      "coding.sh sql \"select tool, count(*) from events where kind = 'tool.end' and ok = 0 group by tool order by 2 desc\" --csv",
      "coding.sh sql \"select name, sql from sqlite_schema where type = 'table'\"",
    ],
    notes: [
      "Read-only: the index is opened read-only with query_only on, and only one SELECT or WITH statement is accepted. INSERT, UPDATE, DELETE, ATTACH, PRAGMA statements and a second statement exit 2.",
      "Postgres and ClickHouse stores are not supported here: use coding.sh export, or the database's own client.",
      "Tables and columns: docs/reference/query.md. Events keep their payload as JSON text: json_extract(payload, '$.command').",
    ],
    load: () => import("./commands/sql.ts"),
  },
  {
    name: "export",
    group: "Explore",
    summary: "Stream sessions, events or labels as JSONL or CSV",
    args: [{ name: "what", desc: "sessions, events or labels", required: true }],
    flags: [
      { name: "format", type: "string", value: "<FORMAT>", choices: ["jsonl", "csv"], desc: "Output format", default: "jsonl" },
      AGENT_ONE,
      { name: "repo", short: "r", type: "string", value: "<PATH>", desc: "Only sessions in this repo root" },
      SINCE,
      { name: "flag", type: "string", value: "<NAME>", desc: "Only sessions with this flag or tag, as in coding.sh sessions --flag" },
      { name: "subagents", type: "boolean", desc: "Include subagent sessions (and their events and labels)" },
      { name: "project", type: "string", value: "<ID>", desc: "Only sessions in this serve project (default: all)" },
      { name: "limit", short: "n", type: "number", value: "<N>", desc: "Only the N newest matching sessions (default: all)" },
      WHERE("sessions (and their events and labels)"),
      FRESH,
    ],
    examples: ["coding.sh export sessions --since 30d --format csv > sessions.csv", "coding.sh export events --where 'agent:codex tool.errors>0' > events.jsonl", "coding.sh export labels --format csv"],
    notes: [
      "JSONL rows are the stored objects, one per line. CSV has fixed columns (docs/reference/query.md); event payloads are a JSON column.",
      "Text cells that start with = + - or @ get a leading ' in CSV so a spreadsheet does not run them as formulas.",
      "Works on every store, Postgres and ClickHouse included. Rows are streamed, so memory stays flat.",
    ],
    load: () => import("./commands/export.ts"),
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
    summary: "Build eval suites from sessions, skills or cases, and run them",
    actions: [
      {
        name: "init",
        summary: "Scaffold an eval suite in evals/<name>/: from failed sessions, a skill, or an app's cases",
        args: [{ name: "name", desc: "Suite name (default: the skill's or cases file's name, else failures or app)" }],
        flags: [
          { name: "sessions", type: "boolean", desc: "Tasks from failed or flagged sessions in this repo (newest first)" },
          { name: "session", type: "list", value: "<ID>", desc: "Tasks from these sessions instead: an id, a prefix or latest (repeatable)" },
          { name: "since", type: "string", value: "<AGE>", desc: "With --sessions: how far back to look (30m, 12h, 7d, 2w)", default: "14d" },
          { name: "limit", type: "number", value: "<N>", desc: "With --sessions: at most N tasks", default: "10" },
          { name: "repo", type: "string", value: "<DIR|all>", desc: "With --sessions: sessions under this directory, or all, for another checkout or worktree of the project (default: this git repo)" },
          { name: "verifier", type: "string", value: "<CMD>", desc: "With --sessions: command that passes only when a task is solved (default: guessed per session)" },
          { name: "hidden-test", type: "list", value: "<GLOB>", desc: "With --sessions: test files to hide from the agent (repeatable)" },
          { name: "skill", type: "string", value: "<DIR>", desc: "Should / should-not trigger prompts for this skill" },
          { name: "should", type: "list", value: "<PROMPT>", desc: "With --skill: a prompt that should load it (repeatable)" },
          { name: "should-not", type: "list", value: "<PROMPT>", desc: "With --skill: a prompt that should not (repeatable)" },
          { name: "cases", type: "string", value: "<FILE>", desc: 'Cases for an app or prompt: JSONL, JSON or CSV of {"input", "expected"}' },
          { name: "describe", type: "string", value: "<TEXT|@FILE>", desc: "What the app or skill should do: the judge's rubric when cases have no expected answer, and the brief for --draft" },
          { name: "command", type: "string", value: "<CMD>", desc: "Command that answers one case: the input arrives as JSON on stdin, the answer is what it prints" },
          { name: "url", type: "string", value: "<URL>", desc: "Or an HTTP endpoint that answers one case (POST)" },
          {
            name: "draft",
            type: "string",
            optionalValue: true,
            valuePattern: /^(?:anthropic|openai|gateway|mock|\{.*|.+\.json)$/,
            value: "<PROVIDER|JSON>",
            desc: "Have a model write the prompts or cases you didn't give, marked draft (default provider: anthropic)",
          },
          { name: "draft-model", type: "string", value: "<MODEL>", desc: "With --draft: the model" },
          { name: "purpose", type: "string", value: "<PURPOSE>", choices: ["capability", "regression"], desc: "capability: a hill to climb (sessions default). regression: should pass nearly always, eval run exits 1 when it doesn't (skill and cases default)" },
          { name: "trials", short: "k", type: "number", value: "<N>", desc: "Trials per task, case or prompt", default: "3" },
          { name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Agent that runs the suite (default: the sessions' agent, else claude-code)" },
          { name: "force", type: "boolean", desc: "Replace an existing suite; refused when it holds files eval init did not write, or that you changed" },
          { name: "force-all", type: "boolean", desc: "Replace an existing suite and delete those files too" },
        ],
        examples: [
          "coding.sh eval init",
          "coding.sh eval init --sessions --verifier 'npm test'",
          "coding.sh eval init --skill .claude/skills/pdf --draft",
          "coding.sh eval init support --cases cases.jsonl --command 'node app.mjs'",
          "coding.sh eval init triage --describe 'Labels a support ticket bug, billing or other' --command 'node triage.mjs' --draft",
        ],
      },
      {
        name: "run",
        summary: "Run eval suites and report pass@1, pass@k, pass^k, flaky tasks and saturation",
        args: [{ name: "suite", desc: "Suite name under evals/, or its dir (default: every suite in evals/)", variadic: true }],
        flags: [
          { name: "trials", short: "k", type: "number", value: "<N>", desc: "Trials per task, case or prompt (default: the suite's trials, else 3)" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel runs" },
          { name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Agent for task and skill suites (default: the suite's, else claude-code)" },
          { name: "model", type: "string", value: "<MODEL>", desc: "Model for the agent" },
          { name: "harness", type: "string", value: "<BUNDLE>", desc: "Task suites: run this stored harness bundle (default: a snapshot of the project's current setup)" },
          { name: "summary", type: "string", value: "<FILE>", desc: "Also append the report to FILE as Markdown, e.g. \"$GITHUB_STEP_SUMMARY\" in GitHub Actions" },
          RETRIES_FLAG,
          TRIAL_TIMEOUT_FLAG,
          YES,
        ],
        graceful: true,
        examples: ["coding.sh eval run", "coding.sh eval run failures --trials 5 --yes", "coding.sh eval run triage --json", 'coding.sh eval run triage --summary "$GITHUB_STEP_SUMMARY"'],
      },
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
        args: [{ name: "task", desc: "Task id or name (repeatable; or use --tag)", variadic: true }],
        flags: [
          { name: "tag", type: "string", value: "<TAG>", desc: "Validate every task with this tag, e.g. suite:<name> after eval import or eval run" },
          { name: "k", type: "number", value: "<N>", desc: "Reference must pass N of N runs", default: "5" },
          { name: "keep", type: "boolean", desc: "Keep work directories" },
          { name: "strict-coupling", type: "boolean", desc: "Fail validation when a hidden test names an identifier or file only the reference introduces" },
        ],
        examples: ["coding.sh eval validate my-task", "coding.sh eval validate --tag suite:failures --k 1"],
      },
      {
        name: "crosscheck",
        summary: "Ask a model whether stored solutions are valid and count where the verifier disagrees",
        args: [{ name: "task", desc: "Task id or name", required: true }],
        flags: [
          { name: "experiment", type: "string", value: "<ID>", desc: "Only runs from this experiment (default: every stored run of the task)" },
          { name: "max", type: "number", value: "<N>", desc: "Runs to review (one model call each)", default: "5" },
          { name: "judge", type: "string", value: "<JSON|FILE>", desc: 'Reviewer model: {"provider":"anthropic"|"openai"|"gateway"|"claude-code"|"codex"|"mock","model":…}', default: '{"provider":"anthropic"}' },
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
        name: "trigger",
        summary: "Check that the agent loads a skill when it should and not when it shouldn't",
        args: [{ name: "skill", desc: "Skill directory, or its SKILL.md; prompts come from triggers.toml next to it", required: true }],
        flags: [
          { name: "spec", type: "string", value: "<FILE>", desc: "Trigger spec: [[should]] and [[should_not]] prompts (default: triggers.toml in the skill dir)" },
          { name: "candidate", type: "string", value: "<DIR>", desc: "A/B: another version of the skill, installed under the same name" },
          { name: "description", type: "string", value: "<TEXT|@FILE>", desc: "A/B: the same skill with only its frontmatter description replaced" },
          { name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Agent to probe (default: the --harness bundle's, else claude-code)" },
          { name: "model", type: "string", value: "<MODEL>", desc: "Model for the agent" },
          { name: "harness", type: "string", value: "<BUNDLE>", desc: "Start each arm from this harness bundle (its files, flags, env and model)" },
          { name: "k", short: "k", type: "number", value: "<N>", desc: "Runs per prompt and arm (default: the spec's k, else 3)" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel runs", default: "4" },
          { name: "seed", type: "number", value: "<N>", desc: "Seed for the run order and the bootstrap", default: "1" },
          { name: "timeout", type: "number", value: "<SEC>", desc: "Seconds per run (default: the spec's timeout_s, else 120)" },
          { name: "siblings", type: "string", value: "<DIR>", desc: "Install the skills in this dir in every arm (default: the skills next to <SKILL>)" },
          { name: "no-siblings", type: "boolean", desc: "Install only the skill under test" },
          { name: "min-f1", type: "number", value: "<X>", desc: "Exit 1 when the tested arm's F1 is under X (0 to 1)" },
          { name: "fail-on", type: "string", value: "<WHAT>", choices: ["regression"], desc: "Exit 1 when B answers fewer prompts right than A, with the 95% CI below 0" },
          YES,
        ],
        graceful: true,
        examples: [
          "coding.sh eval trigger .claude/skills/pdf -k 3 --yes",
          "coding.sh eval trigger .claude/skills/pdf --description @new-description.txt --fail-on regression --yes",
          "coding.sh eval trigger skills/pdf --candidate skills-next/pdf --min-f1 0.8 --yes",
          "coding.sh eval trigger .agents/skills/pdf -a codex --harness codex-base --yes",
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
    notes: [
      "eval run exits 1 when a regression suite has a task that fails most of its trials. A capability suite reports its score and exits 0.",
      "pass@k is the chance at least one of k trials passes; pass^k is the chance all k pass. Both are estimated from every trial run.",
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
          { name: "a", type: "string", value: "<FILE|DIR|git:REV|BUNDLE|none>", desc: "Baseline harness (default: git HEAD when B is omitted, else the repo's current files; with no uncommitted edits, the version before your last harness commit)" },
          { name: "b", type: "string", value: "<FILE|DIR|git:REV|BUNDLE|none>", desc: "Candidate harness; a file replaces the file of the same path in A (default: your uncommitted edits, else your last harness commit)" },
          { name: "behavior", type: "list", value: "<ID[,ID]>", desc: "Decision points to test: unverified-claim, done-while-failing, unchanged-retry (default: all)" },
          { name: "anchor", type: "list", value: "<FILE>", desc: "Module exporting your own anchor(s) (see the evals guide)" },
          { name: "since", type: "string", value: "<DURATION|DATE>", desc: "Sessions started since", default: "14d" },
          { name: "agent", type: "list", value: "<AGENT>", desc: "Only sessions of this agent" },
          { name: "repo", type: "string", value: "<DIR|all>", desc: "Only sessions under this directory (default: this git repo)" },
          { name: "limit", short: "n", type: "number", value: "<N>", desc: "Maximum decision points", default: "40" },
          { name: "provider", type: "string", value: "<NAME>", choices: ["anthropic", "openai", "openai-compatible", "claude-code", "codex"], desc: "Who answers the next turn and judges it: an API, or claude-code / codex to run `claude -p` / `codex exec` on your subscription (default: anthropic; with no API key set, a logged-in Claude Code, else Codex)" },
          { name: "model", type: "string", value: "<MODEL>", desc: `Model for the next turn (default: the one the decision points were recorded with, else ${DEFAULT_MODELS.anthropic} or ${DEFAULT_MODELS.openai})` },
          { name: "judge-model", type: "string", value: "<MODEL>", desc: "Model for the judge (default: --model)" },
          { name: "base-url", type: "string", value: "<URL>", desc: "API base URL (default: ANTHROPIC_BASE_URL / OPENAI_BASE_URL, else the provider's)" },
          { name: "trials", type: "number", value: "<N>", desc: "Next turns per case and arm", default: "1" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel model calls", default: "4" },
          { name: "max-cost", type: "number", value: "<USD>", desc: "Refuse to start when the estimate is over this, and stop once the spend passes it (API-equivalent dollars with claude-code or codex)" },
          { name: "dry-run", type: "boolean", desc: "Show the decision points and the cost estimate; make no model calls" },
          { name: "watch", type: "boolean", desc: "Rerun when B's files change, one line per run; Ctrl-C to stop" },
          { name: "cache", type: "boolean", desc: "Reuse stored model responses (--no-cache to ask the model again)", default: "true" },
          { name: "name", type: "string", value: "<NAME>", desc: "Experiment name (default: the dataset's)" },
          ...GATE_FLAGS,
          PROTECTED_EDIT,
          ...durableFlags("A/B"),
        ],
        graceful: true,
        examples: [
          "coding.sh exp ab",
          "coding.sh exp ab --b ./drafts/CLAUDE.md --behavior unverified-claim",
          "coding.sh exp ab --a git:main --b . --since 30d --dry-run",
          "coding.sh exp ab --provider claude-code",
          "coding.sh exp ab --watch",
        ],
      },
      {
        name: "replay",
        summary: "Replay logged model calls against the real API, with your own key, varying the model, system prompt or a field",
        args: [{ name: "call", desc: "Calls logged by coding.sh proxy: an id, a 6+ character prefix, or <session>#<n> (latest#-1 is the last call)", variadic: true }],
        flags: [
          { name: "vary", type: "list", value: "<KEY=B|KEY=A,B>", desc: "A request field to vary: model, system, tools or any body field (dots for nested, @file reads a file). One value: A sends the recorded request, B this. Two: A and B" },
          { name: "session", type: "string", value: "<SESSION>", desc: "Also replay this session's proxy calls (the last --limit)" },
          { name: "limit", type: "number", value: "<N>", desc: "With --session: the last N calls", default: "20" },
          { name: "n", type: "number", value: "<N>", desc: "Replays per call and arm", default: "5" },
          { name: "grader", short: "g", type: "list", value: "<JSON|FILE>", desc: "More grader specs (same-action always runs: does the reply take the first action the agent took?)" },
          { name: "criterion", type: "string", value: "<TEXT>", desc: "Also grade each reply with an LLM judge on this criterion" },
          { name: "judge-model", type: "string", value: "<MODEL>", desc: "Model for --criterion" },
          { name: "upstream", type: "string", value: "<URL>", desc: "API base URL (default: the proxy's upstream for the call's provider)" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel model calls", default: "4" },
          { name: "max-cost", type: "number", value: "<USD>", desc: "Refuse to start when the estimate is over this" },
          { name: "dry-run", type: "boolean", desc: "Show the calls, the arms and a cost estimate; make no model calls and need no key" },
          { name: "name", type: "string", value: "<NAME>", desc: "Experiment name (default: replay-<first call id>)" },
          ...durableFlags("replay"),
        ],
        graceful: true,
        examples: [
          "coding.sh exp replay latest#-1 --vary model=claude-haiku-4-5 --dry-run",
          "coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5",
          "coding.sh exp replay --session latest --vary system=@prompt.md --n 3",
        ],
      },
      {
        name: "run",
        summary: "Run an experiment, two tasks as one interleaved A/B, or a matrix of cells against a baseline cell",
        args: [{ name: "spec", desc: "Experiment spec JSON file (options override its fields; --grader adds graders); with \"matrix\" or \"variants\" it runs every cell" }],
        flags: [
          ...EXP_RUN_FLAGS,
          SAMPLES_FLAG,
          ...regressionFlags("experiment", "case"),
          { name: "arm", type: "list", value: "<NAME=JSON|FILE>", desc: "One arm's task spec; give two (A then B) to interleave them case by case in one run" },
          { name: "stop-early", type: "boolean", desc: "With --arm: stop once a group sequential test (O'Brien-Fleming) is decisive" },
          { name: "looks", type: "number", value: "<N>", desc: "With --stop-early: planned looks over the case budget", default: "4" },
          { name: "max-cases", type: "number", value: "<N>", desc: "With --arm: run at most N cases (a random subset)" },
          { name: "seed", type: "number", value: "<N>", desc: "With --arm or a matrix spec: seed for the case and arm order (default random, recorded)" },
          { name: "plan", type: "boolean", desc: "With a matrix spec: print the cells and what each changes, check them, and run nothing" },
          { name: "cell", type: "list", value: "<NAME>", desc: "With a matrix spec: run only this cell (repeatable); the baseline cell always runs" },
          {
            name: "reuse",
            type: "string",
            value: "<CELLS>",
            choices: ["baseline", "all", "none"],
            default: "none",
            desc: "With a matrix spec: copy finished case-trials of the same case, task, graders, trial and timeout from earlier experiments instead of running them again",
          },
          { name: "reuse-max-age", type: "string", value: "<AGE>", default: "7d", desc: "With --reuse: only case-trials that started this recently (30m, 12h, 7d, 2w)" },
          {
            name: "control",
            type: "boolean",
            desc: "A continuation task needs a control arm (A, the recorded config) to measure replay noise; --no-control runs one task alone and marks the result",
            default: "true",
          },
          { name: "series", type: "string", value: "<NAME>", desc: "Tag the experiment as the next round of an iteration loop and print whether the loop should stop (see exp plateau)" },
          { name: "watch", type: "boolean", desc: "Rerun on every change to the spec, the task's script, grader files or --watch-path; a grader-only change regrades the stored outputs. Enter reruns, q quits" },
          { name: "watch-path", type: "list", value: "<GLOB>", desc: "With --watch: more files whose change reruns the task (repeatable; also the spec's \"watch\" field)" },
          { name: "session", type: "boolean", desc: "In an experiment session (exp session new), add the run to its timeline and print the delta against the previous run; --no-session skips it", default: "true" },
          ...durableFlags("experiment"),
        ],
        graceful: true,
        examples: [
          "coding.sh exp run spec.json --watch",
          "coding.sh exp run -d smoke -g '{\"kind\":\"exact\"}' --arm base=base.json --arm cand=cand.json --stop-early --max-cases 400",
          "coding.sh exp run spec.json --resume",
          "coding.sh exp run spec.json --samples adaptive --stop-on-regression --baseline last-release",
          "coding.sh exp run matrix.json --plan",
          "coding.sh exp run matrix.json --cell model=opus,prompt=short",
          "coding.sh exp run matrix.json --reuse baseline --plan",
        ],
      },
      {
        name: "session",
        summary: "Group runs into a session: new, note <text>, summary. exp run in it prints the delta against the previous run",
        args: [
          { name: "command", desc: "new, note or summary", required: true },
          { name: "text", desc: "With note: the note (hypothesis before a run, what you saw after it)", variadic: true },
        ],
        flags: [{ name: "name", type: "string", value: "<TOPIC>", desc: "With new: the session's name" }],
        examples: ["coding.sh exp session new --name shorter-prompt", 'coding.sh exp session note "hypothesis: the shorter prompt fixes c3"', "coding.sh exp session summary --json"],
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
        name: "regrade",
        summary: "Grade a stored experiment's outputs again with new graders, without calling the task, and show what flipped",
        args: [
          { name: "experiment", desc: "Experiment id or name (newest)", required: true },
          { name: "spec", desc: "Experiment spec JSON file whose graders to use (--grader adds to them)" },
        ],
        flags: [
          { name: "grader", short: "g", type: "list", value: "<JSON|FILE>", desc: "Grader spec (repeatable); added to the spec file's graders" },
          { name: "replace-graders", type: "boolean", desc: "Use only the --grader graders, not the spec file's" },
          { name: "name", type: "string", value: "<NAME>", desc: "Name of the regraded experiment (default: the original's)" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel grader runs", default: "4" },
        ],
        examples: ["coding.sh exp regrade base spec.json", "coding.sh exp regrade base -g strict.json --json"],
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
        name: "plateau",
        summary: "Should an iteration loop stop? A restart e-detector over its experiments, and the version to ship (exit 3 stop, 2 too few, 0 continue)",
        args: [{ name: "experiments", desc: "Experiment ids or names in loop order, baseline first (default: --series or --dataset, oldest first)", variadic: true }],
        flags: [
          { name: "series", type: "string", value: "<NAME>", desc: "The experiments tagged by exp run --series NAME" },
          { name: "dataset", short: "d", type: "string", value: "<ID>", desc: "The completed experiments on this dataset" },
          { name: "baseline", type: "string", value: "<ID>", desc: "Version 0 of the loop; earlier experiments are left out" },
          { name: "eps", type: "number", value: "<GAIN>", desc: "Smallest gain per round worth another round (0.05 = 5pp)", default: "0.05" },
          { name: "delta", type: "number", value: "<P>", desc: "Stop once the evidence reaches 1/δ (false alarms average no sooner than every 1/δ rounds)", default: "0.05" },
          { name: "gate", type: "string", value: "<GATE>", choices: ["greedy", "chain"], desc: "greedy keeps a candidate only when it beats the incumbent; chain keeps every candidate (metadata.accepted overrides both)", default: "greedy" },
          { name: "bet", type: "string", value: "<BET>", choices: ["agrapa", "mixture"], desc: "Betting strategy of the detector", default: "agrapa" },
        ],
        examples: ["coding.sh exp plateau --series prompt-loop", "coding.sh exp plateau v0 v1 v2 v3 v4 --gate chain --json", "coding.sh exp run spec.json --name v5 --series prompt-loop"],
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
    notes: [
      "exp ab and refine call a model API with ANTHROPIC_API_KEY or OPENAI_API_KEY. With neither set they use a logged-in Claude Code (`claude -p`) or Codex (`codex exec`) instead and say so in one line; --provider claude-code or codex asks for one. Each call runs with no hooks, plugins, MCP servers or settings of yours, in an empty directory, with a throwaway CLAUDE_CONFIG_DIR or CODEX_HOME holding only a copy of the login. claude -p gets the session's own Claude Code tools and refuses every call, so none runs.",
      "On a subscription, costs are API-equivalent (what the same tokens would cost on the API), there is no spending cap unless you pass --max-cost, calls run 2 at a time, rate limits back off and retry, and a spent usage limit stops the run and keeps the finished trials.",
      "With no uncommitted harness edits, exp ab tests your last commit that changed CLAUDE.md, AGENTS.md, a rule or a skill (B) against the version before it (A).",
    ],
    load: () => import("./commands/exp.ts"),
  },
  {
    name: "judge",
    group: "Evaluate",
    summary: "Grade one output or the slop in captured diffs, or check an LLM judge or a test verifier against human labels",
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
          { name: "diff", type: "string", value: "<FILE|->", desc: "The agent's work as a unified diff, for agent-slop (default: $CODING_SH_AGENT_DIFF in a verifier)" },
        ],
        examples: [
          "coding.sh judge grade --grader checklist.json",
          "coding.sh judge grade --grader judge.json --output answer.txt --trace stream.jsonl --json",
          `coding.sh judge grade --grader '{"kind":"agent-slop","maxWarnings":5}'`,
        ],
      },
      {
        name: "slop",
        summary: "Flag agent-slop patterns (placeholder code, type escapes, swallowed errors, debug prints, focused tests) in the lines captured work added",
        args: [{ name: "target", desc: "Session id, prefix or 'latest' (default), a run id (run_…), or a compare experiment id (exp_…) for a rate per arm" }],
        flags: [
          { name: "diff", type: "string", value: "<FILE|->", desc: "Grade this unified diff instead of captured work" },
          { name: "rules", type: "list", value: "<ID>", desc: "Rules to run instead of the defaults; 'default' and 'all' name those sets (repeatable)" },
          { name: "exclude", type: "list", value: "<ID>", desc: "Rule to leave out (repeatable)" },
          { name: "max-errors", type: "number", value: "<N>", desc: "Pass with at most N error findings", default: "0" },
          { name: "max-warnings", type: "number", value: "<N>", desc: "Pass with at most N warnings (default: no limit)" },
          { name: "list-rules", type: "boolean", desc: "Print the rule catalog and exit" },
        ],
        examples: [
          "coding.sh judge slop latest",
          "coding.sh judge slop exp_01JC3T6Z2Q8W1S5V0R7N4K9M2D --json",
          "git diff main | coding.sh judge slop --diff -",
          "coding.sh judge slop latest --rules default --rules unknown-param --exclude debug-print",
          "coding.sh judge slop --list-rules",
        ],
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
          SAMPLES_FLAG,
          ...regressionFlags("experiment", "task"),
          { name: "split", type: "string", value: "<SPLIT>", choices: ["dev", "heldout", "all"], desc: "Task split", default: "dev" },
          { name: "task", short: "t", type: "list", value: "<ID>", desc: "Only this task (repeatable)" },
          { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel trials" },
          { name: "keep", type: "boolean", desc: "Keep trial sandboxes" },
          YES,
        ],
        examples: [
          "coding.sh toolevals run gh --driver agent:claude-code -k 3",
          "coding.sh toolevals run everything --driver model:anthropic/claude-sonnet-5-5 --variant base --variant terse",
          "coding.sh toolevals run gh --driver agent:claude-code --samples adaptive --stop-on-regression --baseline texp_01J…",
        ],
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
    name: "improve",
    group: "Harness",
    summary: "What to fix first in your sessions, the line that fixes it, and whether your last CLAUDE.md or AGENTS.md changes helped",
    actionOptional: true,
    flags: IMPROVE_FLAGS("14d", 5),
    actions: [
      {
        name: "fix",
        summary: "Add an issue's line to CLAUDE.md or AGENTS.md (uncommitted), then print the command that tests it",
        args: [{ name: "issue", desc: "Its number in coding.sh improve, or its id (flag:no-verification)", required: true }],
        flags: [...IMPROVE_FLAGS("14d", 50).filter((f) => f.name !== "limit"), { name: "target", type: "string", value: "<FILE>", desc: "Repo file to add the line to (default: CLAUDE.md or AGENTS.md, whichever the issue's agent reads)" }, DRY_RUN],
        examples: ["coding.sh improve fix 1", "coding.sh improve fix flag:no-verification --target AGENTS.md --dry-run"],
      },
      {
        name: "check",
        summary: "Did each committed CLAUDE.md, AGENTS.md, rule or skill change help? Sessions before vs after it; exit 1 when one made things worse",
        flags: [
          ...IMPROVE_FLAGS("30d", 5),
          { name: "watch", type: "boolean", desc: "Keep running and print a line when a change's verdict moves as new sessions arrive" },
          { name: "interval", type: "number", value: "<SECONDS>", desc: "With --watch: how often to re-check", default: "60" },
          { name: "sessions", type: "boolean", desc: "List every session still flagged after each change, not just the newest 5" },
        ],
        examples: ["coding.sh improve check", "coding.sh improve check --since 7d --json", "coding.sh improve check --sessions", "coding.sh improve check --watch"],
      },
    ],
    examples: ["coding.sh improve", "coding.sh improve --since 30d --repo all", "coding.sh improve fix 1", "coding.sh improve check"],
    notes: [
      "improve lists the failure flags in this repo's sessions and any command or tool that fails the same way in two or more sessions. Issues seen in two or more sessions come first, then by the severity score refine uses. Each issue has an example session, a fix, and the commands that take it through the loop: show, improve fix, exp ab, improve check.",
      "A failing test command that already failed before the agent changed any file is reported as a broken setup: fix the command first, or the agent can't check its work.",
      "When sessions ran on the repo's current harness version (the newest commit that changed CLAUDE.md, AGENTS.md, a rule or a skill) and none of them had an issue, the issue is marked 'Not seen since <commit>', goes last, and points at improve check instead of a new line.",
      "check reads the git history of CLAUDE.md, AGENTS.md, GEMINI.md, .claude/rules, .cursor/rules and skills. A session counts for the newest such commit its starting HEAD contains, so uncommitted edits count from the commit that keeps them. Sessions with no recorded HEAD, and sessions with no tool call outside MCP servers (a chat, or asking coding.sh about a change), are left out.",
      "check compares sessions with a failure flag before and after each change, and, for each added line that names a command, flag, path or identifier, the share of sessions that acted on it. Two-sided Fisher exact tests at p ≤ 0.1: more flagged sessions is Regressed (exit 1); fewer, or the new line followed more with nothing worse, is Helped. Under 5 sessions after a change without a clear result is Too early to tell.",
      "Under each change, check lists the sessions after it that still have a failure flag, newest first, with their flags (5, or all with --sessions; --json has every flagged session before and after).",
      "exp ab (the replay A/B that improve suggests) needs ANTHROPIC_API_KEY, OPENAI_API_KEY, or Claude Code or Codex logged in (it runs on your subscription then). Without any of them, commit the change and let improve check judge it on new sessions.",
    ],
    load: () => import("./commands/improve.ts"),
  },
  {
    name: "harness",
    group: "Harness",
    summary: "Snapshot and list agent harness bundles; audit which memory and instruction files agents use",
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
          {
            name: "plugin",
            type: "list",
            value: "<PLUGIN>",
            desc: "claude-code: carry this Claude Code plugin, an installed one (name or name@marketplace) or a plugin directory (repeatable). Only the plugins named here are carried",
          },
        ],
        examples: [
          "coding.sh harness snapshot --agent claude-code --name base",
          "coding.sh harness snapshot --agent claude-code --name with-caveman --plugin caveman",
          "coding.sh harness snapshot --agent claude-code --plugin ./my-plugin",
          "coding.sh harness snapshot --file harness.toml",
        ],
      },
      { name: "list", summary: "List harness bundles" },
      {
        name: "audit",
        summary: "Count the sessions that loaded, read and wrote each memory, CLAUDE.md, AGENTS.md, rule and skill file; warn about subagent files Claude Code misreads",
        flags: [
          { name: "agent", short: "a", type: "string", value: "<AGENT>", desc: "Only this agent's sessions and files" },
          { ...SINCE, default: "30d" },
          { name: "limit", type: "number", value: "<N>", desc: "Files to list, flagged first", default: "40" },
        ],
        examples: ["coding.sh harness audit", "coding.sh harness audit --agent claude-code --since 90d", "coding.sh harness audit --json"],
      },
    ],
    notes: [
      "A harness TOML can carry Claude Code plugins too: plugins = [\"caveman\", \"./plugins/mine\"], with a directory relative to the TOML file.",
      "A plugin is looked up read-only in plugins/installed_plugins.json under $CLAUDE_CONFIG_DIR (default ~/.claude), or read from a directory with .claude-plugin/plugin.json. Its whole directory is stored in the bundle. A run writes it under the run's own home and starts Claude Code with --plugin-dir; your Claude config is not touched.",
    ],
    load: () => import("./commands/harness.ts"),
  },
  {
    name: "compare",
    group: "Harness",
    summary: "A/B two harness bundles on eval tasks",
    args: [
      { name: "a", desc: "Baseline bundle id or name", required: true },
      { name: "b", desc: "Candidate bundle id or name (omit with --without or --with)" },
    ],
    flags: [
      { name: "task", short: "t", type: "list", value: "<ID>", desc: "Task id (repeatable; default: all validated tasks)" },
      { name: "tag", type: "string", value: "<TAG>", desc: "Run every non-archived task with this tag, drafts included (e.g. the tag given to eval import)" },
      { name: "k", type: "number", value: "<N>", desc: "Attempts per task and arm", default: "1" },
      { name: "concurrency", short: "c", type: "number", value: "<N>", desc: "Parallel runs" },
      { name: "max-cost", type: "number", value: "<USD>", desc: "Spend cap: once finished runs (agent plus judge grade calls) reach it, no new run starts" },
      { name: "experiment", type: "string", value: "<ID>", desc: "Compare the stored runs of this experiment instead of running" },
      { name: "retry-errors", type: "boolean", desc: "With --experiment: run again the runs that errored or hit infrastructure errors, in place; the old runs are kept, marked superseded" },
      { name: "failing", type: "string", value: "<EXP>[@BUNDLE]", desc: "Run only the tasks A (or BUNDLE) failed in that stored comparison" },
      { name: "failing-mode", type: "string", value: "<MODE>", choices: ["any", "majority"], default: "any", desc: "With --failing: a task counts as failed in any attempt, or in more than half" },
      { name: "sample", type: "number", value: "<N>", desc: "Run a random sample of N of the selected tasks" },
      { name: "seed", type: "number", value: "<N>", desc: "With --sample: seed for the draw (default random, printed in the report). With --false-alarm: seed for which runs get it (default 0)" },
      { name: "repair", type: "number", value: "<N>", desc: "After a failed verifier, tell the agent and let it try again in its own session, up to N rounds (1-8); hidden tests stay out of its tree" },
      { name: "repair-signal", type: "string", value: "<SIGNAL>", choices: ["bit", "names"], default: "bit", desc: "With --repair: say only that verification failed, or also name the failing tests (parsed from the verifier output)." },
      { name: "false-alarm", type: "number", value: "<P>", desc: "With --repair: tell this share (0-1) of passing runs they failed, to measure what a wrong signal breaks" },
      { name: "repair-verdict", type: "boolean", desc: "Verdict, gates and pass rates on the pass after repair rounds instead of the first attempt" },
      {
        name: "reuse",
        type: "string",
        value: "<ARMS>",
        choices: ["baseline", "both", "none"],
        default: "none",
        desc: "Copy finished runs of the same task, bundle, agent version, attempt and timeout from earlier comparisons and eval runs instead of running them again",
      },
      { name: "reuse-max-age", type: "string", value: "<AGE>", default: "7d", desc: "With --reuse: only runs that finished this recently (30m, 12h, 7d, 2w)" },
      { name: "dry-run", type: "boolean", desc: "Print how many runs each arm would reuse and run, and run nothing" },
      { name: "without", type: "list", value: "<PATH>", desc: "Ablation: B is A without this file, dir or glob, or without plugin:<NAME> (repeatable)" },
      { name: "with", type: "list", value: "plugin:<PLUGIN>", desc: "B is A plus this Claude Code plugin, an installed one (name or name@marketplace) or a plugin directory (repeatable; claude-code bundles)" },
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
      "coding.sh compare base candidate2 --k 3 --reuse baseline --dry-run",
      "coding.sh compare base candidate --experiment exp_01",
      "coding.sh compare base candidate --experiment exp_01 --audited",
      "coding.sh compare base candidate --experiment exp_01 --retry-errors",
      "coding.sh compare base candidate2 --failing exp_01 --k 3",
      "coding.sh compare base candidate --sample 20 --seed 7",
      "coding.sh compare base candidate --k 3 --repair 2 --repair-signal names",
      "coding.sh compare base candidate --k 3 --gate",
      "coding.sh compare base candidate --k 3 --gate --by suite:",
      "coding.sh compare no-skill with-skill --tag skill-eval --gate --by suite: --max-cost 15",
      "coding.sh compare base candidate --k 3 --promote",
      "coding.sh compare base --without .claude/rules/clock.md --k 3 --item-gate",
      "coding.sh compare base --with plugin:caveman --k 3 --gate",
      "coding.sh compare with-caveman --without plugin:caveman --k 3",
      "coding.sh compare sonnet gpt5 --gateway",
      "coding.sh compare sonnet gpt5 --gateway openrouter",
    ],
    load: () => import("./commands/compare.ts"),
  },
  {
    name: "refine",
    group: "Harness",
    summary: "Improve CLAUDE.md, AGENTS.md and skills in tested rounds, and protect their safety rules",
    actions: [
      {
        name: "propose",
        summary: "Ask a model for lines that address your sessions' most severe flags; stores them as a candidate",
        flags: [...REFINE_SOURCE_FLAGS.filter((f) => ["since", "agent", "repo", "provider", "base-url"].includes(f.name)), PROPOSER_MODEL, PROPOSER_COMMAND, REFINE_TARGET, { name: "dry-run", type: "boolean", desc: "Print the findings and the prompt; make no model call" }],
        examples: ["coding.sh refine propose", "coding.sh refine propose --target CLAUDE.md --dry-run"],
      },
      {
        name: "test",
        summary: "Test candidate edits against your current files; keep, reject or inconclusive per candidate, exit 0 when one is kept",
        args: [{ name: "candidate", desc: "Edited file, directory, git:REV, harness bundle or stored r_… id; a file replaces the harness file at its repo path, else the one with its name (./drafts/AGENTS.md replaces AGENTS.md)", required: true, variadic: true }],
        flags: [...REFINE_SOURCE_FLAGS, ...REFINE_TRIAL_FLAGS, ...REFINE_SUITE_FLAGS, { name: "dry-run", type: "boolean", desc: "Show the checks, decision points, guard set size and cost estimate; make no model calls" }],
        graceful: true,
        examples: [
          "coding.sh refine test ./drafts/AGENTS.md",
          "coding.sh refine test r_3f9a1c02e1 --behavior unverified-claim --max-cost 2",
          "coding.sh refine test ./a/CLAUDE.md ./b/CLAUDE.md --dry-run --json",
          "coding.sh refine test ./drafts/CLAUDE.md --suite fixes --objective cost,wall --margin 2pp --yes",
        ],
      },
      {
        name: "apply",
        summary: "Write a kept candidate to your files, backing up what it replaces (never commits)",
        args: [{ name: "candidate", desc: "Candidate id (default: the latest kept candidate not yet applied)" }],
        flags: [{ name: "force", type: "boolean", desc: "Apply a candidate that was not kept, or whose files changed since its test (recorded in the ledger)" }],
        examples: ["coding.sh refine apply", "coding.sh refine apply r_3f9a1c02e1"],
      },
      {
        name: "rollback",
        summary: "Put back what an apply replaced, from its backup",
        args: [{ name: "candidate", desc: "Candidate or apply id (default: the latest apply)" }],
        flags: [{ name: "force", type: "boolean", desc: "Roll back though the file changed since the apply (those changes are lost)" }],
        examples: ["coding.sh refine rollback", "coding.sh refine rollback r_3f9a1c02e1"],
      },
      {
        name: "log",
        summary: "Every round in this repo: verdict, effect CI, guard result, cost and reason, and whether the loop plateaued; --suite climbs show pass rate, cost, time and size per round and the Pareto front",
        examples: ["coding.sh refine log", "coding.sh refine log --json"],
      },
      {
        name: "run",
        summary: "Loop: propose (or take --candidate), test, apply when kept; stop at --rounds, --max-cost or a plateau",
        flags: [
          { name: "rounds", type: "number", value: "<N>", desc: "Most rounds (default: 3, none with --until-plateau)" },
          { name: "candidate", type: "list", value: "<FILE|r_…>", desc: "Test these in order instead of asking the proposer (repeatable)" },
          { name: "until-plateau", type: "boolean", desc: "With --suite: keep climbing until the e-detector says the climb stopped gaining; --resume continues an interrupted round" },
          PROPOSER_MODEL,
          PROPOSER_COMMAND,
          REFINE_TARGET,
          ...REFINE_SOURCE_FLAGS,
          ...REFINE_TRIAL_FLAGS,
          ...REFINE_SUITE_FLAGS,
          { name: "dry-run", type: "boolean", desc: "Show the findings, decision points, guard set size and per-round estimate; make no model calls" },
        ],
        graceful: true,
        examples: [
          "coding.sh refine run --rounds 5 --max-cost 10",
          "coding.sh refine run --candidate ./v1/AGENTS.md --candidate ./v2/AGENTS.md",
          "coding.sh refine run --dry-run",
          "coding.sh refine run --suite fixes --objective cost --margin 2pp --until-plateau --yes",
          "coding.sh refine run --target .claude/skills/pdf --objective wall,cost --proposer-command 'claude -p' --yes",
          "coding.sh refine run --suite fixes --objective cost --until-plateau --resume --yes",
        ],
      },
      {
        name: "protected",
        summary: "List the harness lines an edit may not delete, reword or relax",
        flags: [{ name: "a", type: "string", value: "<FILE|DIR|git:REV|BUNDLE>", desc: "Harness to read (default: the repo's current CLAUDE.md, AGENTS.md, GEMINI.md, rules and skills)" }],
        examples: ["coding.sh refine protected", "coding.sh refine protected --a git:main --json"],
      },
      {
        name: "check",
        summary: "Check a harness edit for deleted, reworded or relaxed protected lines; exit 1 when it has any",
        flags: [
          { name: "a", type: "string", value: "<FILE|DIR|git:REV|BUNDLE|none>", desc: "Before (default: git HEAD when B is omitted, else the repo's current files)" },
          { name: "b", type: "string", value: "<FILE|DIR|git:REV|BUNDLE|none>", desc: "After; a file replaces the file of the same path in A (default: your uncommitted edits)" },
          PROTECTED_EDIT,
        ],
        examples: ["coding.sh refine check", "coding.sh refine check --b ./drafts/AGENTS.md", "coding.sh refine check --a git:main --b . --json", "coding.sh refine check --allow-protected-edit AGENTS.md:12"],
      },
      {
        name: "score",
        summary: "Score diagnoses against human labels: occurrence, Signal and session precision and recall, coverage, repeat agreement",
        args: [{ name: "labels", desc: "Labels JSONL: one occurrence per line, {sessionId, signalId, component: {type, name}, typeIds: [1-3 ids], nature?}; a line with only sessionId marks a session with nothing found", required: true }],
        flags: [{ name: "pred", type: "list", value: "<FILE>", desc: "Predictions in the labels format (repeatable; 2 or more adds repeat agreement). Default: the labelled sessions' flags from the store" }],
        examples: ["coding.sh refine score labels.jsonl --pred diagnoses.jsonl", "coding.sh refine score labels.jsonl --pred run1.jsonl --pred run2.jsonl --pred run3.jsonl --json", "coding.sh refine score labels.jsonl"],
      },
    ],
    notes: [
      "A protected line is inside a <!-- coding.sh:protect --> … <!-- coding.sh:protect end --> block, matches a [refine] protect regex, or pairs a gate word (never, don't, must not, only, before, ask, confirm, verify, check, require) with a safety topic (credentials, secrets, access tokens, private keys, .env, prod, deploy, push, --force, force-push, destructive, --no-verify, rm -rf, delete, drop table, reset --hard, migrations, permissions, sudo, chmod, payments, PII, another user, owner, dry-run, backups). Set [refine] autoProtect = false in your user config to keep only markers and patterns.",
      "check rejects an edit that deletes or rewords a protected line (protected-line), or adds a line that waives one (skip, no need, only … when, unless, without asking, already verified …) and shares a backticked token, a word or a safety topic with it (relaxes-protected).",
      "exp ab runs the same check on its arms and warns; with --gate a protected-line problem fails the run.",
      "test decides each candidate in stages: the protected-line check, the harmless and duplicate critics on the added lines, an A/B against your current files on the decision points exp ab mines (the acceptance gate: ship goes on, hold is inconclusive, don't ship rejects), then the guard set: the decision points earlier kept edits won must not go from solved to unsolved. A run stopped at --max-cost is inconclusive.",
      "The ledger and every tested candidate's files live under the data dir (refine/<repo>-<hash>/). Rejected candidates and their reasons go into the next proposal prompt; protected lines go in as READ-ONLY.",
      "With --suite, each round runs the suite's repo tasks --trials times (default: the suite's trials, else 3) with the current files and with the candidate, interleaved, as one durable job; --model is the agent's model, --concurrency the parallel sessions, --max-cost caps agent and proposer spend. The candidate is kept when the pass rate is significantly better (one-sided paired permutation test over tasks, or the acceptance gate says ship), or when it holds within --margin (one-sided bootstrap lower bound) and a listed objective is significantly better by --min-gain (per-task log ratios, one-sided permutation test); a hard regression, a don't-ship gate or a listed objective significantly worse rejects it. Below 5 tasks no test can reach significance.",
      "With --suite and a primary objective other than pass, the proposer cuts instead of adding: it sees the target file, its largest sections and what made the last runs slow or expensive (tokens, turns, repeated tool calls, long outputs), and replies with edits: find and replace an exact string, or replace a whole section by its heading. The protected-line check and the critics still run on the result.",
      "score matches by code, never a model: a prediction matches a label in the same session with the same component (type, and name compared after Unicode, case, camelCase and separator normalization) whose top-3 type ids share one id, under a maximum one-to-one matching. Unmatched items count against precision or recall; a rate with nothing to divide by prints —. Without --pred, each diagnosed session flag is a prediction with no component, so it matches on session and type ids alone, and per-flag precision is reported. score writes nothing.",
    ],
    load: () => import("./commands/refine.ts"),
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
    name: "purge",
    group: "Maintain",
    summary: "Remove a leaked secret from the store: events, search, blobs, spool, eval runs",
    sensitive: true,
    flags: [
      { name: "literal", type: "string", value: "<FILE|->", desc: "File with the values to remove, one per line (- reads stdin); never pass them as arguments" },
      { name: "rule", type: "list", dashValue: true, value: "<REGEX>", desc: "Also remove every match of this regular expression (repeatable); describe the secret's shape, not the secret" },
      { name: "dry-run", type: "boolean", desc: "Count the copies without changing anything" },
    ],
    examples: ["coding.sh purge --literal leaked.txt --dry-run", "pbpaste | coding.sh purge --literal -", "coding.sh purge --rule 'sk-ant-api03-[A-Za-z0-9_-]{80,}' --dry-run"],
    notes: [
      "Every copy becomes [redacted:purged]: event payloads (the full-text index is updated), session titles and stats, labels, eval docs and settings. Blobs holding a value are rewritten under their new hash and every reference follows. Spool, judge-cache and eval run files (~/.coding.sh/runs) keep their length (the value becomes asterisks) so ingest offsets stay valid. A run's .git directory and files over 64 MB are left alone.",
      "--rule takes a JavaScript regular expression. Each distinct match of 8 or more characters is purged like a --literal value; shorter matches are left alone, and a rule that matches over 10,000 distinct values is refused.",
      "Then the search index is merged and the database VACUUMed, so the old bytes leave the file. Values shorter than 8 characters are refused. Only the SQLite store is supported.",
      "Rotate the secret as well: copies in the agent's own transcripts, shell history or git are not touched.",
    ],
    load: () => import("./commands/purge.ts"),
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
