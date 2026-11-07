// LLM judge: rubric prompt → structured verdict, with versioning, caching,
// bounded concurrency, and a robust parse of whatever the model replies.
import { sha256Hex } from "../core/ids.ts";
import { slugify } from "../datasets/dataset.ts";
import { shortHash } from "../datasets/hash.ts";
import type { CalibrationStatus, Citation, GradeContext, Grader, JudgeVerdict, JudgeVersion, Split } from "../datasets/types.ts";
import type { JudgeCache } from "./cache.ts";
import { extractJson } from "./extract.ts";
import { createLimiter } from "./limit.ts";
import { DEFAULT_SYSTEM, DEFAULT_TEMPLATE, VERDICT_SCHEMA, renderPrompt, verifyCitations, type RenderLimits } from "./prompt.ts";
import type { ChatProvider } from "./providers.ts";

export class JudgeParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "JudgeParseError";
    this.raw = raw;
  }
}

export interface JudgeOptions extends RenderLimits {
  name: string;
  /** What is judged, matching human label criteria. Default: name. */
  criterion?: string;
  rubric: string;
  provider: ChatProvider;
  system?: string;
  /** User prompt template with {{criterion}} {{rubric}} {{input}} {{output}} {{expected}} {{trace}}. */
  template?: string;
  /** Score at or above which a verdict without an explicit `pass` passes. Default 0.5. */
  passThreshold?: number;
  status?: JudgeVersion["status"];
  /** Splits used while iterating on this judge's prompt. Default ["train", "dev"]. */
  tunedOn?: Split[];
  calibration?: CalibrationStatus;
  createdAt?: number;
  cache?: JudgeCache;
  /** Max in-flight model calls for this judge. Default 4. */
  concurrency?: number;
  /** Extra attempts when the reply has no parseable verdict. Default 1. */
  parseRetries?: number;
}

export interface Judge {
  readonly version: JudgeVersion;
  evaluate(ctx: GradeContext): Promise<JudgeVerdict>;
}

/** The judge version for a configuration: id = `<name>@hash(model, prompt, rubric, params)`. */
export function judgeVersionFor(opts: JudgeOptions): JudgeVersion {
  const system = opts.system ?? DEFAULT_SYSTEM;
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const criterion = opts.criterion ?? opts.name;
  const passThreshold = opts.passThreshold ?? 0.5;
  const limits: RenderLimits = {};
  if (opts.maxFieldChars !== undefined) limits.maxFieldChars = opts.maxFieldChars;
  if (opts.maxEventChars !== undefined) limits.maxEventChars = opts.maxEventChars;
  if (opts.maxTraceChars !== undefined) limits.maxTraceChars = opts.maxTraceChars;
  const params = { ...opts.provider.params, passThreshold, ...limits };
  const promptHash = sha256Hex(`${system}\u001f${template}`);
  const h = shortHash({ provider: opts.provider.name, model: opts.provider.model, promptHash, rubric: opts.rubric, criterion, params }, 12);
  const v: JudgeVersion = {
    id: `${slugify(opts.name)}@${h}`,
    name: opts.name,
    criterion,
    rubric: opts.rubric,
    provider: opts.provider.name,
    model: opts.provider.model,
    promptHash,
    params,
    status: opts.status ?? "draft",
    tunedOn: opts.tunedOn ?? ["train", "dev"],
    passThreshold,
    createdAt: opts.createdAt ?? Date.now(),
  };
  if (opts.calibration) v.calibration = opts.calibration;
  return v;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "pass" || t === "passed" || t === "yes") return true;
    if (t === "false" || t === "fail" || t === "failed" || t === "no") return false;
  }
  return undefined;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface ParsedVerdict {
  score: number;
  pass: boolean;
  confidence: number;
  reason?: string;
  citations: Citation[];
}

/** Find and normalize a verdict in reply text. Throws JudgeParseError when none is there. */
export function parseVerdict(raw: string, passThreshold = 0.5): ParsedVerdict {
  const found = extractJson(raw, {
    accept: (v) => !!v && typeof v === "object" && !Array.isArray(v) && ("score" in v || "pass" in v || "verdict" in v),
  }) as Record<string, unknown> | undefined;
  if (!found) throw new JudgeParseError("judge reply contained no JSON verdict", raw);
  let score = num(found.score);
  // Tolerate a 0–10 or 0–100 scale when the model ignores "0..1".
  if (score !== undefined && score > 1) score = score <= 10 ? score / 10 : score <= 100 ? score / 100 : 1;
  const pass = bool(found.pass) ?? bool(found.verdict);
  if (score === undefined && pass === undefined) throw new JudgeParseError("judge verdict has neither a numeric score nor a pass flag", raw);
  const s = clamp01(score ?? (pass ? 1 : 0));
  const p = pass ?? s >= passThreshold;
  const conf = num(found.confidence);
  const citations: Citation[] = [];
  if (Array.isArray(found.citations)) {
    for (const c of found.citations) {
      if (typeof c === "string" && c.trim()) citations.push({ quote: c });
      else if (c && typeof c === "object" && typeof (c as { quote?: unknown }).quote === "string") {
        const quote = (c as { quote: string }).quote;
        const eventId = (c as { eventId?: unknown }).eventId;
        if (!quote.trim()) continue;
        citations.push(typeof eventId === "string" && eventId ? { eventId, quote } : { quote });
      }
    }
  }
  const out: ParsedVerdict = {
    score: s,
    pass: p,
    confidence: conf !== undefined ? clamp01(conf > 1 ? conf / 100 : conf) : Math.abs(s - 0.5) * 2,
    citations,
  };
  if (typeof found.reason === "string" && found.reason.trim()) out.reason = found.reason.trim();
  return out;
}

