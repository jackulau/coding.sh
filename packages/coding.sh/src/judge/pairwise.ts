// Pairwise judge (EM-14): the judge sees two outputs for the same case and
// picks the better one. LLM judges favor a position (usually the first), so
// every pair is judged twice, once in each order, and a win counts only when
// both orders agree. A pair whose verdict changes with the order is a tie, and
// the share of such pairs is reported as the position-bias rate.
//   Wang et al., "Large Language Models are not Fair Evaluators", 2023,
//   https://arxiv.org/abs/2305.17926 (balanced position calibration: judge
//   both orders, count disagreement as a tie)
//   Jiang et al., "CodeJudgeBench", 2025, https://arxiv.org/abs/2507.10535
//   (pairwise beat pointwise judging on code tasks)
//
// Calibration reuses calibrate(): on cases a human marked decisive, "B is
// better" is the positive class (pass) and "A is better" the negative one; the
// judge's ties are abstentions, left out of κ and counted separately.
import { sha256Hex } from "../core/ids.ts";
import type { CalibrationStatus, Dataset, JudgeVersion, Split } from "../datasets/types.ts";
import type { JudgeCache } from "./cache.ts";
import { calibrate, type CalibrateOpts, type CalibrationReport, type HumanLabel, type JudgedCase } from "./calibrate.ts";
import { extractJson } from "./extract.ts";
import { JudgeParseError, judgeVersionFor } from "./judge.ts";
import { createLimiter } from "./limit.ts";
import { block } from "./prompt.ts";
import type { ChatProvider } from "./providers.ts";

export const PAIRWISE_KIND = "pairwise";

export const PAIRWISE_SYSTEM = `You are a strict, impartial judge comparing two responses to the same task.
Judge ONLY against the rubric. The order of the responses means nothing: do not favor the first or the second.
Do not reward length, confidence, or style the rubric does not ask for. Answer "tie" only when neither is better.
Reply with a single JSON object and nothing else:
{"winner": "1" | "2" | "tie", "reason": "<one or two sentences>"}`;

export const PAIRWISE_TEMPLATE = `Criterion: {{criterion}}

Rubric:
{{rubric}}

{{input}}

{{expected}}

{{response_1}}

{{response_2}}

Which response better meets the rubric: 1, 2, or tie?`;

export const PAIRWISE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { winner: { type: "string", enum: ["1", "2", "tie"] }, reason: { type: "string" } },
  required: ["winner", "reason"],
  additionalProperties: false,
};

/** Which response a single order picked: the one shown first, second, or neither. */
export type Slot = 1 | 2 | "tie";
export type PairWinner = "a" | "b" | "tie";

export interface PairwiseOptions {
  name: string;
  /** What is judged, matching human label criteria. Default: name. */
  criterion?: string;
  rubric: string;
  provider: ChatProvider;
  system?: string;
  /** Template with {{criterion}} {{rubric}} {{input}} {{expected}} {{response_1}} {{response_2}}. */
  template?: string;
  /** Max characters per response, input or expected block. Default 20 000. */
  maxFieldChars?: number;
  status?: JudgeVersion["status"];
  /** Splits used while iterating on the prompt. Default ["train", "dev"]. */
  tunedOn?: Split[];
  calibration?: CalibrationStatus;
  createdAt?: number;
  cache?: JudgeCache;
  /** Max in-flight model calls. Default 4. */
  concurrency?: number;
  /** Extra attempts when the reply has no parseable winner. Default 1. */
  parseRetries?: number;
}

export interface PairContext {
  input: unknown;
  expected?: unknown;
  /** Baseline output. */
  a: unknown;
  /** Candidate output. */
  b: unknown;
  caseId?: string;
  signal?: AbortSignal;
}

export interface PairVerdict {
  /** A or B only when both orders picked it; anything else is a tie. */
  winner: PairWinner;
  /** Each order's pick in A/B terms: [A shown first, B shown first]. */
  orders: [PairWinner, PairWinner];
  /** Both orders gave the same answer. */
  consistent: boolean;
  /** Inconsistent pairs where both orders picked the response in the same position. */
  favored?: "first" | "second";
  reasons: [string | undefined, string | undefined];
  /** Both answers came from the verdict cache. */
  cached: boolean;
}

