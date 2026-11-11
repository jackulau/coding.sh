// Did a harness change help? Each committed change to CLAUDE.md, AGENTS.md,
// GEMINI.md, a rule or a skill, with the captured sessions that ran before it
// and after it.
//
// A session ran with the harness version its HEAD had: the newest commit that
// touched a harness file and is reachable from the session's starting HEAD
// (`git rev-list -1 <head> -- <harness paths>`). So "before" a change C is
// every session whose version is C's previous harness commit, and "after" is
// every session whose version is C, whatever the clock says. Sessions with no
// recorded HEAD, or a HEAD git no longer has, are left out, and so are sessions
// with no tool call outside MCP servers. Uncommitted edits count from the
// commit that keeps them.
//
// Two measures decide the verdict:
//   flagged share   sessions with a diagnosed failure flag, before vs after
//   new rules       each added line that names a command, flag, path or
//                   identifier (src/core/rules.ts): the share of sessions that
//                   acted on it, before vs after
// Each is a two-sided Fisher exact test at ALPHA. Worse flagged share is a
// regression. Helped needs the failure itself to fall: the flagged share, or one
// diagnosed flag's share (Holm-adjusted across the flags seen before) with no
// other flag rising significantly in its place; the reason names every flag
// that rose, significant or not. A new line the agent follows while flags stay
// put is "followed, no effect yet": following a line is not fixing what it
// targets (Treude & Baltes, arXiv 2610.34938, RQ2). A third measure, work (tool
// calls and wall time per session), turns a change that adds work without
// fixing anything into "costlier", and is noted on one that helped.
import type { AgentEvent, Session } from "../schema/index.ts";
import { git, run } from "../core/git.ts";
import { HARNESS_PATHSPECS, isHarnessPath } from "../core/harness-paths.ts";
import { diffDirectives, directiveOutcome, type Directive } from "../core/rules.ts";
import { FLAG_DIAGNOSIS } from "../refine/taxonomy.ts";
import { fisherExact, holm } from "../stats/tests.ts";

/** Significance level for helped / regressed. */
export const ALPHA = 0.1;
/** Fewer sessions after a change than this, and no clear result, is "too early". */
export const MIN_AFTER = 5;
/** Most sessions per side whose events are read for rule-following. */
const RULE_SESSIONS = 50;

export interface HarnessChange {
  commit: string;
  short: string;
  /** Commit time, ms. */
  at: number;
  subject: string;
  files: { path: string; added: number; removed: number }[];
  /** The previous commit that touched a harness file; undefined for the first. */
  previous?: string;
  /** Changed lines (without +/-), blank lines left out. */
  added: string[];
  removed: string[];
}

/** A session with a diagnosed failure flag: which one, when, and what went wrong. */
export interface FlaggedSession {
  id: string;
  startedAt: number;
  title?: string;
  /** Its diagnosed failure flags (the ones `flagged` counts). */
  flags: string[];
}

export interface GroupStats {
  sessions: number;
  /** Sessions with at least one diagnosed failure flag. */
  flagged: number;
  byFlag: Record<string, number>;
  /** Session ids, newest first (at most 5). */
  examples: string[];
  /** Every flagged session, newest first (`flagged` of them). */
  flaggedSessions: FlaggedSession[];
  /**
   * Sessions of this version left out because they made no tool call outside
   * MCP servers: a chat, or an agent that never got to work (one that was not
   * logged in, or whose API key was refused). Absent when none.
   */
  idle?: number;
  /** Per-session work: tool calls, and wall time (ms) for sessions with an end. */
  work?: { toolCalls: number[]; durationMs: number[] };
}

export interface RuleEffect {
  text: string;
  path: string;
  line: number;
  polarity: "require" | "forbid";
  /** Sessions that acted on the rule, of those it could be scored on (they made tool calls). */
  before: { acted: number; n: number };
  after: { acted: number; n: number };
  p?: number;
}

export type Verdict = "helped" | "followed-no-effect" | "costlier" | "regressed" | "no-clear-change" | "too-early" | "no-sessions-after" | "no-baseline";

