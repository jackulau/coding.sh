// The MCP harness_compare tool's data: harness A/B experiments (`coding.sh
// compare` runs grouped by experiment id) and one experiment's report with the
// ship gate, the one-item gate and the own-tests split. Read-only; the same
// report the CLI prints for `coding.sh compare A B --experiment <id> --gate`.
import type { Context } from "../core/context.ts";
import type { EvalTask, HarnessBundle, RunResult } from "../core/types.ts";
import { gateHeadline } from "../stats/gate.ts";
import { gateLine, itemGateLine, decidingChange, type ArmSummary, type CompareReport } from "../runner/experiment.ts";
import { bundleItemChange, harnessReport, tagPrefixProblem } from "../runner/harness-report.ts";
import type { SelfCheckSummary } from "../runner/selfcheck.ts";
import { clip, iso } from "./data.ts";
import { ToolError } from "./protocol.ts";

type Obj = Record<string, unknown>;

const round = (n: number): number | undefined => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : undefined);
/** Runs that measured the harness: not interrupted, not retried away, not lost to infrastructure. */
const counts = (r: RunResult) => !r.cancelled && !r.superseded && !r.infra;

/** Arm order: A then B, as `compare` recorded it (its job is named "A vs B"); undefined when unrecorded. */
async function recordedOrder(env: NodeJS.ProcessEnv, experimentId: string, bundles: readonly HarnessBundle[]): Promise<[HarnessBundle, HarnessBundle] | undefined> {
  const [x, y] = bundles;
  if (!x || !y) return undefined;
  const { JobStore } = await import("../jobs/store.ts");
  const name = (await JobStore.forEnv(env).get(experimentId).catch(() => undefined))?.header.name;
  if (name === `${x.name} vs ${y.name}`) return [x, y];
  if (name === `${y.name} vs ${x.name}`) return [y, x];
  return undefined;
}

async function bundlesOf(ctx: Context, runs: readonly RunResult[]): Promise<HarnessBundle[]> {
  const ids = [...new Set(runs.map((r) => r.bundleId))];
  const found = await Promise.all(ids.map((id) => ctx.index.getBundle(id)));
  return found.filter((b): b is HarnessBundle => !!b);
}

/** Harness A/B experiments, newest first. */
export async function harnessCompareList(ctx: Context, env: NodeJS.ProcessEnv, offset: number, limit: number): Promise<Obj> {
  const groups = new Map<string, RunResult[]>();
  for (const r of await ctx.index.listRuns()) {
    if (!r.experimentId) continue;
    const g = groups.get(r.experimentId);
    if (g) g.push(r);
    else groups.set(r.experimentId, [r]);
  }
  const latest = (rs: RunResult[]) => Math.max(...rs.map((r) => r.startedAt));
  const sorted = [...groups].sort((p, q) => latest(q[1]) - latest(p[1]) || (p[0] < q[0] ? 1 : -1));
  const page = sorted.slice(offset, offset + limit);
  const experiments = await Promise.all(
    page.map(async ([id, runs]) => {
      const bundles = await bundlesOf(ctx, runs);
      const order = await recordedOrder(env, id, bundles);
      const arm = (b: HarnessBundle) => {
        const rs = runs.filter((r) => r.bundleId === b.id && counts(r));
        return { bundle: b.name, id: b.id, agent: b.agent, runs: rs.length, passes: rs.filter((r) => r.pass).length };
      };
      return {
        id,
        ...(order ? { baseline: order[0].name, candidate: order[1].name } : {}),
        arms: (order ?? bundles).map(arm),
        tasks: new Set(runs.map((r) => r.taskId)).size,
        startedAt: iso(Math.min(...runs.map((r) => r.startedAt))),
      };
    }),
  );
  return { experiments, ...(sorted.length > offset + limit ? { nextCursor: String(offset + limit) } : {}) };
}

const ownTests = (s: SelfCheckSummary) => ({ fails: s.fails, green: s.green, red: s.red, stale: s.stale, none: s.none, unknown: s.unknown });
const armOut = (a: ArmSummary) => ({ bundle: a.name, id: a.bundleId, runs: a.runs, passes: a.passes, passRate: round(a.passRate.p), errors: a.errors });
const tamperArm = (a: ArmSummary) => ({
  runs: a.tampered,
  passes: a.tamperedPasses,
  ...(a.tamperedPassesDisclosed !== undefined ? { disclosed: a.tamperedPassesDisclosed, stealth: a.tamperedPassesStealth ?? 0 } : {}),
});

