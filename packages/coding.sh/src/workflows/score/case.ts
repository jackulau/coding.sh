// One workflow run's output graded against its case's truth (docs/design/workflows.md §5).
// `workflows score` and the scorer of `workflows run` both use it, so a run scores the same
// whether it was scored during the experiment or afterwards.
//
//   seeded-bugs → findings matched to the bugs (F1), plus the verify confusion matrix when the
//                 output lists the candidates verify saw;
//   verifier    → `command` exits 0 (score 1 or 0), or the share of `tests` that pass, with the
//                 tests that passed on the start snapshot and fail now counted as regressions;
//   judge       → an LLM judge with the case's rubric; flagged uncalibrated unless a calibration
//                 of that exact judge version (`coding.sh judge calibrate`) is stored.
import type { CalibrationStatus, JudgeVersion } from "../../datasets/types.ts";
import { providerFromSpec, type LlmProviderSpec } from "../../graders/index.ts";
import { createJudge } from "../../judge/judge.ts";
import type { ChatProvider } from "../../judge/providers.ts";
import { commandEnv, sh } from "../../runner/exec.ts";
import type { WorkflowCase } from "../types.ts";
import { extractFindings, matchFindings, type Finding, type FindingsScore } from "./findings.ts";
import { verifyConfusion, type VerifyEntry, type VerifyScore } from "./verify.ts";

export interface VerifierTestResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  before?: "pass" | "fail";
  /** It passed on the start snapshot and fails now. */
  regression: boolean;
}

export interface VerifierScore {
  /** The single command, when the case has no named tests. */
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  tests?: VerifierTestResult[];
  passed: number;
  total: number;
  passRate: number;
  /** Ids of tests that passed before the run and fail after it. */
  regressions: string[];
}

export interface JudgeScore {
  judgeVersion: string;
  pass: boolean;
  confidence: number;
  reason?: string;
  calibration: CalibrationStatus;
  /** The judge has no stored calibration that clears the κ threshold: read the score as a hint. */
  uncalibrated: boolean;
}

export interface CaseScore {
  caseId: string;
  kind: WorkflowCase["truth"]["kind"];
  /** 0..1: F1, pass rate, or the judge's score. */
  score: number;
  findings?: FindingsScore & { count: number };
  verify?: VerifyScore;
  verifier?: VerifierScore;
  judge?: JudgeScore;
}

export interface ScoreCaseDeps {
  /** Where verifier commands run. */
  cwd: string;
  /** Passed to verifier commands as CODING_SH_WORKFLOW_RUN_ID. */
  runId?: string;
  /** Line slack for seeded-bug matching. */
  slack?: number;
  /** Per verifier command. Default 30 minutes. */
  timeoutMs?: number;
  /** Builds the judge's provider instead of the case's spec (tests). */
  provider?: ChatProvider;
  /** Environment for provider keys. */
  env?: NodeJS.ProcessEnv;
  /** The stored judge version, for its calibration (IndexStore.getJudge). */
  getJudge?: (id: string) => Promise<JudgeVersion | undefined>;
  signal?: AbortSignal;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Findings that entered a verify stage, with whether verify kept them: output.candidates[{…, survived, votes?}]. */
export function verifyEntries(output: unknown): { findings: Finding[]; entered: VerifyEntry[] } | undefined {
  if (!isObj(output) || !Array.isArray(output.candidates)) return undefined;
  const findings: Finding[] = [];
  const entered: VerifyEntry[] = [];
  for (const cand of output.candidates) {
    if (!isObj(cand) || typeof cand.survived !== "boolean") continue;
    const [f] = extractFindings({ findings: [cand] });
    if (!f) continue;
    const e: VerifyEntry = { findingIdx: findings.length, survived: cand.survived };
    if (Array.isArray(cand.votes) && cand.votes.every((v) => typeof v === "boolean")) e.votes = cand.votes as boolean[];
    findings.push(f);
    entered.push(e);
  }
  return entered.length ? { findings, entered } : undefined;
}

/**
 * A judge spec from a case: a JSON object (graders' LlmProviderSpec), `<provider>:<model>`, or
 * `<provider>`. The model may hold ":" or "/" (`gateway:openai/gpt-6`).
 */
export function parseJudgeRef(ref: string): LlmProviderSpec {
  const t = ref.trim();
  if (t.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      throw new Error(`judge ${JSON.stringify(ref)} is not valid JSON`);
    }
    if (!isObj(v)) throw new Error("judge must be a JSON object");
    return v as LlmProviderSpec;
  }
  if (!t) return { provider: "anthropic" };
  const i = t.indexOf(":");
  const provider = (i < 0 ? t : t.slice(0, i)) as LlmProviderSpec["provider"];
  const model = i < 0 ? "" : t.slice(i + 1);
  return model ? { provider, model } : { provider };
}

