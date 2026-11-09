// eve eval runs → coding.sh datasets and experiments.
//
// `eve eval` runs `evals/*.eval.ts` files against an eve agent and hands each
// result to its reporters (eve/evals/reporters: onRunStart, onEvalComplete,
// onRunComplete). codingShReporter (reporter.ts) sends the run here as one
// JSON upload; `eveEvalsToExperiment` turns it into:
//
//   - a dataset version: one case per eval id, input {eval, description},
//     the eval's tags and metadata. Versions are content hashes, so the same
//     evals map to the same version and a new or changed eval makes a new one.
//   - an experiment: one CaseRun per eval result (attempt = trial), its grades
//     from eve's assertions. Grader ids follow eve's own reporters
//     (`gate:<key|name>` for gates, `<key|name>` for soft scores), grouped
//     per eval with the lowest score, like eve's Braintrust reporter. A run
//     passes when eve's verdict is "passed"; "scored" (a soft threshold
//     missed) and "failed" do not. Skipped evals stay cases with no run.
//
// The receiver route (`POST /v1/evals/eve` on `coding.sh collector` and
// `coding.sh serve`) redacts the upload before storing it, and a re-sent run
// (same run key) returns the stored experiment instead of adding another.
//
// Types here are structural copies of eve 1.0.0-rc.6's eval types
// (eve/dist/src/evals/types.d.ts): coding.sh never imports eve.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sortableId } from "../../core/ids.ts";
import { createRedactor, type Redactor } from "../../core/redact.ts";
import { datasetVersion, slugify } from "../../datasets/dataset.ts";
import { shortHash } from "../../datasets/hash.ts";
import type { FileEvalStore } from "../../datasets/store.ts";
import type { Case, CaseRun, Dataset, ExperimentResult, GraderInfo, GraderOutcome } from "../../datasets/types.ts";
import { summarizeRuns } from "../../experiments/run.ts";
import { decompress, hostOf, isLoopbackHost, readBody } from "../../otel/receiver.ts";
import { clip, EVE_EVALS_UPLOAD_VERSION, isObj, num, str, type EveAssertion, type EveEvalInfo, type EveEvalResultUpload, type EveEvalsUpload, type EveVerdict, type StoredEveRun } from "./upload.ts";

export { compactEveResult, EVE_EVALS_PATH, EVE_EVALS_UPLOAD_VERSION, type EveAssertion, type EveEvalInfo, type EveEvalResultLike, type EveEvalResultUpload, type EveEvalsUpload, type EveVerdict, type StoredEveRun } from "./upload.ts";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------- validation

export class EveEvalsError extends Error {}

function assertion(v: unknown, where: string): EveAssertion {
  if (!isObj(v) || typeof v.name !== "string" || (v.severity !== "gate" && v.severity !== "soft")) throw new EveEvalsError(`${where}: expected {name, severity: "gate"|"soft", errored}`);
  const a: EveAssertion = { name: v.name, severity: v.severity, errored: v.errored === true };
  if (str(v.key)) a.key = v.key as string;
  if (num(v.score) !== undefined) a.score = v.score as number;
  if (num(v.threshold) !== undefined) a.threshold = v.threshold as number;
  if (typeof v.passed === "boolean") a.passed = v.passed;
  if (str(v.message)) a.message = v.message as string;
  if (isObj(v.metadata)) a.metadata = v.metadata;
  return a;
}