const RETRY_NOTE = "\n\nYour previous reply could not be parsed. Reply with ONLY the JSON object described in the instructions.";

export function createJudge(opts: JudgeOptions): Judge {
  const version = judgeVersionFor(opts);
  const limit = createLimiter(opts.concurrency ?? 4);
  const parseRetries = opts.parseRetries ?? 1;
  return {
    version,
    async evaluate(ctx) {
      const prompt = renderPrompt(
        {
          criterion: version.criterion,
          rubric: opts.rubric,
          ...(opts.system !== undefined ? { system: opts.system } : {}),
          ...(opts.template !== undefined ? { template: opts.template } : {}),
          ...(opts.maxFieldChars !== undefined ? { maxFieldChars: opts.maxFieldChars } : {}),
          ...(opts.maxEventChars !== undefined ? { maxEventChars: opts.maxEventChars } : {}),
          ...(opts.maxTraceChars !== undefined ? { maxTraceChars: opts.maxTraceChars } : {}),
        },
        ctx,
      );
      const inputHash = sha256Hex(`${prompt.system}\u001f${prompt.user}`);
      const hit = await opts.cache?.get(version.id, inputHash);
      if (hit) {
        const v: JudgeVerdict = { score: hit.score, pass: hit.pass, confidence: hit.confidence, judgeVersion: version.id, cached: true };
        if (hit.reason) v.reason = hit.reason;
        if (hit.citations?.length) v.citations = hit.citations;
        return v;
      }
      return limit(async () => {
        let lastErr: JudgeParseError | undefined;
        for (let attempt = 0; attempt <= parseRetries; attempt++) {
          const res = await opts.provider.complete({
            system: prompt.system,
            user: attempt === 0 ? prompt.user : prompt.user + RETRY_NOTE,
            jsonSchema: VERDICT_SCHEMA,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          let parsed: ParsedVerdict;
          try {
            parsed = parseVerdict(res.text, version.passThreshold);
          } catch (e) {
            if (!(e instanceof JudgeParseError)) throw e;
            lastErr = e;
            continue;
          }
          const citations = verifyCitations(parsed.citations, prompt.material);
          const v: JudgeVerdict = { score: parsed.score, pass: parsed.pass, confidence: parsed.confidence, judgeVersion: version.id, cached: false };
          if (parsed.reason) v.reason = parsed.reason;
          if (citations.length) v.citations = citations;
          const entry: Parameters<JudgeCache["set"]>[2] = { score: v.score, pass: v.pass, confidence: v.confidence, model: res.model, raw: res.text, ts: Date.now() };
          if (v.reason) entry.reason = v.reason;
          if (citations.length) entry.citations = citations;
          await opts.cache?.set(version.id, inputHash, entry);
          return v;
        }
        throw new JudgeParseError(`${version.id}: ${lastErr?.message ?? "unparseable reply"} (after ${parseRetries + 1} attempts)`, lastErr?.raw ?? "");
      });
    },
  };
}

const NEVER_CALIBRATED: CalibrationStatus = { state: "uncalibrated", reason: "never calibrated against held-out human labels" };

/** Use a judge as a grader. Uncalibrated unless a calibration is attached to its version. */
export function judgeGrader(judge: Judge, opts: { id?: string; calibration?: CalibrationStatus } = {}): Grader {
  return {
    id: opts.id ?? judge.version.name,
    kind: "llm",
    version: judge.version.id,
    calibration: opts.calibration ?? judge.version.calibration ?? NEVER_CALIBRATED,
    judgeVersion: judge.version,
    async grade(ctx) {
      const v = await judge.evaluate(ctx);
      const r: { score: number; pass: boolean; reason?: string; citations?: Citation[] } = { score: v.score, pass: v.pass };
      if (v.reason) r.reason = v.reason;
      if (v.citations) r.citations = v.citations;
      return r;
    },
  };
}