export interface PairwiseJudge {
  readonly version: JudgeVersion;
  /** One order: which response won when `first` was shown first. */
  ask(ctx: Omit<PairContext, "a" | "b">, first: unknown, second: unknown): Promise<{ slot: Slot; reason?: string; cached: boolean }>;
  /** Both orders, combined. */
  compare(ctx: PairContext): Promise<PairVerdict>;
}

/** Normalize a reply's winner field. Undefined when it names neither response nor a tie. */
export function parseSlot(v: unknown): Slot | undefined {
  if (v === 1 || v === 2) return v;
  if (v === 0) return "tie";
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase().replace(/^response[ _]?/, "");
  if (t === "1" || t === "first" || t === "a") return 1;
  if (t === "2" || t === "second" || t === "b") return 2;
  if (t === "tie" || t === "equal" || t === "none" || t === "neither" || t === "both" || t === "0") return "tie";
  return undefined;
}

/** Find the winner in reply text. Throws JudgeParseError when there is none. */
export function parsePairReply(raw: string): { slot: Slot; reason?: string } {
  const found = extractJson(raw, { accept: (v) => !!v && typeof v === "object" && !Array.isArray(v) && "winner" in v }) as Record<string, unknown> | undefined;
  if (!found) throw new JudgeParseError("pairwise judge reply contained no JSON winner", raw);
  const slot = parseSlot(found.winner);
  if (slot === undefined) throw new JudgeParseError(`pairwise judge winner ${JSON.stringify(found.winner)} is not "1", "2" or "tie"`, raw);
  return typeof found.reason === "string" && found.reason.trim() ? { slot, reason: found.reason.trim() } : { slot };
}

/** Combine the two orders: [A first, B first] slot picks into A/B terms. */
export function combineOrders(aFirst: Slot, bFirst: Slot): Pick<PairVerdict, "winner" | "orders" | "consistent" | "favored"> {
  const o1: PairWinner = aFirst === 1 ? "a" : aFirst === 2 ? "b" : "tie";
  const o2: PairWinner = bFirst === 1 ? "b" : bFirst === 2 ? "a" : "tie";
  const consistent = o1 === o2;
  const out: Pick<PairVerdict, "winner" | "orders" | "consistent" | "favored"> = { winner: consistent ? o1 : "tie", orders: [o1, o2], consistent };
  if (!consistent && aFirst !== "tie" && aFirst === bFirst) out.favored = aFirst === 1 ? "first" : "second";
  return out;
}

const RETRY_NOTE = '\n\nYour previous reply could not be parsed. Reply with ONLY the JSON object {"winner": "1" | "2" | "tie", "reason": "..."}.';
const SLOT_SCORE = { 1: 1, 2: 0, tie: 0.5 } as const;

export function createPairwiseJudge(opts: PairwiseOptions): PairwiseJudge {
  const system = opts.system ?? PAIRWISE_SYSTEM;
  const template = opts.template ?? PAIRWISE_TEMPLATE;
  // Same versioning as the pointwise judge; the pairwise prompt gives it its own hash.
  const version = judgeVersionFor({
    name: opts.name,
    rubric: opts.rubric,
    provider: opts.provider,
    system,
    template,
    ...(opts.criterion ? { criterion: opts.criterion } : {}),
    ...(opts.maxFieldChars !== undefined ? { maxFieldChars: opts.maxFieldChars } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.tunedOn ? { tunedOn: opts.tunedOn } : {}),
    ...(opts.calibration ? { calibration: opts.calibration } : {}),
    ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
  });
  const limit = createLimiter(opts.concurrency ?? 4);
  const parseRetries = opts.parseRetries ?? 1;
  const maxField = opts.maxFieldChars ?? 20_000;

  const ask: PairwiseJudge["ask"] = async (ctx, first, second) => {
    const values: Record<string, string> = {
      criterion: version.criterion,
      rubric: opts.rubric.trim(),
      input: block("input", ctx.input, maxField),
      expected: block("expected", ctx.expected, maxField),
      response_1: block("response_1", first ?? "", maxField),
      response_2: block("response_2", second ?? "", maxField),
    };
    const user = template
      .replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? (values[k] as string) : m))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const inputHash = sha256Hex(`${system}\u001f${user}`);
    const hit = await opts.cache?.get(version.id, inputHash);
    if (hit) {
      const slot: Slot = hit.score === 1 ? 1 : hit.score === 0 ? 2 : "tie";
      return { slot, cached: true, ...(hit.reason ? { reason: hit.reason } : {}) };
    }
    return limit(async () => {
      let lastErr: JudgeParseError | undefined;
      for (let attempt = 0; attempt <= parseRetries; attempt++) {
        const res = await opts.provider.complete({
          system,
          user: attempt === 0 ? user : user + RETRY_NOTE,
          jsonSchema: PAIRWISE_SCHEMA,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        let parsed: { slot: Slot; reason?: string };
        try {
          parsed = parsePairReply(res.text);
        } catch (e) {
          if (!(e instanceof JudgeParseError)) throw e;
          lastErr = e;
          continue;
        }
        // The verdict cache holds a pointwise shape: score 1 = first response, 0 = second, 0.5 = tie.
        await opts.cache?.set(version.id, inputHash, {
          score: SLOT_SCORE[parsed.slot],
          pass: parsed.slot === 1,
          confidence: 1,
          model: res.model,
          raw: res.text,
          ts: Date.now(),
          ...(parsed.reason ? { reason: parsed.reason } : {}),
        });
        return { ...parsed, cached: false };
      }
      throw new JudgeParseError(`${version.id}: ${lastErr?.message ?? "unparseable reply"} (after ${parseRetries + 1} attempts)`, lastErr?.raw ?? "");
    });
  };

  return {
    version,
    ask,
    async compare(ctx) {
      const [x, y] = await Promise.all([ask(ctx, ctx.a, ctx.b), ask(ctx, ctx.b, ctx.a)]);
      return { ...combineOrders(x.slot, y.slot), reasons: [x.reason, y.reason], cached: x.cached && y.cached };
    },
  };
}