const VERDICTS: readonly EveVerdict[] = ["passed", "failed", "scored", "skipped"];
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** Validate an upload (throws EveEvalsError naming the first bad field). */
export function parseEveEvalsUpload(body: unknown): EveEvalsUpload {
  if (!isObj(body)) throw new EveEvalsError("expected a JSON object");
  if (body.source !== "eve") throw new EveEvalsError('source must be "eve"');
  if (body.v !== EVE_EVALS_UPLOAD_VERSION) throw new EveEvalsError(`unsupported upload version ${JSON.stringify(body.v)} (this coding.sh reads v${EVE_EVALS_UPLOAD_VERSION})`);
  if (!Array.isArray(body.results)) throw new EveEvalsError("results must be an array");
  const time = (v: unknown, where: string): string => {
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new EveEvalsError(`${where} must be an ISO time`);
    return v;
  };
  const results = body.results.map((r, i): EveEvalResultUpload => {
    const where = `results[${i}]`;
    if (!isObj(r) || !str(r.id)) throw new EveEvalsError(`${where}.id must be a string`);
    if (!VERDICTS.includes(r.verdict as EveVerdict)) throw new EveEvalsError(`${where}.verdict must be one of ${VERDICTS.join(", ")}`);
    if (!Array.isArray(r.assertions)) throw new EveEvalsError(`${where}.assertions must be an array`);
    const out: EveEvalResultUpload = {
      id: r.id as string,
      verdict: r.verdict as EveVerdict,
      startedAt: time(r.startedAt, `${where}.startedAt`),
      completedAt: time(r.completedAt, `${where}.completedAt`),
      assertions: r.assertions.map((a, j) => assertion(a, `${where}.assertions[${j}]`)),
    };
    const attempt = num(r.attempt);
    if (attempt !== undefined) {
      if (!Number.isInteger(attempt) || attempt < 1) throw new EveEvalsError(`${where}.attempt must be a positive integer`);
      out.attempt = attempt;
    }
    for (const k of ["error", "skipReason", "sessionId", "status"] as const) if (str(r[k])) out[k] = r[k] as string;
    for (const k of ["traceIds", "toolCalls", "subagentCalls", "models"] as const) {
      const xs = strings(r[k]);
      if (xs?.length) out[k] = xs;
    }
    for (const k of ["costUsd", "inputTokens", "outputTokens"] as const) if (num(r[k]) !== undefined) out[k] = r[k] as number;
    if (r.output !== undefined && r.output !== null) out.output = clip(r.output);
    return out;
  });
  const evals = (Array.isArray(body.evals) ? body.evals : []).map((e, i): EveEvalInfo => {
    if (!isObj(e) || !str(e.id)) throw new EveEvalsError(`evals[${i}].id must be a string`);
    const info: EveEvalInfo = { id: e.id as string };
    if (str(e.description)) info.description = e.description as string;
    const tags = strings(e.tags);
    if (tags?.length) info.tags = tags;
    if (isObj(e.metadata)) info.metadata = e.metadata;
    return info;
  });
  if (!results.length && !evals.length) throw new EveEvalsError("the run has no evals");
  const up: EveEvalsUpload = {
    v: EVE_EVALS_UPLOAD_VERSION,
    source: "eve",
    startedAt: time(body.startedAt, "startedAt"),
    completedAt: time(body.completedAt, "completedAt"),
    evals,
    results,
  };
  if (str(body.dataset)) up.dataset = (body.dataset as string).trim();
  if (str(body.name)) up.name = (body.name as string).trim();
  if (isObj(body.metadata)) up.metadata = body.metadata;
  if (isObj(body.target)) {
    const t: { kind?: string; url?: string } = {};
    if (str(body.target.kind)) t.kind = body.target.kind as string;
    if (str(body.target.url)) t.url = body.target.url as string;
    up.target = t;
  }
  return up;
}

// ---------------------------------------------------------------- mapping

export const DEFAULT_EVE_DATASET = "eve evals";

/** eve's exported score name: `gate:<key|name>` for a gate, `<key|name>` for a soft score. */
export const eveGraderId = (a: Pick<EveAssertion, "key" | "name" | "severity">): string => `${a.severity === "gate" ? "gate:" : ""}${a.key ?? a.name}`;

/** A URL with any user:password removed. */
function plainUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** Stable key of one run: a re-sent upload has the same key. */
export function eveRunKey(up: EveEvalsUpload): string {
  return shortHash({ dataset: up.dataset ?? null, name: up.name ?? null, target: up.target?.url ?? null, startedAt: up.startedAt, results: up.results.map((r) => [r.id, r.attempt ?? 1, r.startedAt]) }, 24);
}

function caseOf(info: EveEvalInfo): Case {
  const input: Record<string, unknown> = { eval: info.id };
  if (info.description) input.description = info.description;
  const c: Case = { id: info.id, input };
  if (info.tags?.length) c.tags = [...new Set(info.tags)];
  if (info.metadata && Object.keys(info.metadata).length) c.metadata = { eve: { ...info.metadata } };
  return c;
}

