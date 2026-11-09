// The upload codingShReporter sends for one `eve eval` run, and the reply.
// No imports: the reporter (and the `coding.sh/eve` bundle) stays small.
// Types are structural copies of eve 1.0.0-rc.6's eval types
// (eve/dist/src/evals/types.d.ts); coding.sh never imports eve.

/** Path the reporter posts to, on the collector and on serve. */
export const EVE_EVALS_PATH = "/v1/evals/eve";
/** Upload format version. */
export const EVE_EVALS_UPLOAD_VERSION = 1;
/** Longest output kept per run: eve's own artifacts hold the rest. */
const MAX_OUTPUT_CHARS = 8000;

// ---------------------------------------------------------------- eve shapes

/** eve's AssertionResult: one recorded assertion or `t.score`. */
export interface EveAssertion {
  name: string;
  key?: string;
  score?: number;
  severity: "gate" | "soft";
  threshold?: number;
  passed?: boolean;
  errored: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
}

export type EveVerdict = "passed" | "failed" | "scored" | "skipped";

/** The parts of eve's EveEval a dataset case needs. */
export interface EveEvalInfo {
  id: string;
  description?: string;
  tags?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

/** The parts of eve's EveEvalResult (with its task result) the reporter reads. */
export interface EveEvalResultLike {
  id: string;
  attempt?: number;
  verdict: EveVerdict;
  error?: string;
  skipReason?: string;
  startedAt: string;
  completedAt: string;
  assertions: readonly EveAssertion[];
  result?: {
    reply?: string;
    data?: unknown;
    sessionId?: string;
    status?: string;
    error?: { code?: string; message?: string };
    derived?: {
      toolCalls?: readonly { name: string }[];
      subagentCalls?: readonly { name: string }[];
      models?: readonly string[];
      usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; [k: string]: unknown };
      failureCode?: string;
    };
    traceContexts?: readonly { traceId: string; sessionId?: string; primary?: boolean }[];
  };
}

/** One eval result as uploaded: small, no event streams. */
export interface EveEvalResultUpload {
  id: string;
  attempt?: number;
  verdict: EveVerdict;
  error?: string;
  skipReason?: string;
  startedAt: string;
  completedAt: string;
  assertions: EveAssertion[];
  /** eve's outputOf(result): structured data, else the reply text. */
  output?: unknown;
  /** The primary eve session id (an OTel-captured run has the same coding.sh session id). */
  sessionId?: string;
  status?: string;
  traceIds?: string[];
  toolCalls?: string[];
  subagentCalls?: string[];
  models?: string[];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface EveEvalsUpload {
  v: number;
  source: "eve";
  /** Dataset name (default "eve evals"). */
  dataset?: string;
  /** Experiment name (default: the dataset name). */
  name?: string;
  metadata?: Record<string, unknown>;
  target?: { kind?: string; url?: string };
  startedAt: string;
  completedAt: string;
  evals: EveEvalInfo[];
  results: EveEvalResultUpload[];
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function clip(v: unknown): unknown {
  if (v === undefined || v === null) return v ?? undefined;
  if (typeof v === "string") return v.length > MAX_OUTPUT_CHARS ? `${v.slice(0, MAX_OUTPUT_CHARS)}…` : v;
  const s = JSON.stringify(v);
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}…` : v;
}

/** eve's result reduced to what coding.sh stores (no event streams, no session views). */
export function compactEveResult(r: EveEvalResultLike): EveEvalResultUpload {
  const t = r.result;
  const d = t?.derived;
  const out: EveEvalResultUpload = {
    id: r.id,
    verdict: r.verdict,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    assertions: r.assertions.map((a) => ({ ...a })),
  };
  const set = <K extends keyof EveEvalResultUpload>(k: K, v: EveEvalResultUpload[K] | undefined) => {
    if (v !== undefined && !(Array.isArray(v) && !v.length)) out[k] = v;
  };
  set("attempt", num(r.attempt));
  set("error", str(r.error) ?? str(t?.error?.message));
  set("skipReason", str(r.skipReason));
  // eve's outputOf: data when the turn produced structured output, else the reply.
  set("output", t ? clip(t.data !== undefined ? t.data : (t.reply ?? undefined)) : undefined);
  set("sessionId", str(t?.sessionId));
  set("status", str(t?.status));
  set("traceIds", t?.traceContexts ? [...new Set(t.traceContexts.map((c) => c.traceId).filter(Boolean))] : undefined);
  set("toolCalls", d?.toolCalls?.map((c) => c.name));
  set("subagentCalls", d?.subagentCalls?.map((c) => c.name));
  set("models", d?.models ? [...d.models] : undefined);
  set("costUsd", num(d?.usage?.costUsd));
  set("inputTokens", num(d?.usage?.inputTokens));
  set("outputTokens", num(d?.usage?.outputTokens));
  return out;
}

export interface StoredEveRun {
  dataset: { id: string; name: string; version: string; created: boolean; cases: number };
  experiment: { id: string; name: string; created: boolean; n: number; passed: number; passRate: number | null };
}