/** Tamper-flagged runs per arm and each tampered pass linked to the tool call that changed the test (absent when no run tampered). */
function tamperOut(r: CompareReport, n: number): Obj | undefined {
  if (!r.baseline.tampered && !r.candidate.tampered) return undefined;
  const passes = Object.entries(r.tamperAttribution ?? {})
    .filter(([, x]) => x.pass)
    .slice(0, n)
    .map(([run, x]) => {
      const c = decidingChange(x);
      const f = c?.finding;
      return {
        run,
        arm: x.arm,
        task: x.taskId,
        disclosure: x.disclosure,
        ...(c ? { change: `${c.kind} ${c.path}` } : {}),
        ...(f ? { tool: f.tool ?? f.via, eventId: f.eventId, ...(f.intent ? { intent: f.intent } : {}) } : {}),
      };
    });
  return { baseline: tamperArm(r.baseline), candidate: tamperArm(r.candidate), ...(passes.length ? { passes } : {}) };
}

/** One harness A/B experiment: pass rates, the ship gate (per task group with `by`), the one-item gate and the own-tests split. */
export async function harnessCompareGet(ctx: Context, env: NodeJS.ProcessEnv, experimentId: string, o: { baseline?: string; by?: string; limit: number }): Promise<Obj> {
  const runs = await ctx.index.listRuns({ experimentId });
  if (!runs.length) throw new ToolError(`No harness A/B experiment ${JSON.stringify(experimentId)}. List them with harness_compare and no experiment.`);
  const bundles = await bundlesOf(ctx, runs);
  if (bundles.length !== 2) throw new ToolError(`Experiment ${experimentId} has ${bundles.length} stored bundle(s), not the 2 arms of an A/B.`);
  let order = await recordedOrder(env, experimentId, bundles);
  if (o.baseline) {
    const a = bundles.find((b) => b.id === o.baseline || b.name === o.baseline);
    if (!a) throw new ToolError(`baseline ${JSON.stringify(o.baseline)} is neither arm of ${experimentId}: ${bundles.map((b) => b.name).join(", ")}.`);
    order = [a, bundles.find((b) => b !== a) as HarnessBundle];
  }
  if (!order) throw new ToolError(`Experiment ${experimentId} doesn't record which arm is A: pass baseline, ${bundles.map((b) => b.name).join(" or ")}.`);
  const [A, B] = order;
  let taskTags: Map<string, string[]> | undefined;
  if (o.by) {
    const tasks = (await Promise.all([...new Set(runs.map((r) => r.taskId))].map((id) => ctx.index.getTask(id)))).filter((t): t is EvalTask => !!t);
    const problem = tagPrefixProblem(tasks, o.by);
    if (problem) throw new ToolError(`by ${o.by}: ${problem}.`);
    taskTags = new Map(tasks.map((t) => [t.id, t.tags]));
  }
  const change = bundleItemChange(A, B);
  const r = await harnessReport(ctx, A, B, runs, { iters: 2000, gate: {}, ...(o.by ? { gateBy: o.by, taskTags } : {}), ...(change ? { change } : {}) });
  const n = o.limit;
  const g = r.gate;
  const ig = r.itemGate;
  const files = r.bundleDiff?.files;
  const tamper = tamperOut(r, n);
  return {
    experimentId,
    baseline: armOut(r.baseline),
    candidate: armOut(r.candidate),
    pairedTasks: r.pairedTasks,
    k: r.k,
    diff: { mean: round(r.diff.mean), lo: round(r.diff.lo), hi: round(r.diff.hi) },
    verdict: clip(r.verdict.text, 300),
    ...(g
      ? {
          gate: {
            verdict: g.verdict,
            summary: gateLine(g, r.ablation),
            wins: g.wins,
            losses: g.losses,
            solved: g.solved,
            p: round(g.p),
            reasons: g.reasons,
            lostTasks: g.lost.slice(0, n),
            ...(g.strata ? { strata: g.strata.slice(0, n).map((s) => ({ group: s.group, tasks: s.tasks, verdict: s.gate.verdict, summary: gateHeadline(s.gate, "task") })) } : {}),
            ...(g.blockedBy?.length ? { blockedBy: g.blockedBy } : {}),
          },
        }
      : {}),
    ...(ig
      ? {
          itemGate: {
            verdict: ig.verdict,
            summary: itemGateLine(ig),
            mode: ig.mode,
            ...(ig.item ? { item: ig.item } : {}),
            G: round(ig.G),
            netRuns: ig.kN,
            D: round(ig.D),
            fired: ig.f.fired,
            rollouts: ig.f.rollouts,
            exposedTasks: ig.S.slice(0, n),
            reasons: ig.reasons,
            ...(ig.recheck?.length ? { recheck: ig.recheck.slice(0, n) } : {}),
          },
        }
      : {}),
    ownTests: { baseline: ownTests(r.baseline.selfCheck), candidate: ownTests(r.candidate.selfCheck) },
    ...(tamper ? { tamper } : {}),
    ...(files ? { changes: { added: files.added.slice(0, n), removed: files.removed.slice(0, n), changed: files.changed.slice(0, n) } } : {}),
    warnings: [...r.power.warnings.map((w) => w.message), ...r.notes].slice(0, n),
  };
}
