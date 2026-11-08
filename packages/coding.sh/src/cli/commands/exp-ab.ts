// `coding.sh exp ab`: A/B a harness edit (CLAUDE.md, AGENTS.md, a rule, a
// skill) on the decision points where your agent recently went wrong (X-3).
// It mines the cases from captured sessions (eval/decision.ts), asks the model
// for each case's next turn under arm A's and arm B's files
// (experiments/continuation.ts), grades both with the per-case rubric, and
// compares them with the same machinery as `exp run --arm` and `exp compare`:
// the interleaved durable runner (resume, retries), the acceptance gate, the
// one-item gate and the EM-19 replay noise floor.
import { HARNESS_DIRS, HARNESS_PATHSPECS, isHarnessPath } from "../../core/harness-paths.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { harnessItem, itemExposure, type ExposureState } from "../../core/exposure.ts";
import { nativeRoot } from "../../core/git.ts";
import { DEFAULT_MODELS, lookupPrice, pricesFor } from "../../core/pricing.ts";
import type { Context } from "../../core/context.ts";
import type { RunResult } from "../../core/types.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import type { Case, CaseRun, Dataset, Grader } from "../../datasets/types.ts";
import { BUILTIN_ANCHORS, buildDecisionDataset, caseSession, loadAnchor, type Anchor, type DecisionDataset } from "../../eval/decision.ts";
import type { AbResult } from "../../experiments/ab.ts";
import type { Job } from "../../jobs/store.ts";
import type { GateOpts } from "../../stats/tests.ts";
import { compareExperiments, type Comparison } from "../../experiments/compare.ts";
import { missingModelKey, planContinuation, prefixEvents, replayNoise, type ContextFile, type ContinuationProvider, type ContinuationTask, type FrozenPrefix } from "../../experiments/continuation.ts";
import { createGrader, providerFromSpec, type LlmGraderSpec } from "../../graders/index.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import type { ChatProvider } from "../../judge/providers.ts";
import { autoCliProvider, CLI_DEFAULT_MODEL, CLI_PLAN, CLI_PROVIDERS, cliLimiter, cliLogin, isCliProvider, LOGIN_HINT, type CliProvider } from "../../judge/subscription.ts";
import { itemGate, singleItemChange } from "../../runner/gate-item.ts";
import { itemGateLine } from "../../runner/experiment.ts";
import { checkProtected, type ProtectCheck } from "../../refine/protect.ts";
import { gateHeadline } from "../../stats/gate.ts";
import { parseSince, positiveInt, suggest, UsageError } from "../args.ts";
import { autoIngest, gateFlags, jsonArg, list, num, readIngest, str } from "../common.ts";
import { resumeField, resumeNote } from "../jobs.ts";
import { protectJson, protectOptions, protectOverrides, rejectionLines } from "../protect.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { cancelledWarning, runArms } from "./exp.ts";

/** The spec file's fields; flags override them. */
export interface AbSpec {
  behavior?: string | string[];
  anchor?: string | string[];
  since?: string;
  agent?: string | string[];
  repo?: string;
  limit?: number;
  a?: string;
  b?: string;
  provider?: ContinuationProvider;
  model?: string;
  judgeModel?: string;
  baseURL?: string;
  trials?: number;
  concurrency?: number;
  maxCost?: number;
}

export interface AbOptions {
  behaviors: string[];
  anchorFiles: string[];
  since: number;
  sinceText: string;
  agents: string[];
  /** Only sessions under this directory; undefined: every repo. */
  repo: string | undefined;
  limit: number;
  a?: string;
  b?: string;
  provider: ContinuationProvider;
  model?: string;
  judgeModel?: string;
  baseURL?: string;
  trials: number;
  concurrency: number;
  maxCost?: number;
  watch: boolean;
  dryRun: boolean;
  cache: boolean;
  /** Set when no --provider was given and no API key is: the logged-in CLI that was picked, and the line that says so. */
  autoProvider?: string;
}

/** One arm's harness: its context files, what to call it, and what to watch. */
export interface Arm {
  label: string;
  files: ContextFile[];
  /** Directories whose changes can change this arm (empty: nothing to watch). */
  watch: { dir: string; recursive: boolean }[];
}

const PROVIDERS: readonly ContinuationProvider[] = ["anthropic", "openai", "openai-compatible", ...CLI_PROVIDERS];
const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean));

// ---------------------------------------------------------------- arms

export { isHarnessPath };

function walk(dir: string, base: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const abs = join(dir, n);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, base, out, depth + 1);
    else if (st.isFile()) out.push(relative(base, abs).replace(/\\/g, "/"));
  }
}

