// Description compression (§8.3): minimize descriptionBytes of an MCP server
// subject to no regression. Search on the dev split, one tool at a time (or
// every tool at one level with `batch`), accepting the shortest candidate that
// is non-inferior to the current accepted state; confirm on heldout with k ≥ 5.
import { connectMcp } from "./mcp/client.ts";
import { anthropicConversation } from "./model/anthropic.ts";
import { openaiChatConversation, openaiResponsesConversation } from "./model/openai.ts";
import { compareToolArms } from "./compare.ts";
import { runToolExperiment, type ExperimentDeps } from "./experiment.ts";
import { descriptionBytesOf, toolsSurface } from "./surface.ts";
import { applyToolOverrides } from "./tap/mcp-proxy.ts";
import type { CompressReport, CompressStep, Driver, McpTarget, McpTool, ToolCompareReport, ToolTask, TrialResult, Variant } from "./types.ts";
import { driverKey } from "./types.ts";

export const LEVELS = [0.75, 0.5, 0.25] as const;
export const DEFAULT_MARGIN = 0.03;
export const INVALID_RATE_SLACK = 0.02;

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/** One tool's compressible text: its description and its top-level parameter descriptions. */
export interface ToolText {
  description: string;
  params: Record<string, string>;
}

export function toolText(t: McpTool): ToolText {
  const params: Record<string, string> = {};
  const props = (t.inputSchema as { properties?: Record<string, { description?: unknown }> } | undefined)?.properties;
  if (props && typeof props === "object") for (const [k, p] of Object.entries(props)) if (p && typeof p.description === "string") params[k] = p.description;
  return { description: t.description ?? "", params };
}

export const textBytes = (x: ToolText): number => utf8(x.description) + Object.values(x.params).reduce((a, s) => a + utf8(s), 0);

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Drop example blocks, fenced code and "e.g." asides. */
export function dropExamples(s: string): string {
  return collapse(
    s
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/(^|\n)\s*(examples?|usage)\s*:[\s\S]*$/i, " ")
      .replace(/\s*\((?:e\.g\.|for example|for instance|example:)[^)]*\)/gi, "")
      .replace(/(?:^|(?<=[.!?]\s))(?:e\.g\.|for example|for instance|example:)[^.!?]*[.!?]?/gi, "")
      .replace(/\bexamples?:.*$/i, ""),
  );
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const FILLER = new Set(["the", "a", "an", "of", "to", "for", "is", "this", "that", "parameter", "param", "value", "argument", "field", "input"]);

/** True when a parameter description says no more than the parameter's name. */
export function repeatsName(param: string, desc: string): boolean {
  const name = new Set(words(param.replace(/([a-z])([A-Z])/g, "$1 $2")));
  const rest = words(desc).filter((w) => !FILLER.has(w));
  return rest.length > 0 && rest.length <= name.size + 1 && rest.every((w) => name.has(w) || name.has(w.replace(/s$/, "")));
}

/** Keep leading sentences (then leading words) of s within maxBytes. */
export function truncateSentences(s: string, maxBytes: number): string {
  if (utf8(s) <= maxBytes) return s;
  const sentences = s.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [s];
  let out = "";
  for (const x of sentences) {
    if (utf8(out + x) > maxBytes) break;
    out += x;
  }
  if (out.trim()) return out.trim();
  let w = "";
  for (const x of s.split(/\s+/)) {
    const next = w ? `${w} ${x}` : x;
    if (utf8(next) > maxBytes) break;
    w = next;
  }
  return w;
}

/**
 * Rule-based candidate at targetBytes: collapse whitespace, drop examples,
 * drop parameter descriptions that repeat the name, then truncate by sentence
 * (description first, then parameters) until it fits.
 */