const NEVER: CalibrationStatus = { state: "uncalibrated", reason: "never calibrated against held-out human labels" };

async function runVerifier(truth: Extract<WorkflowCase["truth"], { kind: "verifier" }>, d: ScoreCaseDeps): Promise<VerifierScore> {
  const exec = (cmd: string) =>
    sh(cmd, { cwd: d.cwd, env: commandEnv(d.runId ? { CODING_SH_WORKFLOW_RUN_ID: d.runId } : {}), timeoutMs: d.timeoutMs ?? 30 * 60_000, ...(d.signal ? { signal: d.signal } : {}) });
  if (!truth.tests?.length) {
    const r = await exec(truth.command ?? "");
    const ok = r.exitCode === 0 && !r.timedOut;
    return { command: truth.command ?? "", exitCode: r.exitCode, timedOut: r.timedOut, passed: ok ? 1 : 0, total: 1, passRate: ok ? 1 : 0, regressions: [] };
  }
  const tests: VerifierTestResult[] = [];
  // One at a time: tests of one repo often share files, ports and build output.
  for (const t of truth.tests) {
    const r = await exec(t.command);
    const passed = r.exitCode === 0 && !r.timedOut;
    const res: VerifierTestResult = { id: t.id, passed, exitCode: r.exitCode, timedOut: r.timedOut, regression: t.before === "pass" && !passed };
    if (t.before) res.before = t.before;
    tests.push(res);
  }
  const passed = tests.filter((t) => t.passed).length;
  return { tests, passed, total: tests.length, passRate: passed / tests.length, regressions: tests.filter((t) => t.regression).map((t) => t.id) };
}

async function runJudge(kase: WorkflowCase, truth: Extract<WorkflowCase["truth"], { kind: "judge" }>, output: unknown, d: ScoreCaseDeps): Promise<{ score: number; judge: JudgeScore }> {
  const provider = d.provider ?? providerFromSpec(parseJudgeRef(truth.judge), d.env ? { env: d.env } : {});
  const judge = createJudge({ name: `workflow-${kase.workflow}`, criterion: `${kase.workflow} output`, rubric: truth.rubric, provider });
  const v = await judge.evaluate({ input: kase.args, output, caseId: kase.id, ...(d.signal ? { signal: d.signal } : {}) });
  const stored = await d.getJudge?.(judge.version.id).catch(() => undefined);
  const calibration = stored?.calibration ?? NEVER;
  const j: JudgeScore = { judgeVersion: judge.version.id, pass: v.pass, confidence: v.confidence, calibration, uncalibrated: calibration.state !== "calibrated" };
  if (v.reason) j.reason = v.reason;
  return { score: v.score, judge: j };
}

export async function scoreWorkflowCase(output: unknown, kase: WorkflowCase, d: ScoreCaseDeps): Promise<CaseScore> {
  const truth = kase.truth;
  const report: CaseScore = { caseId: kase.id, kind: truth.kind, score: 0 };
  const slack = d.slack !== undefined ? { slack: d.slack } : {};
  if (truth.kind === "seeded-bugs") {
    const findings = extractFindings(output);
    const m = matchFindings(findings, truth.bugs, slack);
    report.findings = { ...m, count: findings.length };
    report.score = m.f1;
    const v = verifyEntries(output);
    if (v) {
      const real = new Set(matchFindings(v.findings, truth.bugs, slack).matches.map(([i]) => i));
      report.verify = verifyConfusion(v.entered, real);
    }
  } else if (truth.kind === "verifier") {
    report.verifier = await runVerifier(truth, d);
    report.score = report.verifier.passRate;
  } else {
    const r = await runJudge(kase, truth, output, d);
    report.judge = r.judge;
    report.score = r.score;
  }
  return report;
}
