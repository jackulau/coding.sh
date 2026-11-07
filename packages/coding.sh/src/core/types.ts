// Core contracts shared by every module. Changing anything here is a
// cross-module change: owners of store/, adapters/, eval/, runner/, viewer/
// and cli/ all build against these types.
import type { AgentEvent, AgentId, BlobRef, RepoState, Session, Usage } from "../schema/index.ts";
import type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "../datasets/types.ts";

// ---------------------------------------------------------------- spool

/** One line in ~/.coding.sh/spool/<agent>/<yyyy-mm-dd>.<pid>.jsonl, written by the hook. */
export interface SpoolLine {
  v: 0;
  agent: AgentId;
  /** Hook/event name as the agent calls it, e.g. "PostToolUse". */
  event: string;
  ts: number;
  pid: number;
  /** Parent pid (the agent process), for grouping when the agent sends no session id. */
  ppid?: number;
  cwd: string;
  /** CODING_SH_RUN_ID if set in the hook's environment. */
  runId?: string;
  /** Host app that launched the agent (T3 Code), from its env marker (spool/host.ts). */
  host?: { id: string; thread?: string };
  /** "vercel" when the hook's env routed model calls through Vercel AI Gateway
   *  (ANTHROPIC_BASE_URL / OPENAI_BASE_URL at ai-gateway.vercel.sh). Never the key. */
  gateway?: string;
  /** Parsed stdin JSON when it parsed, else the raw string. Omitted when rawFile is set. */
  raw: unknown;
  /** When raw was too large to inline, the path of the side file holding it
   *  (read with "try JSON.parse, else the string" — see spool/write.ts resolveRaw). */
  rawFile?: string;
}

export interface SpoolCursor {
  file: string;
  offset: number;
}

// ---------------------------------------------------------------- storage

export interface SessionFilter {
  agent?: AgentId;
  /** Only children of this session (subagents); null = only top-level sessions. */
  parentSessionId?: string | null;
  repoRoot?: string;
  runId?: string | null; // null = only non-run (organic) sessions
  flag?: string;
  since?: number;
  until?: number;
  /** Only sessions of this project ("default" = sessions with no project). */
  project?: string;
  limit?: number;
  offset?: number;
}

/** Options for IndexStore.search. */
export interface SearchOpts {
  limit?: number;
  agent?: AgentId;
  /** Only events of this project ("default" = events with no project). */
  project?: string;
}

/** Held by the one replica allowed to write (see IndexStore.acquireWriterLock). */
export interface WriterLock {
  release(): Promise<void>;
  /**
   * Throws once the lease is no longer this holder's (another replica broke it
   * after a stall, e.g. a synchronous store call that blocked the heartbeat).
   * The writer checks it before every write tick and exclusive job. Optional:
   * a lock that cannot be lost need not implement it.
   */
  assertHeld?(): void;
}

export interface SearchHit {
  event: AgentEvent;
  snippet: string;
}

export interface Label {
  id: string;
  sessionId: string;
  /** Dataset case this label attaches to, when labelling eval cases rather than sessions. */
  caseId?: string;
  /** What is being labelled, e.g. "outcome" or a judge's criterion id. */
  criterion: string;
  value: "pass" | "fail" | "skip";
  note?: string;
  by: string;
  ts: number;
}

/** A price-table cost for one stored event (IndexStore.setEventCosts). */
export interface EventCost {
  id: string;
  costUsd: number;
  /** The sibling model whose price was used, when the event's own model has no row. */
  pricedAs?: string;
}

/** The queryable index. Default: SQLite. Must be idempotent on ids. */
export interface IndexStore {
  readonly kind: string;
  migrate(): Promise<void>;
  close(): Promise<void>;