/** One work measure, before vs after: medians and a two-sided permutation p on mean log1p. */
export interface WorkMeasure {
  before: number;
  after: number;
  p: number;
}

/** Work per session before vs after; a measure only when both sides have MIN_AFTER values and they differ. */
export interface WorkEffect {
  toolCalls?: WorkMeasure;
  durationMs?: WorkMeasure;
}

export interface ChangeEffect {
  change: HarnessChange;
  before: GroupStats;
  after: GroupStats;
  /** Two-sided Fisher p for the flagged share. */
  p?: number;
  rules: RuleEffect[];
  verdict: Verdict;
  /** One sentence: why the verdict. */
  reason: string;
  /** Work per session before vs after; absent with too little data or no difference. */
  work?: WorkEffect;
}

const diagnosed = (s: Session): string[] => [...new Set(s.flags ?? [])].filter((f) => !f.includes(":") && FLAG_DIAGNOSIS[f] !== undefined && FLAG_DIAGNOSIS[f] !== "context-only");

// ---------------------------------------------------------------- git

/** Commits that changed a harness file in `root`, newest first. */
export async function harnessChanges(root: string, o: { limit?: number; since?: number } = {}): Promise<HarnessChange[]> {
  const limit = o.limit ?? 5;
  const args = ["log", "--no-color", "--format=%x1e%H%x1f%ct%x1f%s", "--numstat", "-n", String(limit * 4)];
  if (o.since) args.push(`--since=@${Math.floor(o.since / 1000)}`);
  const r = await run([...args, "--", ...HARNESS_PATHSPECS], { cwd: root, allowFail: true });
  if (r.code !== 0) return [];
  const out: HarnessChange[] = [];
  for (const rec of r.stdout.split("\x1e")) {
    const [head, ...rest] = rec.split("\n");
    if (!head?.trim()) continue;
    const [commit, ct, subject] = head.split("\x1f");
    if (!commit || !ct) continue;
    const files = rest
      .map((l) => l.split("\t"))
      .filter((x) => x.length >= 3 && isHarnessPath(x[2] as string))
      .map(([a, d, path]) => ({ path: path as string, added: Number(a) || 0, removed: Number(d) || 0 }));
    if (!files.length) continue;
    out.push({ commit, short: commit.slice(0, 7), at: Number(ct) * 1000, subject: subject ?? "", files, added: [], removed: [] });
    if (out.length >= limit) break;
  }
  for (const c of out) {
    const prev = (await run(["rev-list", "-1", `${c.commit}^`, "--", ...HARNESS_PATHSPECS], { cwd: root, allowFail: true })).stdout.trim();
    if (prev) c.previous = prev;
    const diff = await run(["show", "--no-color", "--format=", "-U0", c.commit, "--", ...c.files.map((f) => f.path)], { cwd: root, allowFail: true });
    for (const l of diff.stdout.split("\n")) {
      if (l.startsWith("+++") || l.startsWith("---")) continue;
      const text = l.slice(1).trim();
      if (!text) continue;
      if (l.startsWith("+")) c.added.push(text);
      else if (l.startsWith("-")) c.removed.push(text);
    }
  }
  return out;
}

/**
 * Each session's harness version: the newest harness commit reachable from its starting HEAD.
 * A session in another checkout or worktree of the repo counts when `root` has its HEAD; one
 * whose HEAD `root` doesn't have (another repo, an unfetched branch) is left out.
 */
export async function sessionVersions(root: string, sessions: readonly Session[]): Promise<Map<string, string>> {
  const byHead = new Map<string, Promise<string | undefined>>();
  const version = (head: string) => {
    let p = byHead.get(head);
    if (!p) {
      p = run(["rev-list", "-1", head, "--", ...HARNESS_PATHSPECS], { cwd: root, allowFail: true }).then((r) => (r.code === 0 ? r.stdout.trim() : undefined));
      byHead.set(head, p);
    }
    return p;
  };
  const out = new Map<string, string>();
  const heads = sessions.filter((s) => s.repo?.head);
  for (let i = 0; i < heads.length; i += 8) {
    await Promise.all(
      heads.slice(i, i + 8).map(async (s) => {
        const v = await version(s.repo!.head);
        // "" = HEAD predates every harness commit: the version with no harness file at all.
        if (v !== undefined) out.set(s.id, v);
      }),
    );
  }
  return out;
}

