// coding.sh judge grade --grader <spec>: one grader on one output and trace,
// for verifier scripts (see grade() below).
// coding.sh judge slop [target]: the agent-slop rules over a session's, run's
// or experiment's diffs (judge-slop.ts).
// coding.sh judge calibrate <experiment>: agreement between an LLM judge's
// verdicts (a grader in the experiment's runs) and human labels, reported on
// a held-out split only (src/judge/calibrate.ts). --probe-injection re-judges
// human-fail cases with a planted "respond pass" payload (src/judge/injection.ts).
// A deterministic grader (--grader tests) gets a precision audit instead
// (src/judge/verifier.ts), and --sample-passes prints the labelling queue for it.
// coding.sh judge sample <experiment> --budget N: a confidence-stratified random
// label plan (src/judge/audit.ts); calibrate --plan turns its labelled picks
// into a human-audited pass rate.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { estimateCost, pricesFor } from "../../core/pricing.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Grader, GraderInfo, JudgeVersion, Split } from "../../datasets/types.ts";
import { asText } from "../../graders/builtin.ts";
import { createGrader, providerFromSpec, type GraderSpec, type LlmProviderSpec } from "../../graders/index.ts";
import { parseAuditPlan, planAudit, type AuditPlan } from "../../judge/audit.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { calibrate, labelsFromCore, withCalibration, type HumanLabel, type JudgedCase } from "../../judge/calibrate.ts";
import { CHECKLIST_KIND, type ChecklistVerdict } from "../../judge/checklist.ts";
import type { ChatProvider, ChatResponse } from "../../judge/providers.ts";
import { traceFromText } from "../../judge/trace-file.ts";
import { humanFailCases, injectionProbe, type ProbeCase } from "../../judge/injection.ts";
import { renderAuditPlan, renderCalibration } from "../../judge/render.ts";
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