// ------------------------------------------------------------ calibration

export interface PairLabel {
  caseId: string;
  winner: PairWinner;
  by?: string;
}

/** Human pairwise labels from parsed JSON: an array (or JSONL rows) of {caseId, winner: "a"|"b"|"tie", by?}. */
export function parsePairLabels(rows: readonly unknown[]): PairLabel[] {
  return rows.map((r, i) => {
    const o = r as Record<string, unknown> | null;
    const caseId = o && typeof o === "object" ? o.caseId : undefined;
    const w = o && typeof o === "object" && typeof o.winner === "string" ? o.winner.trim().toLowerCase() : undefined;
    if (typeof caseId !== "string" || !caseId) throw new Error(`label ${i + 1}: caseId must be a non-empty string`);
    if (w !== "a" && w !== "b" && w !== "tie") throw new Error(`label ${i + 1}: winner must be "a", "b" or "tie" (got ${JSON.stringify(o?.winner)})`);
    const l: PairLabel = { caseId, winner: w };
    if (typeof o?.by === "string" && o.by) l.by = o.by;
    return l;
  });
}

export interface PairCalibration {
  report: CalibrationReport;
  /** Human-decisive cases (any split) where the judge said tie: abstentions, left out of κ. */
  abstained: number;
}

/**
 * κ between the pairwise judge and humans, through calibrate(): "b" is pass,
 * "a" is fail, a human "tie" is skipped and a judge tie is an abstention.
 * Sensitivity in the stored status is P(judge says B | human says B).
 */
export function calibratePairwise(
  opts: Omit<CalibrateOpts, "labels" | "verdicts" | "splits"> & {
    labels: readonly PairLabel[];
    verdicts: ReadonlyMap<string, Pick<PairVerdict, "winner">>;
    splits: Dataset | ReadonlyMap<string, Split> | Readonly<Record<string, Split>>;
  },
): PairCalibration {
  const labels: HumanLabel[] = opts.labels.map((l) => ({ caseId: l.caseId, value: l.winner === "b" ? "pass" : l.winner === "a" ? "fail" : "skip", ...(l.by ? { by: l.by } : {}) }));
  const verdicts = new Map<string, JudgedCase>();
  let abstained = 0;
  const decisive = new Set(opts.labels.filter((l) => l.winner !== "tie").map((l) => l.caseId));
  for (const [caseId, v] of opts.verdicts) {
    if (v.winner === "tie") {
      if (decisive.has(caseId)) abstained++;
      continue;
    }
    verdicts.set(caseId, { caseId, pass: v.winner === "b" });
  }
  const { labels: _l, verdicts: _v, ...rest } = opts;
  return { report: calibrate({ ...rest, labels, verdicts }), abstained };
}