/** The repo's current harness version: the newest harness commit HEAD reaches ("" when none; undefined when git can't tell). */
export async function currentVersion(root: string): Promise<string | undefined> {
  const r = await run(["rev-list", "-1", "HEAD", "--", ...HARNESS_PATHSPECS], { cwd: root, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function filesAt(root: string, commit: string | undefined, paths: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!commit) return out;
  for (const p of paths) {
    try {
      out[p] = await git(["show", `${commit}:${p}`], { cwd: root });
    } catch {
      // absent at that commit
    }
  }
  return out;
}

// ---------------------------------------------------------------- effects

function group(sessions: readonly Session[]): GroupStats {
  const byFlag: Record<string, number> = {};
  const flaggedSessions: FlaggedSession[] = [];
  const newest = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  for (const s of newest) {
    const flags = diagnosed(s);
    if (!flags.length) continue;
    flaggedSessions.push({ id: s.id, startedAt: s.startedAt, ...(s.title ? { title: s.title } : {}), flags });
    for (const f of flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
  }
  const toolCalls = newest.map((s) => s.stats.toolCalls);
  const durationMs = newest.filter((s) => s.endedAt !== undefined && s.endedAt > s.startedAt).map((s) => s.endedAt! - s.startedAt);
  return { sessions: sessions.length, flagged: flaggedSessions.length, byFlag, examples: newest.slice(0, 5).map((s) => s.id), flaggedSessions, work: { toolCalls, durationMs } };
}

const share = (k: number, n: number): number => (n ? k / n : 0);
const pct = (k: number, n: number): string => `${k} of ${n}`;

/** Shuffles per work permutation test. */
const WORK_SHUFFLES = 2000;
/** After median at least this many times the before median counts as added work. */
const WORK_RATIO = 1.25;

/** A small seeded PRNG (mulberry32), so a report gives the same p every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two-sample permutation test on the difference of mean log1p(x), two-sided, with
 * `shuffles` seeded relabellings. p = (1 + shuffles at least as extreme) / (1 + shuffles),
 * so identical inputs give 1. Pure and deterministic for a given seed.
 */
export function permutationP(before: readonly number[], after: readonly number[], o: { shuffles?: number; seed?: number } = {}): number {
  const xs = [...before, ...after].map((x) => Math.log1p(Math.max(0, x)));
  const nb = before.length;
  const na = after.length;
  if (!nb || !na) return 1;
  const total = xs.reduce((a, b) => a + b, 0);
  const diff = (sumAfter: number) => Math.abs(sumAfter / na - (total - sumAfter) / nb);
  const observed = diff(xs.slice(nb).reduce((a, b) => a + b, 0));
  const shuffles = o.shuffles ?? WORK_SHUFFLES;
  const rand = mulberry32(o.seed ?? 0x5eed);
  const pool = [...xs];
  let extreme = 0;
  for (let k = 0; k < shuffles; k++) {
    // Partial Fisher-Yates: the first na slots become the "after" sample.
    let sum = 0;
    for (let i = 0; i < na; i++) {
      const j = i + Math.floor(rand() * (pool.length - i));
      const t = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = t;
      sum += pool[i]!;
    }
    if (diff(sum) >= observed - 1e-12) extreme++;
  }
  return (1 + extreme) / (1 + shuffles);
}

const median = (xs: readonly number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};

/** Work before vs after: each measure with MIN_AFTER values on both sides whose medians differ (or p ≤ ALPHA); undefined when none. */
export function workEffect(before: GroupStats, after: GroupStats): WorkEffect | undefined {
  const out: WorkEffect = {};
  for (const key of ["toolCalls", "durationMs"] as const) {
    const b = before.work?.[key] ?? [];
    const a = after.work?.[key] ?? [];
    if (b.length < MIN_AFTER || a.length < MIN_AFTER) continue;
    const m = { before: median(b), after: median(a), p: permutationP(b, a) };
    if (m.before !== m.after || m.p <= ALPHA) out[key] = m;
  }
  return out.toolCalls || out.durationMs ? out : undefined;
}

const fmtP = (p: number): string => p.toFixed(2);
const seconds = (ms: number): string => (ms < 10_000 ? (ms / 1000).toFixed(1) : `${Math.round(ms / 1000)}`);

/** The added-work clause ("make more tool calls (median 20 → 45, p 0.00) and take longer (…)"), or undefined when work did not rise. */
function addedWork(w: WorkEffect | undefined): string | undefined {
  const up = (m: WorkMeasure | undefined): m is WorkMeasure => !!m && m.p <= ALPHA && m.after >= WORK_RATIO * m.before && m.after > m.before;
  const parts: string[] = [];
  if (up(w?.toolCalls)) parts.push(`make more tool calls (median ${w.toolCalls.before} → ${w.toolCalls.after}, p ${fmtP(w.toolCalls.p)})`);
  if (up(w?.durationMs)) parts.push(`take longer (median ${seconds(w.durationMs.before)} → ${seconds(w.durationMs.after)} s, p ${fmtP(w.durationMs.p)})`);
  return parts.length ? parts.join(" and ") : undefined;
}

/** Per diagnosed flag: share before vs after, Fisher p, and the Holm-adjusted p within `family`. */
interface FlagMove {
  flag: string;
  before: number;
  after: number;
  /** Holm-adjusted p across the family it was tested in. */
  p: number;
}

/** Every flag in `flags` whose share moved `dir`, significant or not, most significant first. */
function flagMoves(before: GroupStats, after: GroupStats, flags: readonly string[], dir: "down" | "up"): FlagMove[] {
  const raw = flags.map((f) => {
    const b = before.byFlag[f] ?? 0;
    const a = after.byFlag[f] ?? 0;
    return { flag: f, before: b, after: a, p: fisherExact(a, after.sessions - a, b, before.sessions - b) };
  });
  const adj = holm(raw.map((r) => r.p));
  return raw
    .map((r, i) => ({ ...r, p: adj[i]! }))
    .filter((r) => (dir === "down" ? share(r.after, after.sessions) < share(r.before, before.sessions) : share(r.after, after.sessions) > share(r.before, before.sessions)))
    .sort((x, y) => x.p - y.p || x.flag.localeCompare(y.flag));
}

const significant = (m: FlagMove): boolean => m.p <= ALPHA;

/** Verdict and reason from the flagged share, each flag's share, the new rules' effects and the work per session. */
export function decide(before: GroupStats, after: GroupStats, rules: readonly RuleEffect[]): { verdict: Verdict; reason: string; p?: number; work?: WorkEffect } {
  if (!after.sessions) return { verdict: "no-sessions-after", reason: "No captured session ran with this change yet." };
  if (!before.sessions) return { verdict: "no-baseline", reason: `No captured session ran with the version before it, so there is nothing to compare ${after.sessions} session(s) with.` };
  const work = workEffect(before, after);
  const w = work ? { work } : {};
  const p = fisherExact(after.flagged, after.sessions - after.flagged, before.flagged, before.sessions - before.flagged);
  const up = share(after.flagged, after.sessions) > share(before.flagged, before.sessions);
  const down = share(after.flagged, after.sessions) < share(before.flagged, before.sessions);
  const flagText = `flagged sessions ${pct(before.flagged, before.sessions)} before, ${pct(after.flagged, after.sessions)} after`;
  if (up && p <= ALPHA) return { verdict: "regressed", reason: `More sessions went wrong after it: ${flagText} (p ${fmtP(p)}).`, p, ...w };
  const extra = addedWork(work);
  const alsoWork = extra ? ` It also added work: sessions after it ${extra}.` : "";
  // Holm across the flags seen on the side a move starts from (fell) or ends on (rose).
  const fell = flagMoves(before, after, Object.keys(before.byFlag).filter((f) => (before.byFlag[f] ?? 0) > 0).sort(), "down").filter(significant);
  const anyRose = flagMoves(before, after, Object.keys(after.byFlag).filter((f) => (after.byFlag[f] ?? 0) > 0).sort(), "up");
  const rose = anyRose.filter(significant);
  // Helped still names every flag whose share rose, significant or not: "x rose 4 to 8 of 12, not significant."
  const roseText = (m: FlagMove) =>
    `${m.flag} rose ${before.sessions === after.sessions ? `${m.before} to ${pct(m.after, after.sessions)}` : `${pct(m.before, before.sessions)} to ${pct(m.after, after.sessions)}`}${significant(m) ? ` (Holm p ${fmtP(m.p)})` : ", not significant"}`;
  const alsoRose = anyRose.length ? ` ${anyRose.map(roseText).join("; ")}.` : "";
  if (down && p <= ALPHA) return { verdict: "helped", reason: `Fewer sessions went wrong after it: ${flagText} (p ${fmtP(p)}).${alsoRose}${alsoWork}`, p, ...w };
  // One diagnosed flag falling counts when it survives Holm across the flags seen before,
  // the flagged share did not rise, and no other flag rose significantly in its place.
  const counts = (m: FlagMove) => `${pct(m.before, before.sessions)} before, ${pct(m.after, after.sessions)} after`;
  if (fell.length && !up && !rose.length) {
    const f = fell[0]!;
    return { verdict: "helped", reason: `Fewer sessions had ${f.flag} after it: ${counts(f)} (Holm p ${fmtP(f.p)}); ${flagText}.${alsoRose}${alsoWork}`, p, ...w };
  }
  const moved = fell.length && rose.length ? ` ${fell[0]!.flag} fell (${counts(fell[0]!)}) but ${rose[0]!.flag} rose (${counts(rose[0]!)}): the failures moved.` : "";
  const followed = rules.filter((r) => r.p !== undefined && r.p <= ALPHA && share(r.after.acted, r.after.n) > share(r.before.acted, r.before.n));
  const notFallen = `flagged sessions did not ${down ? "clearly " : ""}fall (${pct(before.flagged, before.sessions)} before, ${pct(after.flagged, after.sessions)} after, p ${fmtP(p)})`;
  if (extra) return { verdict: "costlier", reason: `Sessions after it ${extra}, and ${notFallen}.${moved}`, p, ...w };
  if (followed.length) {
    const r = followed[0]!;
    return {
      verdict: "followed-no-effect",
      reason: `The agent follows the new line (${pct(r.after.acted, r.after.n)} sessions after, ${pct(r.before.acted, r.before.n)} before, p ${fmtP(r.p!)}), but ${notFallen}: following a line is not the same as fixing what it targets.${moved}`,
      p,
      ...w,
    };
  }
  const direction = down ? "Looks better" : up ? "Looks worse" : "No difference yet";
  const ruleText = rules.length ? ` The new line was followed in ${pct(rules[0]!.after.acted, rules[0]!.after.n)} sessions after, ${pct(rules[0]!.before.acted, rules[0]!.before.n)} before.` : "";
  if (after.sessions < MIN_AFTER) return { verdict: "too-early", reason: `${direction}, but only ${after.sessions} session(s) ran with it: ${flagText} (p ${fmtP(p)}).${moved}${ruleText}`, p, ...w };
  return { verdict: "no-clear-change", reason: `${direction}, but the difference could be chance: ${flagText} (p ${fmtP(p)}).${moved}${ruleText}`, p, ...w };
}

export interface EffectsOptions {
  limit?: number;
  since?: number;
  /** Events for one session, for rule-following (tool.start, tool.end, file.change). */
  events(sessionId: string): Promise<AgentEvent[]>;
}

/** Each harness change in `root` (newest first) with the sessions before and after it. */
export async function changeEffects(root: string, sessions: readonly Session[], o: EffectsOptions): Promise<ChangeEffect[]> {
  const changes = await harnessChanges(root, { ...(o.limit !== undefined ? { limit: o.limit } : {}), ...(o.since !== undefined ? { since: o.since } : {}) });
  if (!changes.length) return [];
  const versions = await sessionVersions(root, sessions);
  const byVersion = new Map<string, Session[]>();
  for (const s of sessions) {
    const v = versions.get(s.id);
    if (v === undefined) continue;
    const list = byVersion.get(v) ?? [];
    list.push(s);
    byVersion.set(v, list);
  }
  const eventsCache = new Map<string, Promise<AgentEvent[]>>();
  const eventsOf = (id: string) => {
    let p = eventsCache.get(id);
    if (!p) eventsCache.set(id, (p = o.events(id)));
    return p;
  };
  // Only sessions that did work count: one with no tool call outside MCP servers (a chat, or
  // asking coding.sh's MCP tools whether a change helped) can't show what the harness changed.
  const workCache = new Map<string, Promise<boolean>>();
  const isWork = (s: Session): Promise<boolean> => {
    if (!s.stats.toolCalls) return Promise.resolve(false);
    let p = workCache.get(s.id);
    if (!p) workCache.set(s.id, (p = eventsOf(s.id).then((evs) => withoutMcp(evs).some((e) => e.kind === "tool.start"))));
    return p;
  };
  const working = async (list: readonly Session[]): Promise<Session[]> => {
    const kept: Session[] = [];
    for (let i = 0; i < list.length; i += 16) {
      const part = list.slice(i, i + 16);
      const keep = await Promise.all(part.map(isWork));
      kept.push(...part.filter((_, k) => keep[k]));
    }
    return kept;
  };
  const out: ChangeEffect[] = [];
  for (const c of changes) {
    const afterAll = byVersion.get(c.commit) ?? [];
    const beforeAll = byVersion.get(c.previous ?? "") ?? [];
    const after = await working(afterAll);
    const before = await working(beforeAll);
    const paths = c.files.map((f) => f.path);
    const [oldFiles, newFiles] = await Promise.all([filesAt(root, c.previous ?? (await parentOf(root, c.commit)), paths), filesAt(root, c.commit, paths)]);
    const added = diffDirectives(oldFiles, newFiles).added;
    const rules: RuleEffect[] = [];
    for (const d of added.slice(0, 5)) rules.push(await ruleEffect(d, before, after, eventsOf));
    const b = withIdle(group(before), beforeAll.length - before.length);
    const a = withIdle(group(after), afterAll.length - after.length);
    out.push({ change: c, before: b, after: a, rules, ...decide(b, a, rules) });
  }
  return out;
}

function withIdle(g: GroupStats, idle: number): GroupStats {
  return idle > 0 ? { ...g, idle } : g;
}

async function parentOf(root: string, commit: string): Promise<string | undefined> {
  const r = await run(["rev-parse", "--verify", "-q", `${commit}^`], { cwd: root, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Events without MCP tool calls (start and end), which a context-file rule is not about. */
export function withoutMcp(events: readonly AgentEvent[]): AgentEvent[] {
  const isMcp = (e: AgentEvent) => !!e.payload?.server || /^mcp__/.test(String(e.payload?.tool ?? ""));
  const ids = new Set(events.filter((e) => e.kind === "tool.start" && isMcp(e)).map((e) => e.payload?.toolUseId).filter((x) => x !== undefined && x !== ""));
  return events.filter((e) => !(e.kind.startsWith("tool.") && (isMcp(e) || ids.has(e.payload?.toolUseId))));
}

async function ruleEffect(d: Directive, before: readonly Session[], after: readonly Session[], events: (id: string) => Promise<AgentEvent[]>): Promise<RuleEffect> {
  const count = async (list: readonly Session[]) => {
    let acted = 0;
    let n = 0;
    for (const s of [...list].sort((x, y) => y.startedAt - x.startedAt).slice(0, RULE_SESSIONS)) {
      // Calls to MCP servers (this one included) are not the work a rule is about: a session that made only those is not scored.
      const r = directiveOutcome(d, withoutMcp(await events(s.id)));
      if (r.acted === null) continue;
      n++;
      if (r.acted) acted++;
    }
    return { acted, n };
  };
  const b = await count(before);
  const a = await count(after);
  const p = a.n && b.n ? fisherExact(a.acted, a.n - a.acted, b.acted, b.n - b.acted) : undefined;
  return { text: d.text, path: d.path, line: d.line, polarity: d.polarity, before: b, after: a, ...(p !== undefined ? { p } : {}) };
}
