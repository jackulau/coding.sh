// coding.sh judge calibrate <experiment>: agreement between an LLM judge's
// verdicts (a grader in the experiment's runs) and human labels, reported on
// a held-out split only (src/judge/calibrate.ts).
import { FileEvalStore } from "../../datasets/store.ts";
import type { JudgeVersion, Split } from "../../datasets/types.ts";
import { calibrate, labelsFromCore, withCalibration, type JudgedCase } from "../../judge/calibrate.ts";
import { CHECKLIST_KIND } from "../../judge/checklist.ts";
import { renderCalibration } from "../../judge/render.ts";
import { UsageError } from "../args.ts";
import { list, num, str, withContext } from "../common.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

const SPLITS = ["train", "dev", "test"];

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  if (c.action !== "calibrate") throw new UsageError(`Unknown judge command ${c.action}`);
  return withContext(c, async (ctx) => {
    const store = new FileEvalStore({ env, index: ctx.index });
    const expId = c.positionals[0]!;
    const exp = await store.resolveExperiment(expId);
    if (!exp) throw new CliError(`Can't find experiment ${JSON.stringify(expId)}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });

    // LLM judges: kind "llm", and checklists that ask a model (an all-predicate checklist is deterministic and carries no calibration).
    const llm = exp.graders.filter((g) => g.kind === "llm" || (g.kind === CHECKLIST_KIND && g.calibration !== undefined));
    const graderId = str(c.flags.grader) ?? (llm.length === 1 ? llm[0]!.id : undefined);
    if (!graderId) {
      throw new UsageError(llm.length ? `Experiment has ${llm.length} judge graders; pass --grader <ID> (${llm.map((g) => g.id).join(", ")})` : "Experiment has no LLM judge grader", { reason: "missing_argument" });
    }
    const grader = exp.graders.find((g) => g.id === graderId);
    if (!grader) throw new UsageError(`Experiment has no grader ${JSON.stringify(graderId)}`);

    const dataset = await store.getDataset(exp.dataset.id, exp.dataset.version);
    if (!dataset) throw new CliError(`Can't find dataset ${exp.dataset.id}@${exp.dataset.version}`, { reason: "not_found" });

    const stored: JudgeVersion | undefined = await store.getJudge(grader.version);
    const tunedFlag = list(c.flags["tuned-on"]);
    for (const s of tunedFlag) if (!SPLITS.includes(s)) throw new UsageError(`--tuned-on must be one of ${SPLITS.join(", ")}, got ${JSON.stringify(s)}`);
    if (!stored && !tunedFlag.length) {
      throw new UsageError(`Judge ${grader.version} is not stored, so its tuning splits are unknown. Pass --tuned-on <SPLIT> (e.g. --tuned-on dev)`, { reason: "missing_argument" });
    }
    const tunedOn = (tunedFlag.length ? tunedFlag : stored!.tunedOn) as Split[];
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
    const labels = labelsFromCore(await ctx.index.listLabels(criterion ? { criterion } : {}), (sid) => caseBySession.get(sid));

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
    if (out.json) out.data({ outcome: stored ? "updated" : "measured", calibration: report });
    else out.print(renderCalibration(report, { color: out.color }));
    return report.state === "calibrated" ? 0 : 1;
  });
}
