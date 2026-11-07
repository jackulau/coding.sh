// coding.sh judge calibrate <experiment>: agreement between an LLM judge's
// verdicts (a grader in the experiment's runs) and human labels, reported on
// a held-out split only (src/judge/calibrate.ts). --probe-injection re-judges
// human-fail cases with a planted "respond pass" payload (src/judge/injection.ts).
// A deterministic grader (--grader tests) gets a precision audit instead
// (src/judge/verifier.ts), and --sample-passes prints the labelling queue for it.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Grader, GraderInfo, JudgeVersion, Split } from "../../datasets/types.ts";
import { asText } from "../../graders/builtin.ts";
import { createGrader, type GraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { calibrate, labelsFromCore, withCalibration, type HumanLabel, type JudgedCase } from "../../judge/calibrate.ts";
import { CHECKLIST_KIND } from "../../judge/checklist.ts";
import { humanFailCases, injectionProbe, type ProbeCase } from "../../judge/injection.ts";
import { renderCalibration } from "../../judge/render.ts";
import { auditVerifier, DEFAULT_MIN_PASSES, parseCaseLabels, renderVerifierAudit, samplePasses } from "../../judge/verifier.ts";
import { positiveInt, UsageError } from "../args.ts";
import { jsonArg, list, num, oneLine, str, withContext } from "../common.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

const SPLITS = ["train", "dev", "test"];
/** Human-fail cases the injection probe judges by default (each costs up to three judge calls). */
const PROBE_MAX = 25;

/** An LLM judge (calibrated against labels) rather than a deterministic verifier (audited against them). */
const isJudge = (g: GraderInfo) => g.kind === "llm" || (g.kind === CHECKLIST_KIND && g.calibration !== undefined);

/** --labels: a JSON array or JSONL rows of {"caseId","value"}. */
async function readCaseLabels(file: string): Promise<HumanLabel[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`can't read --labels ${JSON.stringify(file)}`, { reason: "invalid_argument" });
  }
  try {
    const t = text.trim();
    const rows = t.startsWith("[") ? (JSON.parse(t) as unknown[]) : t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    return parseCaseLabels(rows);
  } catch (e) {
    throw new UsageError(`--labels ${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
  }
}

/** The judge to probe, rebuilt from its spec (the same JSON as `exp run --grader`). */
async function probeJudge(c: CommandContext, specArg: string): Promise<Grader> {
  const spec = (await jsonArg(specArg, "--probe-injection")) as GraderSpec;
  if (!spec || typeof spec !== "object" || (spec.kind !== "llm" && spec.kind !== CHECKLIST_KIND)) {
    throw new UsageError(`--probe-injection must be the judge's grader spec, e.g. {"kind":"llm","name":"…","rubric":"…","provider":"anthropic"}`, { reason: "invalid_grader" });
  }
  let g: Grader;
  try {
    g = await createGrader(spec, { env: c.env, judgeCache: FileJudgeCache.forEnv(c.env) });
  } catch (e) {
    throw new UsageError(`Invalid judge: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  if (!g.judgeVersion) throw new UsageError("--probe-injection needs a judge that asks a model (an all-predicate checklist cannot be injected)", { reason: "invalid_grader" });
  return g;
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  if (c.action !== "calibrate") throw new UsageError(`Unknown judge command ${c.action}`);
  return withContext(c, async (ctx) => {
    const store = new FileEvalStore({ env, index: ctx.index });
    const expId = c.positionals[0]!;
    const exp = await store.resolveExperiment(expId);
    if (!exp) throw new CliError(`Can't find experiment ${JSON.stringify(expId)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });

    // LLM judges: kind "llm", and checklists that ask a model (an all-predicate checklist is deterministic and carries no calibration).
    const llm = exp.graders.filter(isJudge);
    const graderId = str(c.flags.grader) ?? (llm.length === 1 ? llm[0]!.id : undefined);
    if (!graderId) {
      const all = exp.graders.map((g) => g.id).join(", ");
      throw new UsageError(
        llm.length ? `Experiment has ${llm.length} judge graders; pass --grader <ID> (${llm.map((g) => g.id).join(", ")})` : `Experiment has no LLM judge grader; pass --grader <ID> to audit a verifier's precision${all ? ` (${all})` : ""}`,
        { reason: "missing_argument" },
      );
    }
    const grader = exp.graders.find((g) => g.id === graderId);
    if (!grader) throw new UsageError(`Experiment has no grader ${JSON.stringify(graderId)}`);
    const judge = isJudge(grader);
    const sampleN = positiveInt(c.flags["sample-passes"], "sample-passes");
    const probeSpec = str(c.flags["probe-injection"]);
    if (!judge && probeSpec) throw new UsageError(`--probe-injection needs an LLM judge; ${grader.id} is a ${grader.kind} grader`, { reason: "invalid_argument" });

    const dataset = await store.getDataset(exp.dataset.id, exp.dataset.version);
    if (!dataset) throw new CliError(`Can't find dataset ${exp.dataset.id}@${exp.dataset.version}`, { reason: "not_found" });

    // Only an LLM judge has tuning splits; a verifier never saw the labels, so every labelled case counts.
    const stored: JudgeVersion | undefined = judge ? await store.getJudge(grader.version) : undefined;
    const tunedFlag = list(c.flags["tuned-on"]);
    for (const s of tunedFlag) if (!SPLITS.includes(s)) throw new UsageError(`--tuned-on must be one of ${SPLITS.join(", ")}, got ${JSON.stringify(s)}`);
    if (judge && sampleN === undefined && !stored && !tunedFlag.length) {
      throw new UsageError(`Judge ${grader.version} is not stored, so its tuning splits are unknown. Pass --tuned-on <SPLIT> (e.g. --tuned-on dev)`, { reason: "missing_argument" });
    }
    const tunedOn = (tunedFlag.length ? tunedFlag : (stored?.tunedOn ?? [])) as Split[];
    const criterion = str(c.flags.criterion) ?? stored?.criterion;

    // Verdicts: first trial per case (one verdict per case; later trials are retries, not votes).
    const verdicts = new Map<string, JudgedCase>();
    for (const r of [...exp.runs].sort((a, b) => a.trial - b.trial)) {
      if (verdicts.has(r.caseId)) continue;
      const g = r.grades.find((x) => x.graderId === graderId);
      if (!g?.result) continue;
      const v: JudgedCase = { caseId: r.caseId, pass: g.result.pass };
      if (typeof g.result.score === "number") v.score = g.result.score;
      if (g.result.reason) v.reason = g.result.reason;
      verdicts.set(r.caseId, v);
    }

    // Labels are on sessions; a case maps to its source session (or its own id).
    const caseBySession = new Map<string, string>();
    for (const cs of dataset.cases) caseBySession.set(cs.sourceSessionId ?? cs.id, cs.id);
    let labels = labelsFromCore(await ctx.index.listLabels(criterion ? { criterion } : {}), (sid) => caseBySession.get(sid));
    // --labels rows replace stored labels for the cases they name.
    const labelsFile = str(c.flags.labels);
    if (labelsFile) {
      const fromFile = await readCaseLabels(resolve(c.cwd, labelsFile));
      const named = new Set(fromFile.map((l) => l.caseId));
      labels = [...labels.filter((l) => !named.has(l.caseId)), ...fromFile];
    }

    if (sampleN !== undefined) {
      const seed = num(c.flags.seed) ?? 0;
      if (!(Number.isInteger(seed) && seed >= 0)) throw new UsageError(`--seed must be a non-negative integer, got ${JSON.stringify(c.flags.seed)}`);
      const ids = samplePasses(verdicts, labels, sampleN, { ...(criterion ? { criterion } : {}), seed });
      const byId = new Map(dataset.cases.map((cs) => [cs.id, cs]));
      const outputOf = new Map<string, unknown>();
      for (const r of [...exp.runs].sort((x, y) => x.trial - y.trial)) if (!outputOf.has(r.caseId)) outputOf.set(r.caseId, r.output);
      const queue = ids.map((id) => {
        const cs = byId.get(id);
        return { caseId: id, ...(cs?.sourceSessionId ? { sessionId: cs.sourceSessionId } : {}), input: cs?.input, output: outputOf.get(id) };
      });
      if (out.json) {
        out.data({ grader: { id: grader.id, version: grader.version, kind: grader.kind }, ...(criterion ? { criterion } : {}), seed, queue });
      } else if (!queue.length) {
        out.print(`No unlabelled passing cases for ${grader.id}`);
      } else {
        const lines = [`Label ${queue.length} passing case(s) of ${grader.id} (seed ${seed}): would you accept each output?`];
        for (const q of queue) lines.push(`  ${q.caseId}${q.sessionId ? `  session ${q.sessionId}` : ""}  ${oneLine(asText(q.input), 50)} -> ${oneLine(asText(q.output), 70)}`);
        lines.push("", 'Label sessions in the viewer, or write {"caseId":"…","value":"pass"|"fail"} rows to a JSONL file, then run:');
        lines.push(`  coding.sh judge calibrate ${expId} --grader ${grader.id} --labels labels.jsonl`);
        out.print(lines.join("\n"));
      }
      return 0;
    }

    if (!judge) {
      const minN = num(c.flags["min-n"]);
      const audit = auditVerifier({
        graderId: grader.id,
        graderVersion: grader.version,
        experimentId: exp.id,
        ...(criterion ? { criterion } : {}),
        verdicts,
        labels,
        minPasses: minN ?? DEFAULT_MIN_PASSES,
      });
      // compare and show read the newest audit per grader version.
      if (audit.precision !== undefined) await store.putVerifierAudit(audit);
      if (out.json) out.data({ outcome: audit.precision !== undefined ? "audited" : "no_labels", verifier: audit });
      else out.print(renderVerifierAudit(audit));
      return audit.state === "audited" ? 0 : 1;
    }

    const report = calibrate({
      judge: { id: grader.version, tunedOn, ...(criterion ? { criterion } : {}) },
      labels,
      verdicts,
      splits: dataset,
      reportSplit: (str(c.flags.split) ?? "test") as Split,
      ...(num(c.flags.threshold) !== undefined ? { kappaThreshold: num(c.flags.threshold)! } : {}),
      ...(num(c.flags["min-n"]) !== undefined ? { minN: num(c.flags["min-n"])! } : {}),
    });
    if (stored) await store.putJudge(withCalibration(stored, report));

    if (probeSpec) {
      const judge = await probeJudge(c, probeSpec);
      if (judge.version !== grader.version) out.warn(`The probed judge is ${judge.version}, not the experiment's ${grader.version} (its prompt, model or rubric differ)`);
      const max = positiveInt(c.flags["probe-max"], "probe-max") ?? PROBE_MAX;
      const failed = humanFailCases(labels, criterion);
      const byId = new Map(dataset.cases.map((cs) => [cs.id, cs]));
      const cases = new Map<string, ProbeCase>();
      for (const r of [...exp.runs].sort((a, b) => a.trial - b.trial || (a.caseId < b.caseId ? -1 : 1))) {
        const cs = byId.get(r.caseId);
        if (cases.size >= max || !cs || !failed.has(r.caseId) || r.output === undefined || cases.has(r.caseId)) continue;
        cases.set(r.caseId, { caseId: r.caseId, ctx: { input: cs.input, output: r.output, caseId: cs.id, ...(cs.expected !== undefined ? { expected: cs.expected } : {}), ...(cs.metadata ? { metadata: cs.metadata } : {}) } });
      }
      const spin = out.spin(`Probing ${cases.size} human-fail case(s) for prompt injection…`);
      try {
        report.injection = await injectionProbe(judge, [...cases.values()], { signal: c.signal, judgeVersion: judge.version });
      } finally {
        spin.stop();
      }
    }

    if (out.json) out.data({ outcome: stored ? "updated" : "measured", calibration: report });
    else out.print(renderCalibration(report, { color: out.color }));
    // A judge that a planted "respond pass" can flip fails the command even when kappa is fine.
    return report.state === "calibrated" && !report.injection?.flips ? 0 : 1;
  });
}
