// Contracts for dynamic benchmarks (`coding.sh bench`). A benchmark is one
// TOML file: a source that yields fresh cases on every run, sampling rules,
// two or more contenders, and graders. Each run freezes its sample as a
// dataset version, runs every contender on exactly that set in a randomized
// interleaved order, and stores one BenchRun record that holds everything a
// report needs (so reports can be rebuilt and published from records alone).
import type { CommandTask, HttpTask } from "../experiments/task.ts";
import type { GraderSpec } from "../graders/index.ts";

// ---------------------------------------------------------------- definition

export interface CommandSource {
  kind: "command";
  /** Command line or program; stdout is JSONL cases. */
  command: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface SessionsSource {
  kind: "sessions";
  /** Window: 7d, 24h, … Default 7d. */
  since?: string;
  /** failed (tool errors, failing tests or a failure flag; default), flagged (a failure flag) or any. */
  select?: "failed" | "flagged" | "any";
  agent?: string;
  /** Scan at most this many sessions. Default 500. */
  limit?: number;
}

export interface GithubSource {
  kind: "github";
  /** owner/name */
  repo: string;
  /** issues (default), prs, or both. */
  type?: "issues" | "prs" | "both";
  state?: "open" | "closed" | "all";
  /** Only items created in this window (filtered on created_at, not updated_at). Default 7d. */
  since?: string;
  labels?: string[];
  /** Fetch at most this many items. Default 200. */
  limit?: number;
  /** Env var holding the token. Default GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`. */
  tokenEnv?: string;
  /** API base (GitHub Enterprise or tests). Default https://api.github.com. */
  apiUrl?: string;
}

export interface UrlsSource {
  kind: "urls";
  /** Sitemap or sitemap index URL(s). */
  sitemap?: string | string[];
  /** File with one URL per line (relative to the definition file). */
  file?: string;
  urls?: string[];
  /** Keep URLs matching this regex. */
  include?: string;
  exclude?: string;
  /** Only sitemap entries with lastmod in this window, e.g. 7d. */
  since?: string;
  /** Read at most this many URLs (picked by seed, not file order). Default 50000. */
  limit?: number;
  /** Fetch each sampled page once at freeze and hash its body into the frozen set. Default true. */
  snapshot?: boolean;
}

export interface DatasetSource {
  kind: "dataset";
  dataset: string;
  version?: string;
  split?: "train" | "dev" | "test";
}

export type SourceSpec = CommandSource | SessionsSource | GithubSource | UrlsSource | DatasetSource;
export const SOURCE_KINDS = ["command", "sessions", "github", "urls", "dataset"] as const;

export interface AgentContender {
  kind: "agent";
  /** Adapter id, e.g. claude-code or codex. */
  agent: string;
  model?: string;
  /** Harness bundle id or name (coding.sh harness snapshot). */
  harness?: string;
  /** Prompt template; {{input}} is the case input (JSON when not a string), {{metadata.x}} a metadata field. */
  prompt?: string;
  flags?: string[];
}

export type ContenderTask = (Omit<CommandTask, "kind"> & { kind: "command" }) | (Omit<HttpTask, "kind" | "fetch" | "env"> & { kind: "http" }) | AgentContender;

export type ContenderSpec = ContenderTask & {
  name: string;
  /** Fixed price per call in USD, used when the contender reports no cost (published per-call pricing). */
  costPerRun?: number;
  /** Version label recorded with every run (command and HTTP contenders; agents are detected). */
  version?: string;
};

export type Visibility = "public" | "private";

/**
 * A fixed set of cases rerun next to the fresh sample every run, so a moving
 * score can be told apart from moving cases. Picked once from the source
 * (seeded by name and version) and carried from run record to run record.
 * Bump `version` to pick a new set.
 */
export interface AnchorSpec {
  cases: number;
  version: string;
}

export interface BenchDef {
  name: string;
  description?: string;
  /** Cases per run. Default 50. */
  cases: number;
  /**
   * "date" (default): name + UTC run date. "run": the run id (fresh every run).
   * "secret": name + date + a salt derived from the key in `seedKeyEnv`; each run
   * reveals its salt and publishes the hash of the next day's (commit-reveal).
   * Anything else: fixed.
   */
  seed: string;
  /** Env var holding the commit-reveal key when seed = "secret". Default CODING_SH_BENCH_SEED_KEY. */
  seedKeyEnv?: string;
  anchor?: AnchorSpec;
  /** Counted runs pooled for the window estimate of each gap (declared up front, not chosen after looking). Default 28. */
  window: number;
  /** Skip cases whose dedupe key appeared in an earlier run. Default true. */
  fresh: boolean;
  /** Case field holding the dedupe key, e.g. metadata.url. Default: the case id (a content hash). */
  dedupeBy?: string;
  /** Case field to balance the sample over, e.g. metadata.category. */
  stratify?: string;
  trials: number;
  concurrency: number;
  /** One time limit for every call of every contender. Default 300000 (5 min). */
  timeoutMs: number;
  /** Retries after an error (crash, timeout, HTTP error), the same for every contender. Default 0. */
  retries: number;
  /** Spending cap per run in USD; the run refuses to start above it and stops at it. */
  budgetUsd?: number;
  /** At most this many sampled cases per metadata.host / metadata.org. */
  maxPerHost?: number;
  maxPerOrg?: number;
  /** Whether case contents may appear in published reports. Default: public for github and urls, private otherwise. */
  visibility: Visibility;
  /** Contender the paired history is measured against. Default: the first contender. */
  reference: string;
  source: SourceSpec;
  contenders: ContenderSpec[];
  graders: GraderSpec[];
  /** Where the file lives. */
  file: string;
  /** Relative paths and commands resolve here: the project root for ./bench/<name>.toml, else the file's folder. */
  baseDir: string;
  /** sha256 of the file's canonical content (definition identity, recorded per run). */
  hash: string;
  /** sha256 of everything except the contender list: sampling, source, graders, limits. History breaks when it changes. */
  protocolHash: string;
  /** sha256 of each contender's table, so adding a contender leaves the others' history intact. */
  contenderHashes: Record<string, string>;
}

// ---------------------------------------------------------------- results

export type FailureMode = "timeout" | "http-error" | "crash" | "empty" | "wrong" | "grader-error" | "error" | (string & {});

/**
 * Why a cell doesn't count. An excluded case is dropped for every contender
 * (so the comparison stays paired): quota, auth and rate-limit answers
 * (HTTP 401/402/429), a grader that failed twice, or a call that never ran.
 * Timeouts and crashes are not excluded; they are the contender's failures.
 */
export type ExcludeReason = "quota" | "grader-error" | "aborted" | "budget";

export interface Cell {
  caseId: string;
  contender: string;
  trial: number;
  /** Position in the run's global execution order (0-based). */
  position: number;
  pass: boolean;
  /** Mean grader score 0..1 (1/0 when there are no graders). */
  score: number;
  latencyMs: number;
  costUsd?: number;
  /** Where costUsd came from: the contender reported it, costPerRun in the definition, or the price table (tokens × model price). Absent when unknown. */
  costSource?: CostSource;
  /** Total tokens (in + out when only those are known). */
  tokens?: number;
  /** Token counts as reported, kept so cost can be recomputed when prices change. */
  usage?: TokenUsage;
  failure?: FailureMode;
  error?: string;
  /** The case is dropped for every contender; see ExcludeReason. */
  excluded?: ExcludeReason;
  /** Calls made (1 + retries used). */
  attempts?: number;
  sessionId?: string;
  /** Clipped output preview (redacted). */
  output?: string;
  /** sha256 of the full stored output (redacted JSON), kept under <bench>/blobs for `bench regrade`. */
  outputSha256?: string;
  /** Model the contender reported for this call. */
  model?: string;
  grades?: { grader: string; score: number; pass: boolean; reason?: string }[];
}

export type CostSource = "reported" | "configured" | "price-table";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Dist {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ContenderSummary {
  contender: string;
  kind: string;
  ref: string;
  experimentId?: string;
  n: number;
  passed: number;
  passRate: { p: number; lo: number; hi: number };
  /** Wilson with one trial per case; with several trials, a bootstrap that resamples cases (trials of a case move together). */
  ciMethod: "wilson" | "cluster-bootstrap";
  meanScore: number;
  latencyMs: Dist;
  costUsd: { total: number; perRun: number; perThousandPasses: number; known: number; sources: Partial<Record<CostSource | "unknown", number>> };
  tokens: { total: number; mean: number; known: number };
  tokensIn: { total: number; mean: number; known: number };
  tokensOut: { total: number; mean: number; known: number };
  errors: number;
  failures: Record<string, number>;
  /** 1-based place; contenders that don't differ significantly from the place leader share it. */
  place: number;
}

export interface PairComparison {
  a: string;
  b: string;
  paired: number;
  /** Leader first: a passed at least as often as b. */
  /** Mean per-case pass-rate difference a − b with a paired bootstrap 95% CI (not adjusted for multiple pairs). */
  diff: { mean: number; lo: number; hi: number };
  /** Exact McNemar on per-case outcomes: aOnly = a pass, b fail; bOnly = a fail, b pass. */
  aOnly: number;
  bOnly: number;
  p: number;
  /** Holm-adjusted across all pairs in the run. */
  pAdj: number;
  verdict: "a" | "b" | "tie";
  /** Paired latency difference a − b (ms) over cases both answered, with a bootstrap CI. */
  latencyDiffMs?: { mean: number; lo: number; hi: number; n: number };
  /** Geometric mean of per-case a/b ratios (latency over cases both answered; cost over cases both priced). */
  latencyRatio?: number;
  costRatio?: number;
  /** Smallest pass-rate gap this many paired cases can detect (80% power, two-sided α 0.05). */
  mde?: number;
  warnings: string[];
}

export interface FrozenCase {
  id: string;
  key: string;
  stratum?: string;
  input: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  sourceSessionId?: string;
  /** When the source item was created (ISO), when the source knows. */
  createdAt?: string;
  /**
   * sha256 of what the case measures, taken at freeze: the page body for a
   * urls snapshot, else the canonical {input, expected}. Goes into the
   * freshness ledger next to the key, so the same content under a new key is
   * not "fresh", and a key whose content changed is flagged.
   */
  contentSha256?: string;
  /** Part of the anchor set, not the fresh sample. */
  anchor?: true;
}

export interface ContenderRecord {
  name: string;
  kind: string;
  ref: string;
  /** sha256 of the contender's definition table. */
  hash?: string;
  /** Configured model, else the one the contender reported. */
  model?: string;
  /** Agent CLI version (detected) or the configured version label. */
  version?: string;
  experimentId?: string;
}

export interface BenchRun {
  v: 1;
  id: string;
  bench: string;
  description?: string;
  /** UTC date the run counts for (YYYY-MM-DD). */
  date: string;
  startedAt: number;
  finishedAt: number;
  /**
   * scheduled: a plain `bench run` and the first complete one for its date;
   * only these feed history and the freshness ledger. adhoc: --seed, --cases,
   * --date, or a rerun of a date that already has a scheduled run.
   */
  mode?: "scheduled" | "adhoc";
  /** incomplete: stopped by the budget or an interrupt; kept for inspection, out of history. */
  status?: "complete" | "incomplete";
  stopReason?: "budget" | "interrupted";
  /** Set on records written by `bench regrade`: the run whose stored outputs were re-scored. */
  regradeOf?: string;
  codingShVersion?: string;
  definition: { file: string; hash: string; protocolHash?: string };
  visibility?: Visibility;
  /** Limits every contender ran under. */
  policy?: { timeoutMs: number; retries: number };
  budget?: { capUsd: number; estimatedUsd?: number; spentUsd: number };
  /** Cases dropped for every contender, by reason. */
  excluded?: { cases: number; ids: string[]; byReason: Record<string, number> };
  /** Cases whose contents matched a secret pattern at freeze and were redacted. */
  redacted?: number;
  seed: string;
  /** seed = "secret": this run's salt (revealed) and its commitment, plus the commitment for the next date. */
  seedCommit?: SeedCommit;
  /** Each `bench run --resume` that continued this record. */
  resumed?: { at: number; calls: number }[];
  /** Fixed anchor set results, kept apart from the fresh sample's numbers. */
  anchor?: AnchorResult;
  /** When some costs came from the price table: when each provider's prices were last checked. */
  pricing?: { updated: Record<string, string> };
  sampling: {
    requested: number;
    candidates: number;
    excludedSeen: number;
    duplicates: number;
    stratify?: string;
    dedupeBy?: string;
    fresh: boolean;
    strata?: Record<string, number>;
    /** Candidates skipped by maxPerHost / maxPerOrg. */
    capped?: number;
    caps?: { field: string; n: number }[];
    /** Candidates skipped because their content hash was already tested (under another key) or repeated in this sample. */
    contentSeen?: number;
  };
  /** urls source: pages fetched at freeze (ok = 2xx). */
  snapshots?: { fetched: number; ok: number };
  source: { kind: string; ref: string };
  /** The frozen sample: dataset id, version (short hash) and full sha256 of the canonical case list. */
  dataset: { id: string; version: string; sha256: string };
  cases: FrozenCase[];
  contenders: ContenderRecord[];
  order: "interleaved-random";
  trials: number;
  graders: { id: string; kind: string; version: string }[];
  cells: Cell[];
  summaries: ContenderSummary[];
  comparisons: PairComparison[];
  warnings: string[];
}

export interface SeedCommit {
  /** The salt, revealed after the run. seed = `<name>:<date>:<salt>`. */
  salt: string;
  /** sha256(salt), published before the run (by the previous run's record and report). */
  commitment: string;
  /** Published now, revealed by the next run. */
  next?: { date: string; commitment: string };
}

export interface AnchorResult {
  version: string;
  /** Anchor cases requested by the definition and in this run. */
  requested: number;
  cases: number;
  /** sha256 of the anchor case list (same recipe as the frozen set). */
  sha256: string;
  /** Run that picked this set. */
  frozenBy: string;
  summaries: ContenderSummary[];
  comparisons: PairComparison[];
  excluded: { cases: number; ids: string[]; byReason: Record<string, number> };
}

export const METRICS = ["pass", "score", "latency", "p95", "cost", "tokens", "tokens-in", "tokens-out", "errors"] as const;
export type Metric = (typeof METRICS)[number];

export interface SeriesPoint {
  date: string;
  run: string;
  value: number | null;
  lo?: number;
  hi?: number;
  n: number;
  /** Increments when the protocol or this contender's definition changed; lines break between segments. */
  segment?: number;
}