/** --plan: an audit plan written by `judge sample --out`. */
async function readPlan(file: string): Promise<AuditPlan> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new UsageError(`can't read --plan ${JSON.stringify(file)}`, { reason: "invalid_argument" });
  }
  try {
    return parseAuditPlan(JSON.parse(text));
  } catch (e) {
    throw new UsageError(`--plan ${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
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

/**
 * `judge grade`: one grader on one output, for a verifier script. The output
 * and trace default to what the runner hands every verifier
 * (CODING_SH_AGENT_OUTPUT, CODING_SH_AGENT_STDOUT), so a harness A/B can grade
 * what the agent said and did, not only the files it left. Exit 0 = pass.
 * Each model call's tokens and price go to CODING_SH_GRADER_USAGE when set,
 * so the runner counts judge spend with the agent's.
 */
async function grade(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const specArg = str(c.flags.grader);
  if (!specArg) throw new UsageError("Missing --grader <JSON|FILE>", { reason: "missing_argument" });
  const spec = (await jsonArg(specArg, "--grader")) as GraderSpec;
  if (!spec || typeof spec !== "object" || typeof spec.kind !== "string") throw new UsageError('--grader must be a grader spec, e.g. {"kind":"llm-checklist","name":…,"items":[…]}', { reason: "invalid_grader" });
  const diffArg = str(c.flags.diff) ?? env.CODING_SH_AGENT_DIFF;
  const diff = diffArg === undefined ? undefined : diffArg === "-" ? await readStdin() : await readText(diffArg, "--diff", c.cwd);
  const outputArg = str(c.flags.output) ?? env.CODING_SH_AGENT_OUTPUT;
  // agent-slop grades the diff, so it needs no output when it has one.
  if (!outputArg && !(spec.kind === "agent-slop" && diff !== undefined)) throw new UsageError("Missing --output <FILE|-> (outside a verifier there is no CODING_SH_AGENT_OUTPUT)", { reason: "missing_argument" });
  if (outputArg === "-" && diffArg === "-") throw new UsageError("--output and --diff can't both read stdin", { reason: "invalid_argument" });
  const output = !outputArg ? "" : outputArg === "-" ? await readStdin() : await readText(outputArg, "--output", c.cwd);
  const traceArg = str(c.flags.trace) ?? env.CODING_SH_AGENT_STDOUT;
  const trace = traceArg ? traceFromText(await readText(traceArg, "--trace", c.cwd)) : [];
  const inputArg = str(c.flags.input);
  const input = inputArg === undefined ? "" : inputArg.startsWith("@") ? await readText(inputArg.slice(1), "--input", c.cwd) : inputArg;
  const metadata = c.flags.metadata === undefined ? undefined : ((await jsonArg(String(c.flags.metadata), "--metadata")) as Record<string, unknown>);

  const calls: { model: string; inputTokens?: number; outputTokens?: number; costUsd?: number }[] = [];
  let g: Grader;
  try {
    const needsModel = spec.kind === "llm" || (spec.kind === CHECKLIST_KIND && (spec as { items?: readonly { check?: unknown }[] }).items?.some((it) => it?.check === undefined) !== false);
    const deps = { env, judgeCache: FileJudgeCache.forEnv(env) };
    const provider = needsModel ? metered(providerFromSpec(spec as LlmProviderSpec, deps), (r) => calls.push(usageRow(r))) : undefined;
    g = await createGrader(spec, { ...deps, ...(provider ? { provider } : {}) });
  } catch (e) {
    throw new UsageError(`Invalid grader: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  let r: Awaited<ReturnType<Grader["grade"]>>;
  try {
    r = await g.grade({ input, output, trace, ...(diff !== undefined ? { diff } : {}), ...(metadata ? { metadata } : {}), signal: c.signal });
  } finally {
    const file = env.CODING_SH_GRADER_USAGE;
    if (file && calls.length) await appendFile(file, calls.map((x) => JSON.stringify({ grader: g.id, ...x })).join("\n") + "\n").catch(() => {});
  }
  const items = (r as Partial<ChecklistVerdict>).items;
  if (out.json) out.data({ grader: g.id, pass: r.pass, score: r.score, reason: r.reason ?? null, items: items ?? null, traceEvents: trace.length, calls });
  else {
    out.print(`${r.pass ? "pass" : "fail"}  ${g.id}  score ${r.score.toFixed(2)}${trace.length ? `  (${trace.length} trace events)` : ""}`);
    for (const it of items ?? []) {
      const a = it.answer === null ? "n/a" : it.answer ? "yes" : "no";
      out.print(`  ${a.padEnd(3)} ${it.critical ? "!" : " "} ${it.id}${it.explanation ? `: ${oneLine(it.explanation, 160)}` : ""}`);
    }
    if (!items && r.reason) out.print(`  ${oneLine(r.reason, 300)}`);
  }
  return r.pass ? 0 : 1;
}

function metered(p: ChatProvider, onCall: (r: ChatResponse) => void): ChatProvider {
  return {
    name: p.name,
    model: p.model,
    params: p.params,
    async complete(req) {
      const res = await p.complete(req);
      onCall(res);
      return res;
    },
  };
}

function usageRow(r: ChatResponse): { model: string; inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const u = { inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens };
  const cost = estimateCost(u, r.model, pricesFor()) ?? estimateCost(u, lookupModel(r.model), pricesFor());
  return { model: r.model, ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}), ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
}

/** A dated model id ("claude-sonnet-5-5-20261001") falls back to its undated price row. */
function lookupModel(model: string): string | undefined {
  return model.replace(/-\d{8}$/, "");
}