export function ruleCandidate(t: ToolText, targetBytes: number): ToolText {
  const out: ToolText = { description: dropExamples(collapse(t.description)), params: {} };
  for (const [k, v] of Object.entries(t.params)) {
    const c = dropExamples(collapse(v));
    out.params[k] = repeatsName(k, c) ? "" : c;
  }
  if (textBytes(out) <= targetBytes) return out;
  const paramBytes = Object.values(out.params).reduce((a, s) => a + utf8(s), 0);
  out.description = truncateSentences(out.description, Math.max(0, targetBytes - paramBytes));
  if (textBytes(out) <= targetBytes) return out;
  // Parameters: shorten each to its first sentence, then drop the longest ones.
  for (const k of Object.keys(out.params)) out.params[k] = truncateSentences(out.params[k]!, Math.max(16, Math.floor(utf8(out.params[k]!) / 2)));
  const keys = Object.keys(out.params).sort((a, b) => utf8(out.params[b]!) - utf8(out.params[a]!));
  for (const k of keys) {
    if (textBytes(out) <= targetBytes) break;
    out.params[k] = "";
  }
  if (textBytes(out) > targetBytes) out.description = truncateSentences(out.description, targetBytes);
  return out;
}

function sameText(a: ToolText, b: ToolText): boolean {
  if (a.description !== b.description) return false;
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
  for (const k of keys) if ((a.params[k] ?? "") !== (b.params[k] ?? "")) return false;
  return true;
}

const textKey = (tool: string, x: ToolText) =>
  JSON.stringify([
    tool,
    x.description,
    Object.entries(x.params)
      .filter(([, v]) => v !== "")
      .sort(),
  ]);

interface State {
  descriptions: Record<string, string>;
  params: Record<string, Record<string, string>>;
}

function stateVariant(name: string, base: Variant, s: State): Variant {
  return { ...base, name, descriptions: { ...(base.descriptions ?? {}), ...s.descriptions }, paramDescriptions: mergeParams(base.paramDescriptions ?? {}, s.params) };
}

function mergeParams(a: Record<string, Record<string, string>>, b: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [t, p] of Object.entries(a)) out[t] = { ...p };
  for (const [t, p] of Object.entries(b)) out[t] = { ...(out[t] ?? {}), ...p };
  return out;
}

function withText(s: State, tool: string, before: ToolText, x: ToolText): State {
  const next: State = { descriptions: { ...s.descriptions, [tool]: x.description }, params: mergeParams(s.params, {}) };
  const changed: Record<string, string> = {};
  for (const [k, v] of Object.entries(x.params)) if (v !== (before.params[k] ?? "")) changed[k] = v;
  if (Object.keys(changed).length) next.params[tool] = { ...(next.params[tool] ?? {}), ...changed };
  return next;
}

export type Evaluate = (variant: Variant, tasks: ToolTask[], k: number) => Promise<TrialResult[]>;

export interface NonInferiority {
  ok: boolean;
  diffLo: number;
  invalidRateHi: number;
  lostTasks: string[];
  reason?: string;
  report: ToolCompareReport;
}

/** §8.3 step 3: all three conditions must hold. */
export function nonInferior(accepted: readonly TrialResult[], candidate: readonly TrialResult[], o: { margin: number; seed?: number; iters?: number }): NonInferiority {
  const relabel = (ts: readonly TrialResult[], v: string) => ts.map((t) => ({ ...t, variant: v, driver: "d" }));
  const report = compareToolArms([...relabel(accepted, "accepted"), ...relabel(candidate, "candidate")], { baseline: "accepted@d", candidate: "candidate@d", seed: o.seed, iters: o.iters });
  const lostTasks = report.regressions.filter((r) => r.kind === "success").map((r) => r.taskId);
  const diffLo = report.pairedTasks ? report.diff.lo : -Infinity;
  const invalidRateHi = report.metrics.invalidRate?.diff.hi ?? 0;
  const reasons: string[] = [];
  if (!report.pairedTasks) reasons.push("no paired tasks");
  if (lostTasks.length) reasons.push(`lost passes on ${lostTasks.join(", ")}`);
  if (diffLo < -o.margin) reasons.push(`success CI lower bound ${(diffLo * 100).toFixed(1)} pp < −${(o.margin * 100).toFixed(1)} pp`);
  if (invalidRateHi > INVALID_RATE_SLACK) reasons.push(`invalidRate CI upper bound +${invalidRateHi.toFixed(3)} > +${INVALID_RATE_SLACK}`);
  return { ok: reasons.length === 0, diffLo, invalidRateHi, lostTasks, ...(reasons.length ? { reason: reasons.join("; ") } : {}), report };
}