  putEvents(batch: AgentEvent[]): Promise<{ inserted: number }>;
  upsertSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  listSessions(filter?: SessionFilter): Promise<Session[]>;
  listEvents(sessionId: string, opts?: { kinds?: string[]; limit?: number; offset?: number }): Promise<AgentEvent[]>;
  search(text: string, opts?: SearchOpts): Promise<SearchHit[]>;

  getCursor(source: string): Promise<number>;
  setCursor(source: string, offset: number): Promise<void>;

  putTask(task: EvalTask): Promise<void>;
  getTask(id: string): Promise<EvalTask | undefined>;
  listTasks(opts?: { status?: EvalTask["status"]; tag?: string }): Promise<EvalTask[]>;

  putBundle(bundle: HarnessBundle): Promise<void>;
  /** By id, else the bundle with that name and the newest createdAt (ties: the greatest id). */
  getBundle(idOrName: string): Promise<HarnessBundle | undefined>;
  listBundles(): Promise<HarnessBundle[]>;

  putRun(run: RunResult): Promise<void>;
  listRuns(filter?: { taskId?: string; bundleId?: string; experimentId?: string }): Promise<RunResult[]>;

  putLabel(label: Label): Promise<void>;
  listLabels(filter?: { sessionId?: string; criterion?: string }): Promise<Label[]>;

  /** All blob refs referenced anywhere (for gc). */
  referencedBlobs(): AsyncIterable<BlobRef>;

  // ---- optional capabilities. Callers feature-test (`if (index.putDataset)`) and
  // fall back (e.g. FileEvalStore keeps JSON files) when a backend lacks them.

  /** Reclaim space (e.g. SQLite VACUUM + FTS optimize). Used by `gc --compact`. */
  compact?(): Promise<void>;

  /** Cheap round trip that throws when the store is unreachable (serve's /readyz). */
  ping?(): Promise<void>;
  /** Up to `limit` session ids starting with `prefix`, sorted (`coding.sh show <prefix>`, like a git short hash). */
  sessionIdsByPrefix?(prefix: string, limit: number): Promise<string[]>;
  /**
   * How many sessions name each of `parentIds` as their parent (only in one
   * project when given), in one query. Ids with no children may be left out.
   * The viewer's session list uses it; without it, one listSessions per row.
   */
  childCounts?(parentIds: string[], opts?: { project?: string }): Promise<Record<string, number>>;
  /**
   * The single-writer lock `coding.sh serve` holds while it ingests. Resolves
   * undefined when another process holds it (after waiting up to waitMs, default 0).
   */
  acquireWriterLock?(opts?: { waitMs?: number }): Promise<WriterLock | undefined>;
  /**
   * Retention: deletes sessions whose last activity is before cutoffMs
   * (optionally only one project), with their events and labels. Last activity
   * is the latest of coalesce(endedAt, startedAt) and every event's end
   * (ts + durationMs), so a resumed session, or one that never sent
   * session.end, survives while it still gets events.
   * Eval assets (tasks, datasets, experiments, judges) are never touched.
   */
  deleteBefore?(cutoffMs: number, opts?: { project?: string }): Promise<{ sessions: number; events: number }>;
  /**
   * Atomically deletes these events of one session (ids of other sessions are
   * ignored) and inserts `add` (idempotent on id, as putEvents), so a reader
   * sees the session's rows either before or after, never half re-parsed.
   * Used by re-parse (core/reparse.ts); without it sessions are not re-parsed.
   */
  replaceSessionEvents?(sessionId: string, removeIds: string[], add: AgentEvent[]): Promise<{ removed: number; inserted: number }>;
  /** Distinct project ids that have sessions ("default" for unscoped ones). Optional: serve falls back to scanning sessions. */
  listProjects?(): Promise<string[]>;

  /**
   * Sets an estimated cost on stored events in place (`usage.costUsd`,
   * `payload.costEstimated = true`, and `payload.pricedAs` when given, removed
   * when not); ids and everything else stay. Used by the reprice pass over events
   * stored before local pricing or under older prices. Returns how many it found.
   */
  setEventCosts?(costs: EventCost[]): Promise<number>;