function gradesOf(assertions: readonly EveAssertion[]): { grades: GraderOutcome[]; kinds: Map<string, string> } {
  const groups = new Map<string, EveAssertion[]>();
  for (const a of assertions) {
    const id = eveGraderId(a);
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(a);
  }
  const kinds = new Map<string, string>();
  const grades: GraderOutcome[] = [];
  for (const [graderId, as] of groups) {
    kinds.set(graderId, as[0]!.severity === "gate" ? "eve-gate" : "eve-score");
    const failed = as.filter((a) => a.errored || a.passed === false);
    const reason = failed.map((a) => a.message ?? a.name).join("; ") || undefined;
    const scores = as.map((a) => a.score).filter((s): s is number => s !== undefined);
    if (as.some((a) => a.errored) && !scores.length) {
      grades.push({ graderId, error: reason ?? "assertion errored" });
      continue;
    }
    // A score with no rule has no verdict and cannot fail the eval: it passes.
    const result = { score: scores.length ? Math.min(...scores) : 0, pass: failed.length === 0, ...(reason ? { reason } : {}) };
    grades.push({ graderId, result });
  }
  return { grades, kinds };
}

/** The dataset version and experiment one eve run makes. Pure: nothing is stored. */
export function eveEvalsToExperiment(up: EveEvalsUpload, opts: { id?: string; now?: number } = {}): { dataset: Dataset; experiment: ExperimentResult } {
  const name = up.dataset || DEFAULT_EVE_DATASET;
  const infos = new Map<string, EveEvalInfo>();
  for (const e of up.evals) if (!infos.has(e.id)) infos.set(e.id, e);
  for (const r of up.results) if (!infos.has(r.id)) infos.set(r.id, { id: r.id });
  const cases = [...infos.values()].map(caseOf);
  const dataset: Dataset = { id: slugify(name), name, version: datasetVersion(cases), cases, description: "eve evals (evals/*.eval.ts), sent by codingShReporter" };

  const graders = new Map<string, GraderInfo>();
  const runs: CaseRun[] = [];
  const skipped: { id: string; reason?: string }[] = [];
  for (const r of up.results) {
    if (r.verdict === "skipped") {
      skipped.push({ id: r.id, ...(r.skipReason ? { reason: r.skipReason } : {}) });
      continue;
    }
    const { grades, kinds } = gradesOf(r.assertions);
    for (const [id, kind] of kinds) if (!graders.has(id)) graders.set(id, { id, kind, version: shortHash({ eve: id, kind }, 12) });
    const output: Record<string, unknown> = {};
    if (r.output !== undefined) output.output = r.output;
    for (const k of ["sessionId", "status", "traceIds", "toolCalls", "subagentCalls", "models"] as const) if (r[k] !== undefined) output[k] = r[k];
    output.verdict = r.verdict;
    const startedAt = Date.parse(r.startedAt);
    const run: CaseRun = {
      caseId: r.id,
      trial: r.attempt ?? 1,
      output,
      latencyMs: Math.max(0, Date.parse(r.completedAt) - startedAt),
      grades,
      pass: r.verdict === "passed",
      startedAt,
    };
    if (r.error) run.error = r.error;
    if (r.costUsd !== undefined) run.costUsd = r.costUsd;
    runs.push(run);
  }
  const graderList = [...graders.values()];
  const trials = Math.max(1, ...up.results.map((r) => r.attempt ?? 1));
  const count = (v: EveVerdict) => up.results.filter((r) => r.verdict === v).length;
  const metadata: Record<string, unknown> = {
    ...up.metadata,
    source: "eve",
    eveRunKey: eveRunKey(up),
    eve: { passed: count("passed"), failed: count("failed"), scored: count("scored"), skipped: count("skipped"), errored: up.results.filter((r) => r.verdict === "failed" && r.error).length },
  };
  if (skipped.length) metadata.skipped = skipped;
  if (up.target?.url) metadata.target = { ...(up.target.kind ? { kind: up.target.kind } : {}), url: plainUrl(up.target.url) };
  const experiment: ExperimentResult = {
    id: opts.id ?? sortableId("exp_", opts.now),
    name: up.name || name,
    status: "completed",
    dataset: { id: dataset.id, name: dataset.name, version: dataset.version },
    task: { kind: "http", ref: up.target?.url ? `eve eval (${up.target.kind ?? "remote"}) ${plainUrl(up.target.url)}` : "eve eval" },
    graders: graderList,
    trials,
    createdAt: Date.parse(up.startedAt),
    finishedAt: Date.parse(up.completedAt),
    runs,
    summary: summarizeRuns(runs, graderList, trials),
    metadata,
  };
  return { dataset, experiment };
}

