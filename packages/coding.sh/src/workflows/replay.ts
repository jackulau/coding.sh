// Replay from journal (docs/design/workflows.md §7). Claude Code resumes a run with
// resumeFromRunId: the longest unchanged prefix of agent() calls, in call
// order, returns cached results; the first changed call and everything after
// it run live.
//
// predictCacheHits estimates that prefix before running, from the base run's
// ordinals and a static diff of the two scripts:
//   1. the changed line window (common prefix/suffix) and the identifiers
//      declared inside it;
//   2. agent() call sites in the base script whose text intersects the window,
//      or whose arguments use a changed identifier, are "changed"; a call
//      added in the edited window marks the next base call site changed;
//   3. each base agent node maps to a call site by its label pattern
//      (template `${…}` parts match anything); unmapped nodes count as
//      changed once anything changed;
//   4. predicted hits = agent nodes in ordinal order before the first changed one.
// It is a heuristic (a changed helper two calls away is not traced), so the
// result says so. Inside a pipeline(), call order interleaves items across
// stages, which the ordinal prefix captures as is.
import { argsHashOf } from "./sources/claude-workflow.ts";
import { isAgentNode, workflowStats } from "./metrics.ts";
import type { WorkflowStore } from "./store.ts";
import { buildWorkflowTree } from "./tree.ts";
import type { WorkflowCase, WorkflowDriver, WorkflowNode, WorkflowRun } from "./types.ts";

export interface CallSite {
  /** Offsets of `agent(` and its closing paren in the script. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  args: string;
  label?: RegExp;
  labelText?: string;
  phase?: string;
}

const lineAt = (text: string, offset: number): number => {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Index of the paren closing the one at `open`, skipping strings, templates and comments. */
export function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) {
        if (text[i] === "\\") i++;
        else if (ch === "`" && text[i] === "$" && text[i + 1] === "{") i = matchParen(text, i + 1);
      }
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Label pattern: literal parts escaped, `${…}` parts match anything. */
export function labelPattern(raw: string, quote: string): RegExp {
  if (quote !== "`") return new RegExp(`^${escapeRe(raw)}$`);
  const parts: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const j = raw.indexOf("${", i);
    if (j < 0) {
      parts.push(escapeRe(raw.slice(i)));
      break;
    }
    parts.push(escapeRe(raw.slice(i, j)), ".*");
    i = matchParen(raw, j + 1) + 1;
  }
  return new RegExp(`^${parts.join("")}$`);
}