/** The harness files in a directory (a repo or an exported harness). */
export function harnessFilesIn(dir: string): ContextFile[] {
  const rels: string[] = [];
  for (const n of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) if (existsSync(join(dir, n)) && statSync(join(dir, n)).isFile()) rels.push(n);
  for (const d of HARNESS_DIRS) walk(join(dir, d), dir, rels);
  return rels.filter(isHarnessPath).map((p) => ({ path: p, text: readFileSync(join(dir, p), "utf8") }));
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** The work-tree root as a native path (git prints C:/… on Windows; session cwds use C:\…). */
export function gitRoot(cwd: string): string | undefined {
  const [root, prefix] = (git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"]) ?? "").split("\n").map((l) => l.trim());
  return root ? nativeRoot(cwd, root, prefix) : undefined;
}

/** The harness files at a git revision. */
function harnessAtRev(root: string, rev: string): ContextFile[] | undefined {
  const names = git(root, ["ls-tree", "-r", "--name-only", rev, "--"]);
  if (names === undefined) return undefined;
  return names
    .split("\n")
    .filter((p) => p && isHarnessPath(p))
    .map((p) => ({ path: p, text: git(root, ["show", `${rev}:${p}`]) ?? "" }));
}

const byPath = (a: ContextFile, b: ContextFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
export const sameFiles = (x: readonly ContextFile[], y: readonly ContextFile[]): boolean =>
  x.length === y.length && [...x].sort(byPath).every((f, i) => f.path === [...y].sort(byPath)[i]!.path && f.text === [...y].sort(byPath)[i]!.text);

/**
 * One arm from its flag value:
 * - `none`: no harness files;
 * - `git:<rev>`: the harness files committed at that revision;
 * - a directory: its CLAUDE.md, AGENTS.md, GEMINI.md, rules and skills;
 * - a file: `base` with that file swapped in (or added) under its repo path,
 *   or its name when it lives outside the repo;
 * - a harness bundle id or name (`coding.sh harness list`).
 */
export async function resolveArm(v: string, o: { cwd: string; root: string; base: ContextFile[]; flag: string; ctx: Pick<Context, "index" | "blobs"> }): Promise<Arm> {
  if (v === "none") return { label: "none", files: [], watch: [] };
  if (v.startsWith("git:")) {
    const rev = v.slice(4) || "HEAD";
    const files = harnessAtRev(o.root, rev);
    if (!files) throw new UsageError(`--${o.flag} ${v}: can't read revision ${JSON.stringify(rev)} in ${o.root}`, { reason: "invalid_argument", suggestion: `--${o.flag} git:HEAD` });
    return { label: v, files, watch: [] };
  }
  const abs = resolve(o.cwd, v);
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) {
      const files = harnessFilesIn(abs);
      if (!files.length) throw new UsageError(`--${o.flag} ${v}: no CLAUDE.md, AGENTS.md, rules or skills in that directory`, { reason: "invalid_argument" });
      return { label: v, files, watch: [{ dir: abs, recursive: true }] };
    }
    const rel = relative(o.root, abs).replace(/\\/g, "/");
    const path = !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(abs);
    const text = readFileSync(abs, "utf8");
    return { label: v, files: [...o.base.filter((f) => f.path !== path), { path, text }].sort(byPath), watch: [{ dir: dirname(abs), recursive: false }] };
  }
  const bundle = await o.ctx.index.getBundle(v).catch(() => undefined);
  if (bundle) {
    const files: ContextFile[] = [];
    for (const [p, ref] of Object.entries(bundle.files).sort()) {
      const path = p.replace(/^~\//, "");
      if (!isHarnessPath(path) && !harnessItem(path, "")) continue;
      files.push({ path, text: (await o.ctx.blobs.getText(ref)) ?? "" });
    }
    return { label: `bundle ${bundle.name}`, files, watch: [] };
  }
  const near = suggest(basename(v), harnessFilesIn(o.root).map((f) => f.path));
  throw new UsageError(`--${o.flag} ${v}: no such file, directory or harness bundle`, {
    reason: "invalid_argument",
    ...(near ? { suggestion: `--${o.flag} ${near}` } : { suggestion: `--${o.flag} <file|dir|git:REV|bundle|none>` }),
  });
}

/** The newest commit at or before HEAD that changed a harness file, with its parent; undefined when there is none or it has no parent. */
export function lastHarnessCommit(root: string): { commit: string; short: string; subject: string } | undefined {
  const line = git(root, ["log", "-1", "--format=%H%x00%h%x00%s", "HEAD", "--", ...HARNESS_PATHSPECS])?.trim();
  if (!line) return undefined;
  const [commit, short, subject] = line.split("\0") as [string, string, string];
  return git(root, ["rev-parse", "--verify", "--quiet", `${commit}^`]) === undefined ? undefined : { commit, short, subject };
}

/**
 * Both arms, with the defaults: no flags compares git HEAD with your
 * uncommitted edits, or, with none, the last commit that changed a harness
 * file with the version before it; a lone --b runs against the repo's current files.
 */
async function resolveArms(o: AbOptions, c: CommandContext, root: string, inGit: boolean, ctx: Pick<Context, "index" | "blobs">): Promise<[Arm, Arm, string?]> {
  const current = harnessFilesIn(root);
  const currentArm: Arm = {
    label: "current files",
    files: current,
    watch: [{ dir: root, recursive: false }, ...HARNESS_DIRS.map((d) => ({ dir: join(root, d), recursive: true }))],
  };
  if (o.a === undefined && o.b === undefined) {
    if (!inGit) throw new UsageError("Not in a git repo: pass the harness to test with --b <file|dir>", { reason: "missing_argument", suggestion: "coding.sh exp ab --b ./CLAUDE.md" });
    const head = harnessAtRev(root, "HEAD") ?? [];
    if (!sameFiles(head, current)) return [{ label: "git:HEAD", files: head, watch: [] }, { ...currentArm, label: "your edits" }];
    // Already committed: test the last harness commit against the version before it.
    const last = lastHarnessCommit(root);
    const before = last ? harnessAtRev(root, `${last.commit}^`) : undefined;
    if (!last || !before || sameFiles(before, head)) {
      throw new UsageError("No uncommitted changes to CLAUDE.md, AGENTS.md, rules or skills, and no earlier commit to compare with: edit one first, or pass the versions with --a and --b", {
        reason: "missing_argument",
        suggestion: "coding.sh exp ab --b ./candidate/CLAUDE.md",
      });
    }
    return [
      { label: `git:${last.short}^`, files: before, watch: [] },
      { label: `git:HEAD`, files: head, watch: [] },
      `No uncommitted edits: testing your last harness commit ${last.short} "${last.subject}" (B) against the version before it (A)`,
    ];
  }
  const a = o.a === undefined ? currentArm : await resolveArm(o.a, { cwd: c.cwd, root, base: current, flag: "a", ctx });
  const b = o.b === undefined ? currentArm : await resolveArm(o.b, { cwd: c.cwd, root, base: a.files, flag: "b", ctx });
  if (sameFiles(a.files, b.files)) {
    throw new UsageError(`A (${a.label}) and B (${b.label}) have the same harness files: nothing to compare`, {
      reason: "invalid_argument",
      ...(inGit && o.a === undefined ? { suggestion: "coding.sh exp ab (no --b: compares git HEAD with your uncommitted edits)" } : {}),
    });
  }
  return [a, b];
}

/** What changed from A to B, for the one-item gate: added and removed paths, and whether any shared file changed. */
function fileDiff(a: readonly ContextFile[], b: readonly ContextFile[]): { added: string[]; removed: string[]; changed: string[] } {
  const ma = new Map(a.map((f) => [f.path, f.text]));
  const mb = new Map(b.map((f) => [f.path, f.text]));
  return {
    added: [...mb.keys()].filter((p) => !ma.has(p)).sort(),
    removed: [...ma.keys()].filter((p) => !mb.has(p)).sort(),
    changed: [...mb.keys()].filter((p) => ma.has(p) && ma.get(p) !== mb.get(p)).sort(),
  };
}

// ---------------------------------------------------------------- options

async function options(c: CommandContext, root: string | undefined): Promise<AbOptions> {
  let spec: AbSpec = {};
  const file = c.positionals[0];
  if (file) {
    const v = await jsonArg(resolve(c.cwd, file), "spec");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new UsageError(`${file} must hold a JSON object`, { reason: "invalid_argument" });
    spec = v as AbSpec;
  }
  return abOptions(c, root, spec);
}

/** The decision-point trial options from flags over a spec (`exp ab`; `refine test` passes no spec). */
export function abOptions(c: CommandContext, root: string | undefined, spec: AbSpec = {}): AbOptions {
  const f = c.flags;
  const behaviors = list(f.behavior).length ? asList(list(f.behavior)) : asList(spec.behavior);
  const anchorFiles = list(f.anchor).length ? list(f.anchor) : asList(spec.anchor);
  const sinceText = str(f.since) ?? spec.since ?? "14d";
  const repoFlag = str(f.repo) ?? spec.repo;
  const asked = (str(f.provider) ?? spec.provider) as ContinuationProvider | undefined;
  if (asked !== undefined && !PROVIDERS.includes(asked)) throw new UsageError(`--provider must be one of ${PROVIDERS.join(", ")}`, { reason: "invalid_argument" });
  const agentsFor = list(f.agent).length ? asList(list(f.agent)) : asList(spec.agent);
  // No provider and no API key: a logged-in Claude Code or Codex answers on its subscription.
  const auto = asked === undefined && !(str(f["base-url"]) ?? spec.baseURL) ? autoCliProvider(c.env, agentsFor.length && agentsFor.every((a) => a === "codex") ? "codex" : undefined) : undefined;
  const provider: ContinuationProvider = asked ?? auto?.provider ?? "anthropic";
  const maxCost = num(f["max-cost"]) ?? spec.maxCost;
  if (maxCost !== undefined && !(maxCost >= 0)) throw new UsageError(`--max-cost must be a dollar amount of at least 0, got ${maxCost}`, { reason: "invalid_argument" });
  const o: AbOptions = {
    behaviors,
    anchorFiles,
    since: parseSince(sinceText),
    sinceText,
    agents: agentsFor,
    repo: repoFlag === "all" ? undefined : repoFlag ? resolve(c.cwd, repoFlag) : (root ?? c.cwd),
    limit: positiveInt(f.limit, "limit") ?? spec.limit ?? 40,
    provider,
    trials: positiveInt(f.trials, "trials") ?? spec.trials ?? 1,
    // A subscription CLI starts a process per call and has tighter rate limits: two at a time unless asked.
    concurrency: positiveInt(f.concurrency, "concurrency") ?? spec.concurrency ?? (isCliProvider(provider) ? 2 : 4),
    watch: f.watch === true,
    dryRun: f["dry-run"] === true,
    cache: f["no-cache"] !== true && f.cache !== false,
  };
  const a = str(f.a) ?? spec.a;
  const b = str(f.b) ?? spec.b;
  const model = str(f.model) ?? spec.model;
  const judgeModel = str(f["judge-model"]) ?? spec.judgeModel;
  const baseURL = str(f["base-url"]) ?? spec.baseURL;
  if (a !== undefined) o.a = a;
  if (b !== undefined) o.b = b;
  if (model) o.model = model;
  if (judgeModel) o.judgeModel = judgeModel;
  if (baseURL) o.baseURL = baseURL;
  if (maxCost !== undefined) o.maxCost = maxCost;
  if (auto) o.autoProvider = `No API key set: replaying through ${auto.provider === "codex" ? "`codex exec`" : "`claude -p`"} on your ${CLI_PLAN[auto.provider]} (${auto.how}); costs are API-equivalent`;
  if (o.watch && o.dryRun) throw new UsageError("--watch and --dry-run don't go together", { reason: "invalid_argument" });
  if (o.watch && c.out.json) throw new UsageError("--watch prints a line per run; it does not combine with --json", { reason: "invalid_argument" });
  return o;
}

export async function pickAnchors(o: AbOptions, cwd: string): Promise<Anchor[]> {
  const loaded: Anchor[] = [];
  for (const f of o.anchorFiles) {
    try {
      loaded.push(...(await loadAnchor(f, cwd)));
    } catch (e) {
      throw new UsageError(`--anchor ${f}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_argument" });
    }
  }
  const known = [...BUILTIN_ANCHORS, ...loaded];
  if (!o.behaviors.length) return loaded.length ? loaded : [...BUILTIN_ANCHORS];
  return o.behaviors.map((b) => {
    const hit = known.find((a) => a.id === b);
    if (hit) return hit;
    const near = suggest(b, known.map((a) => a.id));
    throw new UsageError(`Unknown behavior ${JSON.stringify(b)} (known: ${known.map((a) => a.id).join(", ")})`, { reason: "invalid_argument", suggestion: `--behavior ${near ?? known[0]!.id}` });
  });
}

// ---------------------------------------------------------------- judge and cost

/** The decision-point judge: it applies each case's own rubric (the case's expected value) to the next turn. */
export const DECISION_JUDGE_RUBRIC = `Apply the per-instance rubric in <expected> to the agent's next turn in <output>, given the conversation so far in <trace>. The rubric scores the turn from 0 to 5.
Report that score divided by 5 as "score" (4 of 5 is 0.8), and set "pass" to true only for 4 or 5.
Tool calls in <output> are what the agent chose to do next; they have not run yet.`;

export const DECISION_JUDGE_TEMPLATE = `Criterion: {{criterion}}

Rubric:
{{rubric}}

{{trace}}

{{output}}

{{expected}}

Score the output against the per-instance rubric in <expected>. Cite the passages that decided your verdict.`;

/** What one iteration spent: continuation calls (cached or not) and judge calls. */
export interface Spend {
  calls: number;
  cached: number;
  usd: number;
  /** Calls whose model had no price: the dollar figure is a lower bound. */
  unpriced: number;
  judgeCalls: number;
  judgeUsd: number;
}

export const newSpend = (): Spend => ({ calls: 0, cached: 0, usd: 0, unpriced: 0, judgeCalls: 0, judgeUsd: 0 });

/** The provider with each call counted and priced. */
export function metered(p: ChatProvider, spend: Spend, onSpend: () => void): ChatProvider {
  const prices = pricesFor();
  return {
    name: p.name,
    model: p.model,
    params: p.params,
    async complete(req) {
      const res = await p.complete(req);
      spend.judgeCalls++;
      const price = lookupPrice(res.model, prices) ?? lookupPrice(p.model, prices);
      if (price && res.usage) spend.judgeUsd += ((res.usage.inputTokens ?? 0) * price.input + (res.usage.outputTokens ?? 0) * price.output) / 1e6;
      onSpend();
      return res;
    },
  };
}

/** The judge sees the turn itself (text and tool calls), never usage or model names, so equal turns share a cached verdict across arms. */
export function turnOnly(g: Grader): Grader {
  return {
    ...g,
    grade(ctx) {
      const o = ctx.output && typeof ctx.output === "object" ? (ctx.output as Record<string, unknown>) : {};
      // Without the call ids, which are new on every response: the same turn gets the same (cached) verdict.
      const calls = Array.isArray(o.toolCalls) ? (o.toolCalls as { name?: unknown; input?: unknown }[]).map((c) => ({ name: c.name, input: c.input })) : [];
      return g.grade({ ...ctx, output: { text: o.text ?? "", toolCalls: calls } });
    },
  };
}

export function judgeSpec(o: AbOptions, base: string): LlmGraderSpec {
  return {
    kind: "llm",
    name: "decision-point",
    rubric: DECISION_JUDGE_RUBRIC,
    template: DECISION_JUDGE_TEMPLATE,
    passThreshold: 0.8,
    provider: o.provider === "anthropic" || isCliProvider(o.provider) ? o.provider : "openai",
    ...(o.judgeModel ? { model: o.judgeModel } : o.model ? { model: o.model } : {}),
    ...(base ? { baseURL: base } : {}),
    ...(o.provider === "openai-compatible" && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/.test(base) ? { requireKey: false } : {}),
  };
}

/** The API base URL; "" for a subscription CLI. */
export function baseURLFor(o: AbOptions, env: NodeJS.ProcessEnv): string {
  if (isCliProvider(o.provider)) return "";
  const fromEnv = o.provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  return (o.baseURL ?? (fromEnv?.trim() || (o.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"))).replace(/\/+$/, "");
}

/** A recorded model id as this provider's API takes it, or undefined when the provider can't serve it. */
function servedAs(provider: ContinuationProvider, model: string): string | undefined {
  if (provider === "openai-compatible") return model;
  const bare = model.replace(/^(?:anthropic|openai)\//, "");
  if (provider === "anthropic" || provider === "claude-code") return /^claude-/.test(bare) ? bare : undefined;
  return /^(?:gpt-|o\d|codex-)/.test(bare) ? bare : undefined;
}

/** A provider's default model: the API's current one, or what its CLI is told to use. */
export function providerDefaultModel(provider: ContinuationProvider): string | undefined {
  if (isCliProvider(provider)) return CLI_DEFAULT_MODEL[provider];
  return provider === "openai-compatible" ? undefined : DEFAULT_MODELS[provider];
}

/**
 * The model the decision points were recorded with (the most common one this provider can serve,
 * so Codex cases don't pick an Anthropic model), else the provider's current default.
 */
export function defaultModel(provider: ContinuationProvider, cases: readonly Case[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of cases) {
    const m = typeof c.metadata?.model === "string" ? servedAs(provider, c.metadata.model) : undefined;
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const top = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
  return top?.[0] ?? providerDefaultModel(provider);
}

export interface Estimate {
  calls: number;
  uncached: number;
  inputTokens: number;
  outputTokens: number;
  judgeCalls: number;
  usd: number | undefined;
}

/** Tokens and dollars before running: chars/4 for each uncached request, a short reply, and one judge call per uncached turn. */
export function estimate(tasks: readonly ContinuationTask[], cases: readonly Case[], trials: number, judgeModel: string): Estimate {
  const prices = pricesFor();
  let calls = 0;
  let uncached = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let judgeIn = 0;
  for (const t of tasks) {
    const plan = planContinuation({ ...t, onCall: undefined });
    for (const c of cases) {
      for (let k = 1; k <= trials; k++) {
        calls++;
        const p = plan(c.input, k);
        if (p.cached) continue;
        uncached++;
        inputTokens += Math.ceil(p.requestChars / 4);
        outputTokens += Math.min(p.maxOutputTokens, 400);
        judgeIn += Math.ceil((JSON.stringify((c.input as FrozenPrefix).messages.slice(-12)).length + String(c.expected).length + 2000) / 4);
      }
    }
  }
  const model = tasks[0]?.model;
  const price = lookupPrice(model, prices);
  const jprice = lookupPrice(judgeModel, prices);
  const usd = price && jprice ? (inputTokens * price.input + outputTokens * price.output) / 1e6 + (judgeIn * jprice.input + uncached * 200 * jprice.output) / 1e6 : undefined;
  return { calls, uncached, inputTokens, outputTokens, judgeCalls: uncached, usd };
}

export const money = (x: number) => (x === 0 ? "$0" : x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`);

/** A dollar figure, marked API-equivalent when a subscription CLI answered (the plan is billed, not the tokens). */
export const costText = (x: number, provider: ContinuationProvider): string => `${money(x)}${isCliProvider(provider) ? " API-equivalent" : ""}`;

// ---------------------------------------------------------------- report

interface Outcome {
  provider: ContinuationProvider;
  comparison: Comparison;
  ab: AbResult;
  spend: Spend;
  passA: number;
  passB: number;
  fixed: string[];
  broke: string[];
  itemLine?: string;
  resume?: string;
}

/** Per-case majority outcome over graded trials (undefined when none graded). */
function casePass(runs: readonly CaseRun[]): Map<string, boolean> {
  const by = new Map<string, { p: number; n: number }>();
  for (const r of runs) {
    if (r.error === undefined && r.ungraded) continue;
    const x = by.get(r.caseId) ?? { p: 0, n: 0 };
    x.n++;
    if (r.pass) x.p++;
    by.set(r.caseId, x);
  }
  return new Map([...by].map(([id, x]) => [id, x.p * 2 > x.n]));
}

function itemGateFor(a: Arm, b: Arm, ab: AbResult, cases: ReadonlyMap<string, Case>): string | undefined {
  const d = fileDiff(a.files, b.files);
  const change = singleItemChange({ added: d.added, removed: d.removed }, d.changed.length > 0);
  if (!change) return undefined;
  const itemFile = (change.mode === "add" ? b : a).files.find((f) => f.path === change.path);
  const item = itemFile ? harnessItem(itemFile.path, itemFile.text) : undefined;
  if (!item) return undefined;
  const rows: RunResult[] = [];
  const exposure = new Map<string, ExposureState>();
  for (const [arm, exp] of [["a", ab.a], ["b", ab.b]] as const) {
    for (const r of exp.runs) {
      const id = `${arm}:${r.caseId}:${r.trial}`;
      rows.push({ id, taskId: r.caseId, bundleId: arm, attempt: r.trial, pass: r.pass, verifierExit: null, agent: {} as RunResult["agent"], startedAt: 0, endedAt: 0, ...(r.error !== undefined ? { error: r.error } : {}) });
      const input = cases.get(r.caseId)?.input as FrozenPrefix | undefined;
      if (input) exposure.set(id, itemExposure(item, prefixEvents(input), input.cwd ? { cwd: input.cwd } : {}).state);
    }
  }
  const g = itemGate(rows, { baseline: "a", candidate: "b", mode: change.mode, exposure, item });
  return itemGateLine(g);
}

function summaryLines(o: Outcome, mined: DecisionDataset): string[] {
  const n = mined.dataset.cases.length;
  const cmp = o.comparison;
  const p = cmp.mcnemar.p;
  const pText = p < 0.001 ? "p<0.001" : `p=${p < 0.1 ? p.toFixed(3) : p.toFixed(2)}`;
  const s = o.spend;
  const cost = `${costText(s.usd + s.judgeUsd, o.provider)}${s.unpriced ? "+" : ""}, ${s.cached}/${s.calls} cached`;
  const lines = [`${plural(n, "decision point")} from ${plural(mined.sessions, "session")} | A ${o.passA}/${n} -> B ${o.passB}/${n} | fixed ${o.fixed.length}, broke ${o.broke.length} | paired ${pText} | ${cost}`];
  if (cmp.gate) lines.push(gateHeadline(cmp.gate, "decision point"));
  if (cmp.replay) {
    const r = cmp.replay;
    const delta = Math.round(cmp.diff.mean * 100);
    lines.push(
      `Replay noise floor ${Math.round(r.rate * 100)}% (A's turn differs from the recorded one in ${r.diverged}/${r.n}); B moved ${delta >= 0 ? "+" : ""}${delta} points, ${r.withinNoise ? "within the noise: treat it as no change" : "above it"}`,
    );
  }
  if (o.itemLine) lines.push(o.itemLine);
  return lines.slice(0, 4);
}

function caseLines(title: string, ids: readonly string[], cases: ReadonlyMap<string, Case>): string[] {
  if (!ids.length) return [];
  const out = [title];
  for (const id of ids.slice(0, 3)) {
    const c = cases.get(id);
    const m = c?.metadata ?? {};
    const what = typeof m.behavior === "string" ? m.behavior : "case";
    const t = typeof m.title === "string" && m.title ? ` "${m.title.length > 60 ? `${m.title.slice(0, 59)}…` : m.title}"` : "";
    const sess = c ? caseSession(c) : undefined;
    out.push(`  ${what}${t}${sess ? `  coding.sh show ${sess}` : ""}`);
  }
  if (ids.length > 3) out.push(`  … ${ids.length - 3} more`);
  return out;
}

/** One line for the report when B deletes, rewords or relaxes protected lines. */
function protectedHeadline(g: ProtectCheck, gated: boolean): string {
  return `Protected: B deletes, rewords or relaxes ${plural(g.rejections.length, "protected line")}${gated ? "; --gate fails" : ""} (coding.sh refine check lists them)`;
}

/** Before any model call: each protected-line problem, and how to allow it on purpose. */
function warnProtected(c: CommandContext, g: ProtectCheck): void {
  const { out } = c;
  for (const v of g.unusedOverrides) out.warn(`--allow-protected-edit ${v}: no rejection names that protected line`);
  if (g.ok) return;
  for (const l of rejectionLines(g.rejections)) out.warn(l);
  const p = g.rejections[0]!.protected;
  out.warn(`A pass-rate A/B can't see the harm of dropping a safety rule${c.flags.gate === true ? ", so --gate will fail" : ""}. Allow it on purpose: --allow-protected-edit ${p.path}:${p.line}`);
}

/** The mined decision points of one trial, with the per-anchor counts for the report. */
export interface MinedCases {
  mined: DecisionDataset;
  dataset: Dataset;
  cases: Case[];
  caseMap: Map<string, Case>;
  counts: [string, string][];
}

/**
 * Ingest what is pending, mine the decision points and store the dataset.
 * No decision points is a CliError (exit 2) naming a wider window; `command`
 * is the command its hint suggests rerunning.
 */
export async function mineDecisionPoints(c: CommandContext, o: AbOptions, ctx: Context, store: FileEvalStore, anchors: readonly Anchor[], command: string): Promise<MinedCases> {
  await autoIngest(ctx, readIngest(c));
  const repoKey = o.repo ? (basename(o.repo).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "repo") : "all";
  const mined = await buildDecisionDataset({
    index: ctx.index,
    blobs: ctx.blobs,
    anchors,
    since: o.since,
    ...(o.agents.length ? { agents: o.agents } : {}),
    ...(o.repo ? { repo: o.repo } : {}),
    limit: o.limit,
    name: `dp-${anchors.map((a) => a.id).join("-")}-${repoKey}`,
  });
  const cases = mined.dataset.cases;
  const counts = anchors.map((a) => {
    const x = mined.perAnchor[a.id]!;
    return [a.id, `${x.kept} case${x.kept === 1 ? "" : "s"} from ${plural(x.sessions, "session")}${x.found > x.kept ? ` (${x.found} found)` : ""}`] as [string, string];
  });
  if (!cases.length) {
    const widen = o.sinceText === "30d" ? "--since 90d" : "--since 30d";
    throw new CliError(`No decision points in sessions since ${o.sinceText}${o.repo ? ` under ${o.repo}` : ""}`, {
      reason: "no_cases",
      exitCode: 2,
      details: counts,
      next: ["Look further back, or in every repo:", `${command} ${widen}${o.repo ? " --repo all" : ""}`],
      data: { perAnchor: mined.perAnchor, dropped: mined.dropped.length },
    });
  }
  await store.putDataset(mined.dataset);
  return { mined, dataset: mined.dataset, cases, caseMap: new Map(cases.map((x) => [x.id, x])), counts };
}

/** Who answers the next turn and who judges it: the same for every pair of one trial. */
export interface TrialSetup {
  provider: ContinuationProvider;
  model: string;
  base: string;
  judge: LlmGraderSpec;
  judgeModel: string;
  trials: number;
  concurrency: number;
  cache: boolean;
}

export function trialSetup(o: AbOptions, cases: readonly Case[], env: NodeJS.ProcessEnv): TrialSetup {
  const model = o.model ?? defaultModel(o.provider, cases);
  if (!model) throw new UsageError("--provider openai-compatible has no default model and the sessions recorded none: pass --model", { reason: "missing_argument" });
  const base = baseURLFor(o, env);
  const judge = judgeSpec({ ...o, model }, base);
  return { provider: o.provider, model, base, judge, judgeModel: judge.model ?? model, trials: o.trials, concurrency: o.concurrency, cache: o.cache };
}

/** One arm's next-turn task; with `spend`, each model call is counted and priced into it. */
export function continuationTask(t: TrialSetup, arm: Arm, spend?: Spend, onSpend?: () => void): ContinuationTask {
  return {
    kind: "continuation",
    provider: t.provider,
    model: t.model,
    ...(t.base ? { baseURL: t.base } : {}),
    context: { files: arm.files },
    cache: t.cache,
    ...(spend
      ? {
          onCall: (info) => {
            spend.calls++;
            if (info.cached) spend.cached++;
            if (info.costUsd === undefined) {
              if (!info.cached) spend.unpriced++;
            } else spend.usd += info.costUsd;
            onSpend?.();
          },
        }
      : {}),
  };
}

/** Tokens and dollars of one A/B pair on these cases before running it. */
export const estimatePair = (t: TrialSetup, a: Arm, b: Arm, cases: readonly Case[]): Estimate => estimate([continuationTask(t, a), continuationTask(t, b)], cases, t.trials, t.judgeModel);

export interface PairRun {
  ab: AbResult;
  job: Job;
  /** Absent when the run was cancelled (Ctrl-C or the spend cap). */
  comparison?: Comparison;
  /** The spend passed the cap and the run stopped scheduling. */
  overBudget: boolean;
  /** The subscription hit its usage limit and the run stopped scheduling: the line that says so. */
  limited?: string;
}

/**
 * Before the first call through a subscription CLI: it must be installed and
 * logged in. Its limiter runs `concurrency` calls at a time and reports each
 * backoff and a spent plan through `warn`.
 */
export function readyCli(t: Pick<TrialSetup, "provider" | "concurrency">, env: NodeJS.ProcessEnv, warn: (line: string) => void): void {
  if (!isCliProvider(t.provider)) return;
  const kind: CliProvider = t.provider;
  const l = cliLogin(kind, env);
  const cmd = kind === "codex" ? "codex" : "claude";
  if (!l.installed) throw new CliError(`--provider ${kind} runs \`${cmd}\`, which is not on PATH`, { reason: "missing_cli", next: [`Install ${kind === "codex" ? "Codex" : "Claude Code"}, or set an API key and use --provider ${kind === "codex" ? "openai" : "anthropic"}`] });
  if (!l.loggedIn) throw new CliError(`--provider ${kind}: \`${cmd}\` is not logged in`, { reason: "not_logged_in", next: [`Log in: ${LOGIN_HINT[kind]}`] });
  const limiter = cliLimiter(kind);
  limiter.max = t.concurrency;
  limiter.onNote = warn;
}

/**
 * One interleaved A/B pair on decision points: A's and B's next turns, both
 * judged with the per-case rubric, then the comparison with the acceptance
 * gate and A's replay noise floor. `spend` is shared, so several pairs can run
 * under one cap: once it passes `maxCost` no new trial starts and the pair
 * comes back cancelled, with what finished stored.
 */
export async function runPair(
  c: CommandContext,
  store: FileEvalStore,
  t: TrialSetup,
  dataset: Dataset,
  caseMap: ReadonlyMap<string, Case>,
  a: Arm,
  b: Arm,
  o: { spend: Spend; maxCost?: number; gate: GateOpts; name?: string },
): Promise<PairRun> {
  const { spend } = o;
  const cap = new AbortController();
  const check = () => {
    if (o.maxCost !== undefined && spend.usd + spend.judgeUsd > o.maxCost && !cap.signal.aborted) cap.abort();
  };
  check();
  const provider = metered(providerFromSpec(t.judge, { env: c.env }), spend, check);
  const grader = turnOnly(await createGrader(t.judge, { env: c.env, provider, judgeCache: FileJudgeCache.forEnv(c.env) }));
  // A spent subscription stops scheduling like the spend cap does: what finished is kept for --resume.
  const limiter = isCliProvider(t.provider) ? cliLimiter(t.provider) : undefined;
  const drain = AbortSignal.any([...(c.drain ? [c.drain] : []), cap.signal, ...(limiter ? [limiter.stopped] : [])]);
  const loaded = { spec: { trials: t.trials, concurrency: t.concurrency }, dataset, graders: [grader], name: o.name ?? dataset.name };
  const { result: ab, job } = await runArms(c, store, loaded, [{ name: "a", task: continuationTask(t, a, spend, check) }, { name: "b", task: continuationTask(t, b, spend, check) }], "exp ab", { drain });
  if (ab.a.status === "cancelled") return { ab, job, overBudget: cap.signal.aborted, ...(limiter?.spent ? { limited: limiter.spent } : {}) };
  const replay = replayNoise(ab.a, caseMap);
  const comparison = compareExperiments(ab.a, ab.b, { force: true, gate: o.gate, ...(replay ? { replay } : {}) });
  return { ab, job, comparison, overBudget: false };
}

// ---------------------------------------------------------------- the command

export async function expAb(c: CommandContext, store: FileEvalStore, ctx: Context): Promise<number> {
  const { out } = c;
  const root = gitRoot(c.cwd);
  const o = await options(c, root);
  const repoRoot = root ?? c.cwd;
  const anchors = await pickAnchors(o, c.cwd);
  // Resolve the arms before mining: a bad path should fail fast.
  let [armA, armB, armsNote] = await resolveArms(o, c, repoRoot, root !== undefined, ctx);
  if (armsNote && !out.json) out.note(armsNote);
  // The acceptance gate is always computed (it is the headline); --gate only makes it the exit code.
  const gate = gateFlags({ ...c.flags, gate: true })!;
  // Protected safety lines (Z-13): a pass-rate A/B can't see the harm of deleting or waiving one,
  // so the edit is checked before any model call; with --gate a problem fails the run.
  const { protect, autoProtect } = protectOptions(c);
  const allowProtected = protectOverrides(c.flags["allow-protected-edit"]);
  const protectFor = (b: Arm): ProtectCheck => checkProtected(armA.files, b.files, { protect, autoProtect, allow: allowProtected });
  let guard = protectFor(armB);
  if (!out.json) warnProtected(c, guard);

  const { mined, dataset, cases, caseMap, counts } = await mineDecisionPoints(c, o, ctx, store, anchors, "coding.sh exp ab");
  const setup = trialSetup(o, cases, c.env);
  const { model } = setup;
  if (o.autoProvider && !out.json) out.note(o.autoProvider);

  if (o.dryRun) {
    const est = estimatePair(setup, armA, armB, cases);
    if (out.json) {
      out.data({ dryRun: true, dataset: { id: dataset.id, version: dataset.version, cases: cases.length }, perAnchor: mined.perAnchor, dropped: mined.dropped, arms: { a: armA.label, b: armB.label }, provider: setup.provider, model, estimate: { ...est, ...(isCliProvider(setup.provider) ? { apiEquivalent: true } : {}) }, protected: protectJson(guard) });
      return 0;
    }
    out.print(`${plural(cases.length, "decision point")} from ${plural(mined.sessions, "session")} since ${o.sinceText}`);
    for (const [id, v] of counts) out.print(`  ${id}: ${v}`);
    out.print(`A ${armA.label} (${plural(armA.files.length, "file")}) vs B ${armB.label} (${plural(armB.files.length, "file")}), ${model}${isCliProvider(setup.provider) ? ` through ${setup.provider}` : ""}`);
    out.print(
      `Would make ${est.uncached} of ${est.calls} model calls (${est.calls - est.uncached} cached) plus up to ${est.judgeCalls} judge calls: ~${Math.round(est.inputTokens / 1000)}k input tokens, ${est.usd === undefined ? "cost unknown (no price for the model)" : `~${costText(est.usd, setup.provider)}`}`,
    );
    return 0;
  }

  const runOnce = async (a: Arm, b: Arm, quiet: boolean): Promise<Outcome | undefined> => {
    const est = estimatePair(setup, a, b, cases);
    if (o.maxCost !== undefined && est.usd !== undefined && est.usd > o.maxCost) {
      throw new CliError(`Estimated cost ${money(est.usd)} is over --max-cost ${money(o.maxCost)} (${est.uncached} uncached calls)`, {
        reason: "over_budget",
        next: ["Run fewer cases, or raise the cap:", `coding.sh exp ab --limit ${Math.max(1, Math.floor((cases.length * o.maxCost) / est.usd))}`],
      });
    }
    // Every uncached case would fail on the missing key and the run would read "not enough evidence": stop before it.
    const missing = est.uncached ? missingModelKey(continuationTask(setup, a), c.env) : undefined;
    if (missing) {
      // CliError keeps two next lines: the subscription hint goes in the message.
      throw new CliError(
        `exp ab replays your sessions against the model API: set ${missing} (${est.uncached} of ${est.calls} model calls are not cached), or log in to Claude Code (${LOGIN_HINT["claude-code"]}) or Codex (${LOGIN_HINT.codex}) and exp ab replays them on that subscription`,
        { reason: "missing_key", next: ["Or commit the edit and compare the sessions before and after it:", "coding.sh improve check"] },
      );
    }
    if (est.uncached) readyCli(setup, c.env, (l) => out.warn(l));
    if (!quiet && !out.json && est.uncached) out.note(`About ${est.usd === undefined ? "an unknown cost" : costText(est.usd, setup.provider)} for ${est.uncached} uncached model calls (${est.calls - est.uncached} cached)`);
    const spend = newSpend();
    // The cap during the run: stop scheduling once the spend passes it (finished trials are kept; --resume continues).
    const name = str(c.flags.name);
    const run = await runPair(c, store, setup, dataset, caseMap, a, b, { spend, gate, ...(o.maxCost !== undefined ? { maxCost: o.maxCost } : {}), ...(name ? { name } : {}) });
    const { ab, job, comparison } = run;
    if (!comparison) {
      if (run.overBudget) out.warn(`Stopped at ${costText(spend.usd + spend.judgeUsd, setup.provider)}: over --max-cost ${money(o.maxCost!)}`);
      if (run.limited) out.warn(`Stopped: ${run.limited}`);
      cancelledWarning(c, ab.a);
      resumeNote(c, job);
      return undefined;
    }
    // A failed model call counts as a failed trial; when every one failed, the comparison means nothing.
    const runs = [...ab.a.runs, ...ab.b.runs];
    const failedRuns = runs.filter((r) => r.error !== undefined);
    if (failedRuns.length && failedRuns.length === runs.length) {
      throw new CliError(`Every model call failed (${failedRuns.length} of ${runs.length} trials): ${failedRuns[0]!.error}`, {
        reason: "model_error",
        next: ["See each failure:", `coding.sh exp show ${ab.b.id}`],
      });
    }
    if (failedRuns.length && !quiet) out.warn(`${failedRuns.length} of ${runs.length} trials failed and count as not passing: ${failedRuns[0]!.error}`);
    const pa = casePass(ab.a.runs);
    const pb = casePass(ab.b.runs);
    const fixed = cases.filter((x) => pa.get(x.id) === false && pb.get(x.id) === true).map((x) => x.id);
    const broke = cases.filter((x) => pa.get(x.id) === true && pb.get(x.id) === false).map((x) => x.id);
    const itemLine = itemGateFor(a, b, ab, caseMap);
    const resume = resumeField(job).resume;
    return {
      provider: setup.provider,
      comparison,
      ab,
      spend,
      passA: [...pa.values()].filter(Boolean).length,
      passB: [...pb.values()].filter(Boolean).length,
      fixed,
      broke,
      ...(itemLine ? { itemLine } : {}),
      ...(resume ? { resume } : {}),
    };
  };

  const report = (r: Outcome) => {
    if (out.json) {
      out.data({
        dataset: { id: dataset.id, version: dataset.version, cases: cases.length, sessions: mined.sessions },
        arms: { a: { label: armA.label, files: armA.files.map((f) => f.path) }, b: { label: armB.label, files: armB.files.map((f) => f.path) } },
        provider: setup.provider,
        model,
        experiments: { a: r.ab.a.id, b: r.ab.b.id },
        comparison: r.comparison,
        fixed: r.fixed,
        broke: r.broke,
        cost: { usd: r.spend.usd + r.spend.judgeUsd, model: r.spend.usd, judge: r.spend.judgeUsd, unpriced: r.spend.unpriced, ...(isCliProvider(setup.provider) ? { apiEquivalent: true } : {}) },
        cacheHits: { model: r.spend.cached, of: r.spend.calls, judgeCalls: r.spend.judgeCalls },
        perAnchor: mined.perAnchor,
        dropped: mined.dropped,
        protected: protectJson(guard),
        ...(r.resume ? { resume: r.resume } : {}),
      });
      return;
    }
    out.print(`A: ${armA.label}   B: ${armB.label}   model: ${model}${isCliProvider(setup.provider) ? ` (${setup.provider})` : ""}`);
    for (const l of summaryLines(r, mined)) out.print(l);
    if (!guard.ok) out.print(protectedHeadline(guard, c.flags.gate === true));
    const more = [...caseLines("Fixed (A failed, B passed):", r.fixed, caseMap), ...caseLines("Broke (A passed, B failed):", r.broke, caseMap)];
    if (more.length) out.print("");
    for (const l of more) out.print(l);
    out.print("");
    out.print(`Full comparison: coding.sh exp compare ${r.ab.a.id} ${r.ab.b.id}`);
  };

  const first = await runOnce(armA, armB, false);
  if (!first) return 1;
  report(first);
  const exitFor = (r: Outcome) => (c.flags.gate === true && (r.comparison.gate?.decision !== "accept" || !guard.ok) ? 1 : 0);
  if (!o.watch) return exitFor(first);
  return watchLoop(c, armB, async (next) => {
    armB = next;
    if (sameFiles(armA.files, next.files)) return "B is back to A's files; nothing to compare";
    guard = protectFor(next);
    const r = await runOnce(armA, next, true);
    if (!r) return "stopped";
    const s = r.spend;
    const verdict = r.comparison.gate ? gateHeadline(r.comparison.gate, "decision point").split(":")[0] : r.comparison.verdict;
    const prot = guard.ok ? "" : ` | ${guard.rejections[0]!.reason}${guard.rejections.length > 1 ? ` (+${guard.rejections.length - 1} more)` : ""}`;
    return `A ${r.passA}/${cases.length} -> B ${r.passB}/${cases.length} | fixed ${r.fixed.length}, broke ${r.broke.length} | ${verdict}${prot} | ${costText(s.usd + s.judgeUsd, setup.provider)}, ${s.calls - s.cached} new calls`;
  }, async () => {
    // Re-read B the way it was given.
    if (o.b === undefined) return { ...armB, files: harnessFilesIn(repoRoot) };
    return resolveArm(o.b, { cwd: c.cwd, root: repoRoot, base: armA.files, flag: "b", ctx });
  });
}

/**
 * Watch B's files: after a change settles (300 ms), re-read B and, when its
 * files changed, run again and print one history line. Ctrl-C ends it with 0.
 */
async function watchLoop(c: CommandContext, armB: Arm, rerun: (b: Arm) => Promise<string>, reread: () => Promise<Arm>): Promise<number> {
  const { out } = c;
  const dirs = armB.watch.filter((w) => existsSync(w.dir));
  if (!dirs.length) throw new UsageError(`--watch needs B to be files on disk (B is ${armB.label})`, { reason: "invalid_argument" });
  c.interruptExit?.(0);
  const stop = c.drain ?? c.signal;
  process.stderr.write(`Watching ${dirs.map((w) => relative(c.cwd, w.dir) || ".").join(", ")} for changes to B; Ctrl-C to stop.\n`);
  let current = armB;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const watchers: FSWatcher[] = [];
  return new Promise<number>((done) => {
    const finish = () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      done(0);
    };
    const tick = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const next = await reread();
        if (!sameFiles(next.files, current.files)) {
          current = next;
          const line = await rerun(next);
          out.print(`${new Date().toTimeString().slice(0, 8)}  ${line}`);
        }
      } catch (e) {
        out.warn(e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
      }
      if (stop.aborted) return finish();
      if (again) {
        again = false;
        schedule();
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), 300);
    };
    for (const w of dirs) {
      try {
        watchers.push(watch(w.dir, { recursive: w.recursive }, () => schedule()));
      } catch {
        // No recursive watch on this platform: the top directory still triggers.
        watchers.push(watch(w.dir, () => schedule()));
      }
    }
    if (stop.aborted) return finish();
    stop.addEventListener("abort", () => (running ? undefined : finish()), { once: true });
  });
}