// ---------------------------------------------------------------- storing


/**
 * Redact, then store the dataset version and the experiment. A run already
 * stored (same run key, among the dataset's newest 200 experiments) is
 * returned as is, with created: false.
 */
export async function storeEveEvals(up: EveEvalsUpload, store: FileEvalStore, opts: { redactor?: Redactor; now?: number } = {}): Promise<StoredEveRun> {
  const redactor = opts.redactor ?? createRedactor();
  const { dataset, experiment } = eveEvalsToExperiment(redactor.value(up), opts.now !== undefined ? { now: opts.now } : {});
  const key = experiment.metadata!.eveRunKey;
  const prior = (await store.listExperiments({ datasetId: dataset.id, limit: 200 })).find((e) => e.metadata?.eveRunKey === key);
  const put = await store.putDataset(dataset, { note: "eve eval", ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const exp = prior ?? experiment;
  if (!prior) await store.putExperiment(experiment);
  const rate = exp.summary.passRate.p;
  return {
    dataset: { id: dataset.id, name: dataset.name, version: put.version, created: put.created, cases: dataset.cases.length },
    experiment: { id: exp.id, name: exp.name, created: !prior, n: exp.summary.n, passed: exp.summary.passed, passRate: Number.isFinite(rate) ? rate : null },
  };
}

// ---------------------------------------------------------------- HTTP route

export interface EveEvalsHandlerOptions {
  store: FileEvalStore;
  redactor?: Redactor;
  /** Answer non-loopback Host headers (serve with keys). Default false. */
  allowRemote?: boolean;
  /** Returns false to answer 401 (serve: an ingest key). Default: everyone. */
  authorize?: (req: IncomingMessage) => boolean;
  /** Refuse writes, e.g. a read replica or a standby. Return the reason. */
  unavailable?: () => string | undefined;
  onStored?: (r: StoredEveRun) => void;
  onError?: (err: Error) => void;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(buf.byteLength), "Cache-Control": "no-store", ...headers });
  res.end(buf);
}

/** `POST /v1/evals/eve`: one eve run as JSON → 201 {dataset, experiment} (200 when already stored). */
export function createEveEvalsHandler(o: EveEvalsHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const fail = (status: number, error: string, headers: Record<string, string> = {}) => {
      req.resume();
      send(res, status, { error, status }, headers);
    };
    try {
      // A browser page can't post here: no CORS, and a loopback server answers only loopback names.
      if (!o.allowRemote && !isLoopbackHost(hostOf(req.headers.host ?? ""))) return fail(403, "Host header is not a loopback address");
      if (req.headers.origin !== undefined) return fail(403, "browser requests are not accepted");
      if (req.method !== "POST") return fail(405, "use POST", { Allow: "POST" });
      if (o.authorize && !o.authorize(req)) return fail(401, "missing or invalid ingest key; send Authorization: Bearer <key>", { "WWW-Authenticate": "Bearer" });
      const why = o.unavailable?.();
      if (why) return fail(503, why);
      const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json") return fail(415, "Content-Type must be application/json");
      const raw = await readBody(req, MAX_BODY_BYTES);
      const body = await decompress(raw, req.headers["content-encoding"], MAX_BODY_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return send(res, 400, { error: "body is not valid JSON", status: 400 });
      }
      let up: EveEvalsUpload;
      try {
        up = parseEveEvalsUpload(parsed);
      } catch (e) {
        if (e instanceof EveEvalsError) return send(res, 400, { error: e.message, status: 400 });
        throw e;
      }
      const stored = await storeEveEvals(up, o.store, o.redactor ? { redactor: o.redactor } : {});
      try {
        o.onStored?.(stored);
      } catch {
        // a logging hook never fails the request
      }
      send(res, stored.experiment.created ? 201 : 200, stored);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (typeof err.status === "number" && err.status >= 400 && err.status < 500) return fail(err.status, err.message);
      try {
        o.onError?.(err);
      } catch {
        // ignore
      }
      if (res.headersSent) res.destroy();
      else send(res, 500, { error: `could not store the eve run: ${err.message}`, status: 500 });
    }
  };
}