  /**
   * Runs `fn` as one transaction: every write it makes commits together when it
   * resolves, or none does when it throws. Ingest commits each checkpoint's
   * events, session rows and spool cursors this way. Writes made on the same
   * connection by anything else while `fn` is pending join it. Without it,
   * ingest writes rows before cursors, so a crash re-reads lines (idempotent).
   */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;

  /** Small durable key/value state (e.g. the OTLP trace → session map). */
  kvGet?(key: string): Promise<string | undefined>;
  kvSet?(key: string, value: string | undefined): Promise<void>;

  /** Stores an immutable dataset version and points "latest" at it. Same content → `created: false`. */
  putDataset?(ds: Dataset, opts?: { note?: string; now?: number }): Promise<{ version: string; created: boolean }>;
  /** A stored version; "latest" (default) follows the latest pointer. */
  getDataset?(id: string, version?: string | "latest"): Promise<Dataset | undefined>;
  listDatasets?(): Promise<DatasetListing[]>;
  /** In the order the versions were first stored (history order), whatever their createdAt. */
  listDatasetVersions?(id: string): Promise<DatasetVersionInfo[]>;

  putExperiment?(r: ExperimentResult): Promise<void>;
  getExperiment?(id: string): Promise<ExperimentResult | undefined>;
  /** Newest first (id descending). `limit` 0 returns none; undefined or negative means no limit. */
  listExperiments?(filter?: { datasetId?: string; name?: string; limit?: number }): Promise<ExperimentResult[]>;

  putJudge?(v: JudgeVersion): Promise<void>;
  getJudge?(id: string): Promise<JudgeVersion | undefined>;
  /** Sorted by id. */
  listJudges?(): Promise<JudgeVersion[]>;
}

/** One row of IndexStore.listDatasets / FileEvalStore.listDatasets. */
export interface DatasetListing {
  id: string;
  name: string;
  latest: string;
  versions: number;
  cases: number;
}

export interface BlobMeta {
  contentType?: string;
}