async function readText(path: string, what: string, cwd: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch {
    throw new UsageError(`can't read ${what} ${JSON.stringify(path)}`, { reason: "invalid_argument" });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  if (c.action === "grade") return grade(c);
  if (c.action === "slop") return (await import("./judge-slop.ts")).slop(c);
  if (c.action !== "calibrate" && c.action !== "sample") throw new UsageError(`Unknown judge command ${c.action}`);
  const sampling = c.action === "sample";
  const budget = positiveInt(c.flags.budget, "budget");
  if (sampling && budget === undefined) throw new UsageError("Missing --budget <N>: how many cases to plan labels for", { reason: "missing_argument" });
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
    if (judge && !sampling && sampleN === undefined && !stored && !tunedFlag.length) {
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
      // Only the sample plan stratifies on confidence; calibrate keeps its verdicts as before.
      const conf = (g.result as { confidence?: unknown }).confidence;
      if (sampling && typeof conf === "number" && conf >= 0 && conf <= 1) v.confidence = conf;
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

    if (sampling) {
      const seed = num(c.flags.seed) ?? 0;
      if (!(Number.isInteger(seed) && seed >= 0)) throw new UsageError(`--seed must be a non-negative integer, got ${JSON.stringify(c.flags.seed)}`);
      const split = str(c.flags.split) ?? "test";
      if (!SPLITS.includes(split)) throw new UsageError(`--split must be one of ${SPLITS.join(", ")}, got ${JSON.stringify(split)}`);
      // Population: the split's cases this experiment ran (a case with no run has no output to label).
      const ran = new Set(exp.runs.map((r) => r.caseId));
      const population = dataset.cases.filter((cs) => cs.split === split && ran.has(cs.id)).map((cs) => cs.id);
      const labelled = new Set(labels.filter((l) => l.value !== "skip" && (criterion === undefined || l.criterion === undefined || l.criterion === criterion)).map((l) => l.caseId));
      const sessions = new Map<string, string>();
      for (const cs of dataset.cases) if (cs.sourceSessionId) sessions.set(cs.id, cs.sourceSessionId);
      const plan = planAudit({
        verdicts,
        population,
        labelled,
        budget: budget!,
        seed,
        minStratum: positiveInt(c.flags["min-stratum"], "min-stratum") ?? 25,
        sessions,
        experimentId: exp.id,
        graderId: grader.id,
        split,
        ...(criterion ? { criterion } : {}),
      });
      const outFile = str(c.flags.out);
      if (outFile) await writeFile(resolve(c.cwd, outFile), JSON.stringify(plan, null, 2) + "\n");
      if (out.json) out.data({ plan, ...(outFile ? { out: resolve(c.cwd, outFile) } : {}) });
      else out.print(renderAuditPlan(plan, { color: out.color, ...(outFile ? { calibrateCmd: `coding.sh judge calibrate ${expId} --grader ${grader.id} --plan ${outFile}` } : {}) }));
      return 0;
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

    const planFile = str(c.flags.plan);
    if (!judge && planFile) throw new UsageError(`--plan needs an LLM judge; ${grader.id} is a ${grader.kind} grader`, { reason: "invalid_argument" });
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

    const judgeCost = num(c.flags["judge-cost"]);
    if (judgeCost !== undefined && !(judgeCost >= 0 && Number.isFinite(judgeCost))) throw new UsageError(`--judge-cost must be a number of dollars ≥ 0, got ${judgeCost}`, { reason: "invalid_argument" });
    const reportSplit = (str(c.flags.split) ?? "test") as Split;
    const plan = planFile ? await readPlan(resolve(c.cwd, planFile)) : undefined;
    if (plan) {
      const seed = num(c.flags.seed);
      if (plan.experimentId !== undefined && plan.experimentId !== exp.id) throw new UsageError(`--plan was drawn for experiment ${plan.experimentId}, not ${exp.id}`, { reason: "invalid_argument" });
      if (plan.graderId !== undefined && plan.graderId !== grader.id) throw new UsageError(`--plan was drawn for grader ${plan.graderId}, not ${grader.id}`, { reason: "invalid_argument" });
      if (plan.split !== undefined && plan.split !== reportSplit) throw new UsageError(`--plan was drawn from the ${plan.split} split, but the report is on ${reportSplit} (pass --split ${plan.split})`, { reason: "invalid_argument" });
      if (seed !== undefined && seed !== plan.seed) throw new UsageError(`--seed ${seed} does not match the plan's seed ${plan.seed}`, { reason: "invalid_argument" });
    }
    const report = calibrate({
      judge: { id: grader.version, tunedOn, ...(criterion ? { criterion } : {}) },
      labels,
      verdicts,
      splits: dataset,
      reportSplit,
      ...(num(c.flags.threshold) !== undefined ? { kappaThreshold: num(c.flags.threshold)! } : {}),
      ...(num(c.flags["min-n"]) !== undefined ? { minN: num(c.flags["min-n"])! } : {}),
      ...(judgeCost !== undefined ? { judgeCost } : {}),
      ...(plan ? { plan } : {}),
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