export interface CompressOpts extends Partial<ExperimentDeps> {
  target: McpTarget;
  /** All tasks; the search uses split "dev", confirmation uses split "heldout". */
  tasks: ToolTask[];
  driver: Driver;
  k: number;
  margin?: number;
  maxEvals: number;
  batch?: boolean;
  /** Model rewriter: tool schema + target length → description (no eval tasks in the prompt). */
  rewrite?: (tool: McpTool, targetBytes: number) => Promise<string>;
  /** Starting variant (default `base`). */
  base?: Variant;
  /** Original tools; fetched from the target when absent. */
  tools?: McpTool[];
  /** Runs one variant over tasks × k (default: runToolExperiment with the deps). */
  evaluate?: Evaluate;
  seed?: number;
  iters?: number;
  onStep?: (s: CompressStep, evals: number) => void;
}

interface Candidate {
  tool: string;
  state: State;
  bytes: number;
  source: CompressStep["source"];
  fromBytes: number;
}

export async function compressDescriptions(o: CompressOpts): Promise<CompressReport> {
  const margin = o.margin ?? DEFAULT_MARGIN;
  const k = Math.max(1, o.k);
  const base: Variant = o.base ?? { name: "base" };
  const notes: string[] = [];
  const dev = o.tasks.filter((t) => t.split === "dev");
  const heldout = o.tasks.filter((t) => t.split === "heldout");
  if (!dev.length) throw new Error("compress needs dev tasks");
  const evaluate: Evaluate =
    o.evaluate ??
    (async (variant, tasks, kk) => {
      if (!o.adapterFor || !o.index || !o.blobs) throw new Error("compress needs experiment deps (adapterFor, index, blobs) or an evaluate function");
      const r = await runToolExperiment({ ...(o as ExperimentDeps), tasks, target: o.target, variants: [variant], drivers: [o.driver], k: kk });
      return r.trials;
    });

  let original = o.tools;
  if (!original) {
    const t = o.target;
    const client = await connectMcp(t.transport === "stdio" ? { stdio: base.command ?? t.command, env: { ...(t.env ?? {}), ...(base.env ?? {}) } } : { url: base.url ?? t.url, headers: t.headers, fetch: o.fetch });
    try {
      original = await client.listTools();
    } finally {
      await client.close();
    }
  }
  const baseTools = applyToolOverrides(original, base);
  const toolNames = baseTools.map((t) => t.name);
  let state: State = { descriptions: {}, params: {} };
  const currentTools = (s: State) => applyToolOverrides(original!, stateVariant("x", base, s));
  const textOf = (s: State, name: string) => toolText(currentTools(s).find((t) => t.name === name)!);
  const descBytes = (s: State) => currentTools(s).reduce((a, t) => a + descriptionBytesOf(t), 0);

  const bytesBefore = descBytes(state);
  const surfaceBefore = toolsSurface(baseTools, o.target.name, base.name);
  let evals = 0;
  let accepted = await evaluate(stateVariant(base.name, base, state), dev, k);
  const history: State[] = [state];
  const steps: CompressStep[] = [];
  const tried = new Set<string>();
  const rewriteCache = new Map<string, string>();

  const rewritten = async (name: string, s: State, targetBytes: number): Promise<ToolText | undefined> => {
    if (!o.rewrite) return undefined;
    const tool = currentTools(s).find((t) => t.name === name)!;
    const key = JSON.stringify([name, tool.description, targetBytes]);
    let d = rewriteCache.get(key);
    if (d === undefined) {
      try {
        d = collapse(await o.rewrite(tool, targetBytes));
      } catch (e) {
        notes.push(`rewriter failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
        d = "";
      }
      rewriteCache.set(key, d);
    }
    if (!d) return undefined;
    // The rewriter owns the description; parameter descriptions take the rule pass.
    const cur = toolText(tool);
    const rule = ruleCandidate({ description: "", params: cur.params }, Math.max(0, targetBytes - utf8(d)));
    return { description: d, params: rule.params };
  };

  const toolCandidates = async (name: string, s: State): Promise<Candidate[]> => {
    const cur = textOf(s, name);
    const from = textBytes(cur);
    const out: Candidate[] = [];
    for (const level of LEVELS) {
      const target = Math.floor(from * level);
      const options: [ToolText | undefined, CompressStep["source"]][] = [
        [ruleCandidate(cur, target), "rule"],
        [await rewritten(name, s, target), "model"],
      ];
      for (const [x, source] of options) {
        if (!x || sameText(x, cur)) continue;
        const bytes = textBytes(x);
        if (bytes >= from) continue;
        const key = textKey(name, x);
        if (tried.has(key) || out.some((c) => textKey(name, textOf(c.state, name)) === key)) continue;
        out.push({ tool: name, state: withText(s, name, cur, x), bytes, source, fromBytes: from });
      }
    }
    return out.sort((a, b) => a.bytes - b.bytes);
  };

  const tryCandidate = async (c: Candidate): Promise<boolean> => {
    evals++;
    if (c.tool !== "*") tried.add(textKey(c.tool, textOf(c.state, c.tool)));
    const trials = await evaluate(stateVariant(`desc-min-${evals}`, base, c.state), dev, k);
    const ni = nonInferior(accepted, trials, { margin, seed: o.seed, iters: o.iters });
    const step: CompressStep = {
      tool: c.tool,
      fromBytes: c.fromBytes,
      toBytes: c.bytes,
      accepted: ni.ok,
      source: c.source,
      evidence: { diffLo: ni.diffLo, invalidRateHi: ni.invalidRateHi, lostTasks: ni.lostTasks, trials: trials.length, ...(ni.reason ? { reason: ni.reason } : {}) },
    };
    steps.push(step);
    o.onStep?.(step, evals);
    if (ni.ok) {
      state = c.state;
      accepted = trials;
      history.push(state);
    }
    return ni.ok;
  };

  let budgetHit = false;
  for (;;) {
    let progressed = false;
    if (o.batch) {
      // Every tool at one level per step; shortest level first.
      const cands: Candidate[] = [];
      const from = descBytes(state);
      for (const level of LEVELS) {
        let s = state;
        for (const name of toolNames) {
          const cur = textOf(s, name);
          const x = ruleCandidate(cur, Math.floor(textBytes(cur) * level));
          if (!sameText(x, cur)) s = withText(s, name, cur, x);
        }
        const key = `*${JSON.stringify(s)}`;
        const bytes = descBytes(s);
        if (bytes < from && !tried.has(key)) {
          tried.add(key);
          cands.push({ tool: "*", state: s, bytes, source: "rule", fromBytes: from });
        }
      }
      for (const c of cands.sort((a, b) => a.bytes - b.bytes)) {
        if (evals >= o.maxEvals) {
          budgetHit = true;
          break;
        }
        if (await tryCandidate(c)) {
          progressed = true;
          break;
        }
      }
    } else {
      const order = [...toolNames].sort((a, b) => textBytes(textOf(state, b)) - textBytes(textOf(state, a)));
      for (const name of order) {
        if (budgetHit) break;
        for (const c of await toolCandidates(name, state)) {
          if (evals >= o.maxEvals) {
            budgetHit = true;
            break;
          }
          if (await tryCandidate(c)) {
            progressed = true;
            break;
          }
        }
      }
    }
    if (budgetHit || !progressed) break;
  }
  if (budgetHit) notes.push(`stopped at --max-evals ${o.maxEvals}`);

  let heldoutReport: ToolCompareReport | undefined;
  let overfit = false;
  if (history.length > 1 && heldout.length) {
    const kh = Math.max(5, k);
    const baseTrials = await evaluate(stateVariant(base.name, base, history[0]!), heldout, kh);
    for (let i = history.length - 1; i >= 1; i--) {
      const s = history[i]!;
      const trials = await evaluate(stateVariant("desc-min", base, s), heldout, kh);
      const ni = nonInferior(baseTrials, trials, { margin, seed: o.seed, iters: o.iters });
      const relabel = (ts: readonly TrialResult[], v: string) => ts.map((t) => ({ ...t, variant: v, driver: driverKey(o.driver) }));
      const report = compareToolArms([...relabel(baseTrials, base.name), ...relabel(trials, "desc-min")], {
        baseline: `${base.name}@${driverKey(o.driver)}`,
        candidate: `desc-min@${driverKey(o.driver)}`,
        seed: o.seed,
        iters: o.iters,
        surfaces: { baseline: surfaceBefore, candidate: toolsSurface(currentTools(s), o.target.name, "desc-min") },
      });
      if (i === history.length - 1) heldoutReport = report;
      if (ni.ok) {
        if (i !== history.length - 1) {
          notes.push(`held-out confirmation failed for the final state; kept accepted state ${i} of ${history.length - 1}`);
          heldoutReport = report;
        }
        state = s;
        break;
      }
      overfit = true;
      if (i === 1) {
        notes.push(`held-out confirmation failed for every accepted state (${ni.reason ?? "non-inferiority"}); kept the base descriptions`);
        state = history[0]!;
        heldoutReport = report;
      }
    }
  } else if (history.length > 1) {
    notes.push("no heldout tasks: the result is not confirmed and may overfit the dev split");
  }

  const finalTools = currentTools(state);
  const final: Record<string, string> = {};
  const finalParams: Record<string, Record<string, string>> = {};
  const baseByName = new Map(baseTools.map((t) => [t.name, toolText(t)]));
  for (const t of finalTools) {
    const before = baseByName.get(t.name)!;
    const after = toolText(t);
    if (after.description !== before.description) final[t.name] = after.description;
    for (const k2 of Object.keys(before.params)) {
      const a = after.params[k2] ?? "";
      if (a !== before.params[k2]) (finalParams[t.name] ??= {})[k2] = a;
    }
  }
  const surfaceAfter = toolsSurface(finalTools, o.target.name, "desc-min");
  return {
    steps,
    final,
    finalParams,
    bytesBefore,
    bytesAfter: descBytes(state),
    surfaceTokensBefore: surfaceBefore.surfaceTokens,
    surfaceTokensAfter: surfaceAfter.surfaceTokens,
    evals,
    ...(heldoutReport ? { heldout: heldoutReport } : {}),
    overfit,
    notes,
  };
}

/** descriptions.json content for variants/desc-min (structured form when params change). */
export function descriptionsFile(r: Pick<CompressReport, "final" | "finalParams">): Record<string, unknown> {
  return Object.keys(r.finalParams).length ? { descriptions: r.final, paramDescriptions: r.finalParams } : r.final;
}

export const REWRITE_SYSTEM =
  "You shorten MCP tool descriptions. Keep every fact an agent needs to call the tool correctly: what it does, when to use it, required inputs and constraints. Drop examples, repetition and filler. Reply with the new description text only.";

/** The configured rewriter model as a `rewrite` function. The prompt holds the tool schema and target length, never eval tasks. */
export function modelRewriter(driver: Extract<Driver, { kind: "model" }>, apiKey: string, doFetch: typeof fetch = fetch): (tool: McpTool, targetBytes: number) => Promise<string> {
  return async (tool, targetBytes) => {
    const init = {
      model: driver.model,
      system: REWRITE_SYSTEM,
      instruction: `Rewrite the description of this tool in at most ${targetBytes} bytes.\n\n${JSON.stringify({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }, null, 2)}`,
      tools: [],
      apiKey,
      baseUrl: driver.baseUrl,
      maxOutputTokens: driver.maxOutputTokens ?? 1024,
      temperature: driver.temperature ?? 0,
      fetch: doFetch,
    };
    const conv = driver.provider === "anthropic" ? anthropicConversation(init) : driver.provider === "openai" ? openaiResponsesConversation(init) : openaiChatConversation(init);
    const turn = await conv.call();
    return turn.text.trim().replace(/^"|"$/g, "");
  };
}