export function scanAgentCalls(script: string): CallSite[] {
  const phases: { at: number; name: string }[] = [];
  for (const m of script.matchAll(/\bphase\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) phases.push({ at: m.index!, name: m[2]! });
  const out: CallSite[] = [];
  for (const m of script.matchAll(/(?<![\w$.])agent\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchParen(script, open);
    const args = script.slice(open + 1, close);
    const site: CallSite = { start: m.index!, end: close, startLine: lineAt(script, m.index!), endLine: lineAt(script, close), args };
    const lm = /\blabel\s*:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(args);
    if (lm) {
      site.labelText = lm[2]!;
      site.label = labelPattern(lm[2]!, lm[1]!);
    }
    const pm = /\bphase\s*:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(args);
    const enclosing = [...phases].reverse().find((p) => p.at < m.index!);
    const phase = pm?.[2] ?? enclosing?.name;
    if (phase) site.phase = phase;
    out.push(site);
  }
  return out;
}

export interface ChangeWindow {
  /** First changed line (0-based) in both scripts. */
  start: number;
  /** End (exclusive) of the changed lines in the base / edited script. */
  baseEnd: number;
  editedEnd: number;
  /** Identifiers declared on changed lines (either side). */
  idents: string[];
}

export function changeWindow(base: string, edited: string): ChangeWindow | undefined {
  if (base === edited) return undefined;
  const a = base.split("\n");
  const b = edited.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const baseEnd = a.length - suf;
  const editedEnd = b.length - suf;
  const idents = new Set<string>();
  const changed = [...a.slice(pre, baseEnd), ...b.slice(pre, editedEnd)];
  for (const l of changed) for (const m of l.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) idents.add(m[1]!);
  return { start: pre, baseEnd, editedEnd, idents: [...idents] };
}

export interface CachePrediction {
  /** Agent calls predicted to return cached results. */
  hits: number;
  /** Agent calls in the base run. */
  total: number;
  firstMiss?: { ordinal: number; label: string };
  /** Base ordinals whose call site changed. */
  changed: number[];
  /** Base cost of the calls predicted to re-run, when known. */
  estimatedUsd?: number;
  heuristic: true;
  reason: string;
}

export function predictCacheHits(baseNodes: readonly WorkflowNode[], baseScript: string, editedScript: string, o: { argsChanged?: boolean } = {}): CachePrediction {
  const agents = baseNodes.filter((x) => isAgentNode(x) && x.ordinal !== undefined).sort((x, y) => x.ordinal! - y.ordinal!);
  const total = agents.length;
  const finish = (firstIdx: number, changed: number[], reason: string): CachePrediction => {
    const p: CachePrediction = { hits: firstIdx, total, changed, heuristic: true, reason };
    const miss = agents[firstIdx];
    if (miss) p.firstMiss = { ordinal: miss.ordinal!, label: miss.name };
    const costs = agents.slice(firstIdx).map((a) => a.usage?.costUsd);
    if (costs.length && costs.every((c) => c !== undefined)) p.estimatedUsd = costs.reduce((s, c) => s + c!, 0);
    return p;
  };
  if (o.argsChanged) return finish(0, agents.map((a) => a.ordinal!), "args changed: every call may see different input");
  const w = changeWindow(baseScript, editedScript);
  if (!w) return finish(total, [], "script unchanged: every call is cached");

  const sites = scanAgentCalls(baseScript);
  const editedSites = scanAgentCalls(editedScript);
  const winEnd = Math.max(w.start + 1, w.baseEnd);
  const identRes = w.idents.map((id) => new RegExp(`(?<![\\w$])${escapeRe(id)}(?![\\w$])`));
  const affected = new Set<CallSite>();
  for (const s of sites) {
    if (s.startLine < winEnd && s.endLine >= w.start) affected.add(s);
    else if (identRes.some((re) => re.test(s.args))) affected.add(s);
  }
  // A call added inside the edited window shifts everything after it.
  const added = editedSites.some((s) => s.startLine >= w.start && s.startLine < Math.max(w.start + 1, w.editedEnd));
  if (added) {
    const next = sites.find((s) => s.startLine >= w.start);
    if (next) affected.add(next);
  }

  const siteOf = (node: WorkflowNode): CallSite | undefined => {
    const matches = sites.filter((s) => s.label?.test(node.name));
    if (matches.length <= 1) return matches[0];
    return matches.find((s) => s.phase !== undefined && s.phase === node.phase) ?? matches[0];
  };
  const changed: number[] = [];
  let first = total;
  agents.forEach((a, i) => {
    const site = siteOf(a);
    if (!site || affected.has(site)) {
      changed.push(a.ordinal!);
      if (i < first) first = i;
    }
  });
  const reason =
    first === total
      ? "no agent() call site is affected by the edit"
      : `first changed call: #${agents[first]!.ordinal} ${JSON.stringify(agents[first]!.name)}${siteOf(agents[first]!) ? "" : " (no matching call site)"}`;
  return finish(first, changed, reason);
}

export interface ReplayOpts {
  base: { run: WorkflowRun; nodes: WorkflowNode[] };
  baseScript: string;
  /** Path of the edited script. */
  script: string;
  editedScript: string;
  args?: unknown;
  baseArgs?: unknown;
  driver: WorkflowDriver;
  store: WorkflowStore;
  dryRun?: boolean;
}

export async function replayWorkflow(o: ReplayOpts): Promise<{ prediction: CachePrediction; run?: WorkflowRun }> {
  const argsChanged = o.args !== undefined && (o.base.run.argsHash !== undefined ? argsHashOf(o.args) !== o.base.run.argsHash : o.baseArgs !== undefined && argsHashOf(o.args) !== argsHashOf(o.baseArgs));
  const prediction = predictCacheHits(o.base.nodes, o.baseScript, o.editedScript, { argsChanged });
  if (o.dryRun) return { prediction };
  const c: WorkflowCase = { id: o.base.run.caseId ?? "replay", workflow: o.base.run.name, split: "dev", args: o.args ?? o.baseArgs ?? {}, truth: { kind: "seeded-bugs", bugs: [] } };
  const env = { CODING_SH_WORKFLOW_RUN_ID: `replay-${o.base.run.id}-${Date.now()}`, CODING_SH_RUN_ID: `replay-${o.base.run.id}` };
  const res = await o.driver.run({ name: "replay", script: o.script, args: o.args, resumeFromRunId: o.base.run.id }, c, env);
  if (!res.sources) return { prediction };
  const tree = buildWorkflowTree(res.sources, { base: o.base });
  tree.run.resumedFrom ??= o.base.run.id;
  if (o.base.run.caseId) tree.run.caseId = o.base.run.caseId;
  tree.run.tags = [...new Set([...tree.run.tags, "replay"])];
  tree.run.stats = workflowStats(tree.run, tree.nodes, o.base);
  await o.store.putRun(tree.run, tree.nodes, { outputs: tree.outputs, runOutput: res.output ?? tree.runOutput, ...(res.sources.script !== undefined ? { script: res.sources.script } : {}) });
  return { prediction, run: tree.run };
}
