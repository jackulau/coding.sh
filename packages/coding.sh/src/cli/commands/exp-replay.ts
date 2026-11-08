// coding.sh exp replay <call...> --vary key=a[,b]: replays logged model calls
// (coding.sh proxy) against the real API, A and B interleaved, n times each,
// grades each reply (by default: does it take the same first action the agent
// took?) and compares the arms with the paired statistics of `exp compare`.
// Uses the user's own API key; never the agent's stored auth (none is stored).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import { pricesFor } from "../../core/pricing.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { datasetVersion, slugify } from "../../datasets/dataset.ts";
import type { FileEvalStore } from "../../datasets/store.ts";
import type { Case, Dataset, ExperimentResult, Grader } from "../../datasets/types.ts";
import { compareExperiments } from "../../experiments/compare.ts";
import { renderComparison } from "../../experiments/render.ts";
import { estimateReplay, parseVary, REPLAY_KEY_ENV, replayable, replayCaseOf, replayTask, sameActionGrader, type ReplayArm, type ReplayCase, type ReplayOutput } from "../../experiments/replay.ts";
import { createGrader, type GraderSpec, type LlmGraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { loadCall } from "../../proxy/calls.ts";
import { proxySettings } from "../../proxy/state.ts";
import { positiveInt, UsageError } from "../args.ts";
import { jsonArg, list, num, str } from "../common.ts";
import { resumeField, resumeNote } from "../jobs.ts";
import { CliError, plural, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { callOrFail } from "./diff-calls.ts";
import { cancelledWarning, runArms } from "./exp.ts";

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : usd(n));

async function gather(c: CommandContext, ctx: Context): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for (const ref of c.positionals) events.push(await callOrFail(ctx.index, ref));
  const session = str(c.flags.session);
  if (session) {
    const first = await callOrFail(ctx.index, `${session}#1`);
    const limit = positiveInt(c.flags.limit, "limit") ?? 20;
    const calls = (await ctx.index.listEvents(first.sessionId, { kinds: ["llm.call"] })).filter((e) => e.source === "proxy" && e.payload.api !== "count_tokens");
    events.push(...calls.slice(-limit));
  }
  if (!events.length) throw new UsageError("Name the calls to replay, e.g. coding.sh exp replay latest#-1, or --session <id>", { reason: "missing_argument" });
  const seen = new Set<string>();
  return events.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

async function graders(c: CommandContext, providers: Set<string>): Promise<Grader[]> {
  const out: Grader[] = [sameActionGrader()];
  const specs = (await Promise.all(list(c.flags.grader).map((g) => jsonArg(g, "--grader")))) as GraderSpec[];
  const criterion = str(c.flags.criterion);
  if (criterion) {
    const anthropic = providers.has("anthropic") || !providers.has("openai");
    const spec: LlmGraderSpec = { kind: "llm", name: "judge", rubric: criterion, provider: anthropic ? "anthropic" : "openai", ...(str(c.flags["judge-model"]) ? { model: str(c.flags["judge-model"])! } : {}) };
    specs.push(spec);
  }
  try {
    for (const s of specs) out.push(await createGrader(s, { baseDir: c.cwd, env: c.env, judgeCache: FileJudgeCache.forEnv(c.env) }));
  } catch (e) {
    throw new UsageError(`Invalid grader: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_grader" });
  }
  return out;
}

/** Mean of a number field over an arm's finished runs. */
function meanOf(e: ExperimentResult, pick: (o: ReplayOutput) => number | undefined): number | undefined {
  const xs = e.runs.map((r) => (r.output && typeof r.output === "object" ? pick(r.output as ReplayOutput) : undefined)).filter((x): x is number => typeof x === "number");
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
}

/** "Bash ×4, text ×1": the first actions an arm took over a case's trials. */
function actions(e: ExperimentResult, caseId: string): string {
  const counts = new Map<string, number>();
  for (const r of e.runs) {
    if (r.caseId !== caseId) continue;
    const a = r.output && typeof r.output === "object" ? (r.output as ReplayOutput).action : undefined;
    const k = r.error ? "error" : !a ? "?" : a.type === "tool" ? (a.name ?? "tool") : a.type;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
}

export async function expReplay(c: CommandContext, store: FileEvalStore, ctx: Context): Promise<number> {
  const { out } = c;
  const n = positiveInt(c.flags.n, "n") ?? 5;
  const concurrency = positiveInt(c.flags.concurrency, "concurrency") ?? 4;
  const maxCost = num(c.flags["max-cost"]);
  const dryRun = c.flags["dry-run"] === true;
  let arms: [ReplayArm, ReplayArm];
  try {
    arms = parseVary(list(c.flags.vary), (p) => readFileSync(resolve(c.cwd, p), "utf8"));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e), { reason: "invalid_argument" });
  }

  const events = await gather(c, ctx);
  const cases: ReplayCase[] = [];
  const skipped: string[] = [];
  for (const e of events) {
    const r = replayable(await loadCall(ctx.blobs, e));
    if (typeof r === "string") skipped.push(r);
    else cases.push(r);
  }
  if (!cases.length) throw new CliError("None of these calls can be replayed", { reason: "not_replayable", details: skipped.map((s): [string, string] => ["skipped", s]), next: ["Replay needs calls logged by coding.sh proxy with capture mode full:", "coding.sh config get capture.mode"] });
  for (const s of skipped) out.warn(`skipped ${s}`);
  const unrecorded = cases.filter((x) => !x.recorded).length;
  if (unrecorded) out.warn(`${plural(unrecorded, "call")} had no recorded reply to compare with; same-action leaves ${unrecorded === 1 ? "it" : "them"} ungraded`);

  const prices = pricesFor(ctx.config.pricing);
  const est = estimateReplay(cases, arms, n, prices);
  const estText = est.usd === undefined ? `cost unknown (no price for ${est.unpriced.join(", ")})` : `~${money(est.usd)}`;
  const providers = new Set(cases.map((x) => x.provider));
  if (dryRun) {
    if (out.json) {
      out.data({ dryRun: true, calls: cases.map((x) => x.call.event.id), skipped, arms: { a: arms[0].label, b: arms[1].label }, n, estimate: est });
      return 0;
    }
    out.print(`${plural(cases.length, "call")} × 2 arms × ${n}: ${plural(est.calls, "model call")}, ~${Math.round(est.inputTokens / 1000)}k input tokens, ${estText} (input uncached, output as recorded)`);
    out.print(`A ${arms[0].label}`);
    out.print(`B ${arms[1].label}`);
    for (const p of providers) if (!c.env[REPLAY_KEY_ENV[p]]) out.print(`needs $${REPLAY_KEY_ENV[p]} to run`);
    return 0;
  }
  for (const p of providers) {
    const key = REPLAY_KEY_ENV[p];
    if (!c.env[key]?.trim()) {
      throw new CliError(`exp replay calls the ${p === "anthropic" ? "Anthropic" : "OpenAI"} API with your own key, and $${key} is not set`, {
        reason: "missing_api_key",
        next: [`export ${key}=…   (the agent's own login is never stored, so it can't be reused)`, "See the cost first: coding.sh exp replay … --dry-run"],
      });
    }
  }
  if (maxCost !== undefined && est.usd !== undefined && est.usd > maxCost) {
    throw new CliError(`Estimated cost ${money(est.usd)} is over --max-cost ${money(maxCost)}`, { reason: "over_budget", next: ["Replay fewer calls or trials, or raise the cap:", `coding.sh exp replay … --n ${Math.max(1, Math.floor((n * maxCost) / est.usd))}`] });
  }
  if (!out.json) out.note(`${plural(est.calls, "model call")}, estimated ${estText}`);

  const settings = proxySettings(c.env);
  const upstream = str(c.flags.upstream);
  const upstreams = { anthropic: upstream ?? settings.upstreams.anthropic, openai: upstream ?? settings.upstreams.openai };
  const byId = new Map(cases.map((x) => [x.call.event.id, x]));
  const dsCases: Case[] = cases.map(replayCaseOf);
  const name = str(c.flags.name) ?? `replay-${cases[0]!.call.event.id.slice(0, 8)}${cases.length > 1 ? `-${cases.length}` : ""}`;
  const dataset: Dataset = { id: slugify(name), name, version: datasetVersion(dsCases), cases: dsCases, createdAt: Date.now() };
  await store.putDataset(dataset);
  const loaded = { spec: { trials: n, concurrency }, dataset, graders: await graders(c, providers), name };
  const task = (arm: ReplayArm) => replayTask({ cases: byId, arm, upstreams, env: c.env, prices });
  const { result: ab, job } = await runArms(c, store, loaded, [{ name: "a", task: task(arms[0]) }, { name: "b", task: task(arms[1]) }], "exp replay");
  if (ab.a.status === "cancelled") {
    cancelledWarning(c, ab.a);
    resumeNote(c, job);
    return 1;
  }
  const cmp = compareExperiments(ab.a, ab.b, { force: true });
  const side = (e: ExperimentResult) => ({
    costUsd: meanOf(e, (o) => o.costUsd),
    outputTokens: meanOf(e, (o) => o.usage?.outputTokens),
    latencyMs: e.runs.length ? e.runs.reduce((s, r) => s + r.latencyMs, 0) / e.runs.length : undefined,
  });
  const sa = side(ab.a);
  const sb = side(ab.b);
  if (out.json) {
    out.data({ calls: cases.map((x) => x.call.event.id), skipped, arms: { a: arms[0].label, b: arms[1].label }, n, experiments: { a: ab.a.id, b: ab.b.id }, perCall: { a: sa, b: sb }, comparison: cmp, ...resumeField(job) });
    return 0;
  }
  out.print(`A ${arms[0].label}   B ${arms[1].label}   ${plural(cases.length, "call")} × ${n}`);
  const fmt = (s: ReturnType<typeof side>) => `${s.costUsd === undefined ? "cost ?" : money(s.costUsd)}/call  ${s.outputTokens === undefined ? "" : `${Math.round(s.outputTokens)} out tokens  `}${s.latencyMs === undefined ? "" : `${(s.latencyMs / 1000).toFixed(1)}s`}`;
  out.print(`  A ${fmt(sa)}`);
  out.print(`  B ${fmt(sb)}`);
  out.print("");
  out.print(renderComparison(cmp, { color: out.color, a: ab.a, b: ab.b }));
  out.print("");
  out.print("First action per call (recorded → A | B):");
  for (const x of cases.slice(0, 20)) {
    const rec = x.recorded ? (x.recorded.type === "tool" ? (x.recorded.name ?? "tool") : x.recorded.type) : "?";
    out.print(`  ${x.call.event.id.slice(0, 12)}  ${rec} → ${actions(ab.a, x.call.event.id)} | ${actions(ab.b, x.call.event.id)}`);
  }
  out.print("");
  out.print(`Full comparison: coding.sh exp compare ${ab.a.id} ${ab.b.id}`);
  resumeNote(c, job);
  return 0;
}