/** Content-addressed, write-once. Default: filesystem + zstd. */
export interface BlobStore {
  readonly kind: string;
  put(data: Uint8Array | string, meta?: BlobMeta): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array | undefined>;
  getText(ref: BlobRef): Promise<string | undefined>;
  has(refs: BlobRef[]): Promise<boolean[]>;
  list(): AsyncIterable<BlobRef>;
  delete(ref: BlobRef): Promise<void>;
  /** Total bytes on disk (compressed), when cheaply knowable. */
  size?(): Promise<number>;
  /** Stored size and age of one blob (gc uses age; stores without it are never swept). */
  stat?(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined>;
  /**
   * A write-behind view for bulk writers (ingest): puts return their ref without
   * waiting for the write, and `flush()` makes them all durable together. Write
   * no index row that references a blob of the batch before `flush()` resolves.
   */
  batch?(): BlobBatch;
}

/** See BlobStore.batch. Reads through the batch see its unflushed puts. */
export interface BlobBatch extends BlobStore {
  /** Resolves once every put made through this batch is durable and readable through the store; rejects with the first write error. */
  flush(): Promise<void>;
}

export interface SinkAck {
  ok: boolean;
  error?: string;
  /** Retry after this many ms when not ok. */
  retryAfterMs?: number;
}

/** Write-only mirror (OTLP, HTTP, …). Each sink keeps its own cursor and retries. */
export interface Sink {
  readonly name: string;
  readonly mode: "full" | "metadata";
  write(batch: AgentEvent[], sessions: Session[], blobs: BlobStore): Promise<SinkAck>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------- config

export interface Config {
  /** Root data dir, default ~/.coding.sh (override with CODING_SH_HOME). */
  home: string;
  store: {
    /** e.g. "sqlite://~/.coding.sh/index.db", "postgres://…" */
    index: string;
    /** e.g. "file://~/.coding.sh/blobs", "s3://bucket/prefix" */
    blobs: string;
  };
  capture: {
    mode: "full" | "metadata";
    /** Built-in redactors to run: "secrets" (API keys, tokens), "env" (env var values). */
    redact: string[];
    /** Extra regexes (source strings) to redact. */
    redactPatterns: string[];
    /** Repos (globs on realpath) to never capture. */
    exclude: string[];
    /** Inline payload limit before moving to a blob. */
    maxInlineBytes: number;
  };
  snapshot: {
    enabled: boolean;
    maxFiles: number;
    timeoutMs: number;
  };
  sinks: SinkConfig[];
  retention: {
    /** Days to keep spool files after all sinks acked. */
    keepSpoolDays: number;
    /** Days to keep file-read/tool-output blobs (diffs and eval tasks are kept). */
    toolOutputDays: number;
  };
  update: {
    /** Check for a newer release in the background (at most daily). */
    check: boolean;
  };
  /** `[prices."<model>"]` (or the older `[pricing."<model>"]`) overrides of the built-in price table (USD per 1M tokens). */
  pricing?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
}

export interface SinkConfig {
  kind: string; // "otlp" | "http" | third-party
  name?: string;
  endpoint: string;
  mode: "full" | "metadata";
  headers?: Record<string, string>;
  batchSize?: number;
}

// ---------------------------------------------------------------- adapters

export interface FileChange {
  path: string;
  action: "create" | "modify" | "delete";
  /** Human-readable summary for --dry-run output. */
  summary: string;
  before?: string;
  after?: string;
}

export interface InstallOpts {
  /** Absolute path to the hook entry (dist/hook.mjs copied to ~/.coding.sh/bin). */
  hookCommand: string;
  scope: "user" | "project";
  projectDir?: string;
  dryRun: boolean;
}

/** How an agent launches the coding.sh MCP server (see mcp/launch.ts). */
export interface McpServerSpec {
  /** Config key, e.g. "coding-sh". */
  name: string;
  command: string;
  args: string[];
}

export interface McpInstallOpts {
  server: McpServerSpec;
  dryRun: boolean;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  binary?: string;
  configDir?: string;
  /** Whether coding.sh hooks/plugin are currently installed into this agent. */
  hooked: boolean;
  notes?: string[];
}

export interface NormalizeContext {
  /** Store large strings as blobs; returns ref. */
  blob(data: string | Uint8Array): Promise<BlobRef>;
  maxInlineBytes: number;
  /** Stable id helper: sha256 of parts joined. */
  id(...parts: (string | number)[]): string;
  /** Spool file + byte offset of the line being normalized, for stable fallback ids. */
  source?: { file: string; offset: number };
}

/** A source file a backfill reads (one transcript, rollout, …). */
export interface BackfillFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface BackfillOpts {
  /** Only events at or after this time (ms epoch). */
  since?: number;
  /**
   * File-based backfills call this before reading each source file, and skip
   * the file when it resolves false (unchanged since the last backfill). A
   * file's events must all be yielded before the next file is asked about.
   * Adapters that never call it are re-read in full on every run.
   */
  changed?(file: BackfillFile): Promise<boolean>;
}

export interface RunSpec {
  /** Prepared working directory (task snapshot + harness overlay applied). */
  cwd: string;
  instruction: string;
  model?: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Extra CLI flags from the harness bundle. */
  flags: string[];
  runId: string;
}

export interface AgentRunOutput {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Session id the agent reported, when known. */
  sessionId?: string;
  usage?: Usage;
  stdoutTail: string;
  stderrTail: string;
}

export interface Adapter {
  id: AgentId;
  displayName: string;
  /** "A" hooks+transcript+headless, "B" transcript+headless, "C" wrapper only. */
  tier: "A" | "B" | "C";
  /**
   * Version of what normalize/backfill produce (default 1). Bump it whenever a
   * change alters the rows stored for the same input (ids, kinds, payloads,
   * dedupe): sessions stored by an older version are then re-parsed from their
   * transcript or spool on the next background ingest (core/reparse.ts).
   */
  parseVersion?: number;
  detect(): Promise<DetectResult>;
  install(opts: InstallOpts): Promise<FileChange[]>;
  uninstall(opts: Omit<InstallOpts, "hookCommand">): Promise<FileChange[]>;
  /**
   * Register the coding.sh MCP server in the agent's user config (agents with
   * MCP support). Every edited file is backed up first.
   */
  installMcp?(opts: McpInstallOpts): Promise<FileChange[]>;
  /**
   * Remove it again. A file untouched since install is restored byte-for-byte;
   * otherwise only the coding.sh entry is removed.
   */
  uninstallMcp?(opts: { name: string; dryRun: boolean }): Promise<FileChange[]>;
  /** Pure-ish: spool line → events. Fixture-tested. */
  normalize(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]>;
  /** Import historical sessions from the agent's local transcripts. */
  backfill?(ctx: NormalizeContext, opts?: BackfillOpts): AsyncIterable<AgentEvent>;
  /**
   * Run backfill on every lazy ingest too (CLI reads, the hook's background
   * ingest), for agents whose store is the only capture path (T3 Code). Its
   * backfill must be cheap when nothing changed (BackfillOpts.changed).
   * Returns false when there is nothing to read (skips the backfill pass).
   */
  tail?(): boolean;
  /**
   * Like tail, but only while the installed hooks cannot fire (Codex skips
   * hooks until the user trusts them in /hooks): returns the earliest time to
   * import from (the hook install, so history stays an explicit
   * `ingest --backfill`), or false when live hooks capture. Must be cheap: it
   * runs on every lazy ingest.
   */
  tailWhenUnhooked?(): { since?: number } | false;
  /** Headless driver for eval runs. */
  run?(spec: RunSpec): Promise<AgentRunOutput>;
  /** Files in a repo/home that make up this agent's harness (for bundle snapshots). */
  harnessFiles?(): { project: string[]; user: string[] };
  /**
   * Prepare an isolated config env for a run so the user's global config is untouched.
   * `runDir` is the repo work dir the agent runs in (project-level harness files go here).
   * `ctx.runRoot` is the per-run scratch dir outside the work dir; `ctx.home` is a fresh
   * per-run home/config root for user-level harness files (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME).
   */
  overlay?(
    bundle: HarnessBundle,
    runDir: string,
    ctx?: { workDir: string; runRoot: string; home: string },
  ): Promise<{ env: Record<string, string>; flags: string[] }>;
}

// ---------------------------------------------------------------- evals

export interface VerifierSpec {
  /** Shell command run in the task dir after the agent finishes. Exit 0 = pass. */
  command: string;
  /** Files (relative path → blob ref) copied in only at verify time, hidden from the agent. */
  hiddenFiles: Record<string, BlobRef>;
  timeoutMs: number;
}

export interface ValidationReport {
  noopFails: boolean;
  referencePasses: { passed: number; of: number };
  nearMissesFail: { failed: number; of: number };
  leakage: string[]; // human-readable leakage findings; empty = clean
  /** Names of near-miss patches that wrongly passed the verifier. */
  nearMissesPassed?: string[];
  /** Errors from validation steps (setup failed, verifier crashed, …). */
  errors?: string[];
  /**
   * Impossible variants (ImpossibleBench): one expected value in a test file is flipped so the
   * tests contradict the instruction. The reference must fail at least one; if it passes every
   * variant tried, the verifier does not check what its tests assert and is `gameable`.
   * Absent when no variant could be built or the reference never passed the real verifier.
   */
  impossible?: {
    gameable: boolean;
    tried: number;
    /** Labels of the variants the reference wrongly passed. */
    passedByReference: string[];
    /** The first variant the reference failed. */
    variant?: {
      label: string;
      /** The no-op attempt also fails it; only then is the variant stored for cheat-rate runs. */
      noopFails: boolean;
      /** Full hidden-file map for the variant (instruction unchanged); set when noopFails. */
      hiddenFiles?: Record<string, BlobRef>;
    };
  };
  /**
   * Pass-to-pass: the repo's pre-existing suite run before and after the reference patch.
   * Every test that passed before must still pass. Absent when no suite command is known.
   */
  passToPass?: {
    command: string;
    passed: number;
    of: number;
    /** Tests that passed before and fail or no longer run after. */
    broken: string[];
    /** "tests" when per-test results were parsed, "exit" when only exit statuses were compared. */
    granularity: "tests" | "exit";
  };
  ok: boolean;
  ts: number;
}

export interface EvalTask {
  id: string;
  name: string;
  status: "draft" | "validated" | "archived";
  sourceSessionId?: string;
  /** Shadow-repo snapshot to start from (pre-agent state). */
  start: { repoRoot: string; snapshot: string; head: string };
  instruction: string;
  setup: string[];
  verifier: VerifierSpec;
  /** Reference solution as a patch blob (from the session end state or a later human fix). */
  referencePatch?: BlobRef;
  nearMissPatches?: BlobRef[];
  validation?: ValidationReport;
  tags: string[];
  createdAt: number;
  /** Free-form extras (e.g. follow-up prompts from the source session). Stores must round-trip it. */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------- harness

export interface HarnessBundle {
  /** sha256 over manifest + files. */
  id: string;
  name: string;
  agent: AgentId;
  model?: string;
  flags: string[];
  env: Record<string, string>;
  /** Relative path in repo (or "~/…" for user-level) → blob ref. */
  files: Record<string, BlobRef>;
  /** Paths the overlay removes (e.g. to test "no CLAUDE.md"). */
  remove: string[];
  createdAt: number;
  note?: string;
}

/**
 * One test-tamper finding from the agent's diff (ImpossibleBench / EvilGenie:
 * agents edit, delete or skip tests to pass).
 * - edit / delete: a pre-existing test, runner-config, CI or verifier file changed or vanished.
 * - create: a new file at a verifier hidden-file path, or a new runner-config / CI file.
 * - skip: an added skip / only / xfail marker in a test-ish file.
 * - script: a changed `test` script line in a pre-existing package.json.
 */
export interface TamperFlag {
  kind: "edit" | "delete" | "create" | "skip" | "script";
  path: string;
  /** Why the path counts as a test file. */
  why: "hidden" | "verifier" | "runner-config" | "ci" | "test-glob" | "package-json";
  /** Line counts or the offending line, clipped. */
  detail?: string;
}

export interface TamperReport {
  flagged: boolean;
  flags: TamperFlag[];
}

export interface RunResult {
  id: string;
  experimentId?: string;
  taskId: string;
  bundleId: string;
  attempt: number;
  sessionId?: string;
  pass: boolean;
  verifierExit: number | null;
  agent: AgentRunOutput;
  diffBlob?: BlobRef;
  startedAt: number;
  endedAt: number;
  error?: string;
  /** Test-tamper check of the agent's diff. Absent when no diff was taken (older runs, setup failure). */
  tamper?: TamperReport;
  /**
   * The run was interrupted (Ctrl-C, SIGTERM) before it finished: the agent or
   * verifier was killed, so `pass` says nothing about the harness. Comparisons
   * leave cancelled runs out.
   */
  cancelled?: true;
  /** Tool-eval trials: the tap log (tool calls seen on the wire) as NDJSON. Referenced so blob gc keeps it. */
  tapBlob?: BlobRef;
}

export type { AgentEvent, AgentId, BlobRef, RepoState, Session, Usage };
