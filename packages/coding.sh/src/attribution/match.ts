// The matcher: which captured session wrote each line a commit added.
//
// Input: commits oldest first (git.ts readCommits), and for each session the
// lines it added per file as LineKeys (sources.ts). Each session's lines form
// a pool with counts; a commit line that matches takes one from the pool, so
// a line the agent wrote once is credited once, and a person who later types
// the same line again in another commit is not credited to the agent.
//
// Per commit, per file, in order:
// 1. patch-id fast path: when the file's change (removed + added lines,
//    whitespace and line numbers ignored) equals what one session did to the
//    same file, every added line is that session's. A rebase keeps the id.
// 2. line hash: each non-trivial added line goes to an eligible session whose
//    pool has the same line in the same file; else, for long lines (24+
//    characters), to one that has it in another file (a moved file).
// 3. trivial lines (`}`, `else`, blank) go to the session of the nearest
//    matched line in the same run of added lines, when that session's pool
//    has them too. On their own they never match.
// 4. git-ai notes, when present, credit lines the steps above left unmatched.
//
// A session is eligible for a commit when it started before the commit (10
// minutes of clock skew allowed) and the commit was authored or committed
// within 21 days of its start. Of several eligible sessions, the one that
// started last wins: it is the most recent writer. Lines no session matches
// belong to no session: a person wrote them, or an agent coding.sh did not
// capture.
import type { CommitPatch } from "./git.ts";
import { gitAiAgent, parseGitAiNote } from "./gitai.ts";
import { contentHash, filePatchId, isLongKey, isTrivialKey, type LineKey } from "./lines.ts";

export const DEFAULT_WINDOW_MS = 21 * 24 * 3600_000;
export const CLOCK_SKEW_MS = 10 * 60_000;

/** How a session's lines for one file were found. */
export type SourceVia = "snapshot" | "snapshot-head" | "replay";

export interface SourceFile {
  path: string;
  /** Keys of the lines the session added to this file, in order. */
  keys: LineKey[];
  /** filePatchId of what the session did to this file (snapshot sources). */
  patchId?: string;
  via: SourceVia;
  /** A file.change event or an edit tool call named this file. */
  edited?: boolean;
}

export interface SessionSource {
  sessionId: string;
  agent: string;
  model?: string;
  startedAt: number;
  files: SourceFile[];
}

export type AttributionMethod = "patch-id" | "line-hash" | "moved" | "git-ai";

export interface AttributedRange {
  start: number;
  end: number;
  /** sha256 of the range's normalized lines (Agent Trace content_hash). */
  contentHash: string;
}

/** The lines of one file in one commit that one session wrote. */
export interface Attribution {
  commit: string;
  path: string;
  ranges: AttributedRange[];
  lines: number;
  sessionId: string;
  agent: string;
  model?: string;
  /** 0..1: how sure the match is (snapshot sources and same-file matches score highest). */
  confidence: number;
  /** How most of the lines matched. */
  method: AttributionMethod;
  /** "git-ai" when the lines came from a git-ai note rather than a captured session. */
  source: "coding.sh" | "git-ai";
}

export interface CommitAttribution {
  commit: string;
  parents: string[];
  subject: string;
  author: string;
  committedAt: number;
  authoredAt: number;
  /** Lines the commit added (text files). */
  added: number;
  /** Of those, lines credited to a session. */
  attributed: number;
  attributions: Attribution[];
}

export interface MatchOptions {
  windowMs?: number;
  skewMs?: number;
}

const BASE_CONFIDENCE: Record<SourceVia, number> = { snapshot: 1, "snapshot-head": 0.9, replay: 0.8 };
/** A file the session's tools never named (a Bash write, or someone else's edit in the same tree). */
const UNNAMED_FACTOR = 0.85;
const MOVED_FACTOR = 0.8;
const TRIVIAL_FACTOR = 0.95;
const GIT_AI_CONFIDENCE = 0.9;

interface Pool {
  src: SessionSource;
  /** path → key → remaining count */
  byPath: Map<string, Map<LineKey, number>>;
  /** key → paths that still have it */
  byKey: Map<LineKey, Set<string>>;
  file: Map<string, SourceFile>;
  /** The session's tools named at least one file. */
  anyEdited: boolean;
}

function makePool(src: SessionSource): Pool {
  const byPath = new Map<string, Map<LineKey, number>>();
  const byKey = new Map<LineKey, Set<string>>();
  const file = new Map<string, SourceFile>();
  for (const f of src.files) {
    file.set(f.path, f);
    const m = byPath.get(f.path) ?? new Map<LineKey, number>();
    byPath.set(f.path, m);
    for (const k of f.keys) {
      m.set(k, (m.get(k) ?? 0) + 1);
      let s = byKey.get(k);
      if (!s) byKey.set(k, (s = new Set()));
      s.add(f.path);
    }
  }
  return { src, byPath, byKey, file, anyEdited: src.files.some((f) => f.edited) };
}

function take(p: Pool, path: string, key: LineKey): boolean {
  const m = p.byPath.get(path);
  const n = m?.get(key) ?? 0;
  if (n <= 0) return false;
  if (n === 1) {
    m!.delete(key);
    p.byKey.get(key)?.delete(path);
  } else m!.set(key, n - 1);
  return true;
}

/** Take the key from any file of the session; returns the file it came from. */
function takeAnywhere(p: Pool, key: LineKey): string | undefined {
  const paths = p.byKey.get(key);
  if (!paths) return undefined;
  for (const path of [...paths].sort()) if (take(p, path, key)) return path;
  return undefined;
}

function fileConfidence(p: Pool, path: string): number {
  const f = p.file.get(path);
  if (!f) return BASE_CONFIDENCE.replay;
  const base = BASE_CONFIDENCE[f.via];
  return p.anyEdited && !f.edited ? base * UNNAMED_FACTOR : base;
}

interface LineHit {
  pool?: Pool;
  /** git-ai credit with no captured session. */
  gitAi?: { sessionId: string; agent: string; model?: string };
  conf: number;
  method: AttributionMethod;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Attribute every commit's added lines to sessions. Commits must be oldest first. */
export function matchCommits(commits: readonly CommitPatch[], sessions: readonly SessionSource[], opts: MatchOptions = {}): CommitAttribution[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const skewMs = opts.skewMs ?? CLOCK_SKEW_MS;
  // Latest start first: the most recent writer wins a line several sessions added.
  const pools = sessions.map(makePool).sort((a, b) => b.src.startedAt - a.src.startedAt || (a.src.sessionId < b.src.sessionId ? -1 : 1));
  const byId = new Map(pools.map((p) => [p.src.sessionId, p]));
  const out: CommitAttribution[] = [];

  for (const c of commits) {
    const t0 = Math.min(c.authoredAt, c.committedAt);
    const t1 = Math.max(c.authoredAt, c.committedAt);
    const eligible = pools.filter((p) => p.src.startedAt - skewMs <= t1 && t0 <= p.src.startedAt + windowMs);
    const gitAi = c.note ? parseGitAiNote(c.note) : [];
    let added = 0;
    const attributions: Attribution[] = [];

    for (const f of c.files) {
      if (f.binary || f.deleted || !f.added.length) continue;
      added += f.added.length;
      const hits: (LineHit | undefined)[] = new Array(f.added.length);

      // 1. patch-id fast path
      const pid = filePatchId(f);
      if (pid) {
        for (const p of eligible) {
          const sf = p.file.get(f.path);
          if (sf?.patchId !== pid) continue;
          const m = p.byPath.get(f.path);
          const need = new Map<LineKey, number>();
          for (const a of f.added) need.set(a.key, (need.get(a.key) ?? 0) + 1);
          if (![...need].every(([k, n]) => (m?.get(k) ?? 0) >= n)) continue;
          const conf = fileConfidence(p, f.path);
          f.added.forEach((a, i) => {
            take(p, f.path, a.key);
            hits[i] = { pool: p, conf, method: "patch-id" };
          });
          break;
        }
      }

      // 2. line hash, same file first, then (long lines) any file of the session
      if (!hits[0]) {
        f.added.forEach((a, i) => {
          if (isTrivialKey(a.key)) return;
          for (const p of eligible) {
            if (take(p, f.path, a.key)) {
              hits[i] = { pool: p, conf: fileConfidence(p, f.path), method: "line-hash" };
              return;
            }
          }
          if (!isLongKey(a.key)) return;
          for (const p of eligible) {
            const from = takeAnywhere(p, a.key);
            if (from !== undefined) {
              hits[i] = { pool: p, conf: fileConfidence(p, from) * MOVED_FACTOR, method: "moved" };
              return;
            }
          }
        });

        // 3. trivial lines follow the nearest matched line in the same run of added lines
        f.added.forEach((a, i) => {
          if (hits[i] || !isTrivialKey(a.key)) return;
          for (const j of neighbors(f.added, i)) {
            const h = hits[j];
            if (!h?.pool || isTrivialKey(f.added[j]!.key)) continue;
            if (take(h.pool, f.path, a.key)) hits[i] = { pool: h.pool, conf: h.conf * TRIVIAL_FACTOR, method: h.method };
            return;
          }
        });
      }

      // 4. git-ai notes fill what is left
      if (gitAi.length) {
        const lineIdx = new Map(f.added.map((a, i) => [a.line, i]));
        for (const g of gitAi) {
          if (g.path !== f.path || !g.sessionId) continue;
          const known = byId.get(g.sessionId);
          for (const [a, b] of g.ranges) {
            for (let ln = a; ln <= b; ln++) {
              const i = lineIdx.get(ln);
              if (i === undefined || hits[i]) continue;
              hits[i] = known
                ? { pool: known, conf: GIT_AI_CONFIDENCE, method: "git-ai" }
                : { gitAi: { sessionId: g.sessionId, agent: gitAiAgent(g.tool), model: g.model }, conf: GIT_AI_CONFIDENCE, method: "git-ai" };
            }
          }
        }
      }

      attributions.push(...group(c.sha, f.path, f.added, hits));
    }
    out.push({
      commit: c.sha,
      parents: c.parents,
      subject: c.subject,
      author: c.author,
      committedAt: c.committedAt,
      authoredAt: c.authoredAt,
      added,
      attributed: attributions.reduce((n, a) => n + a.lines, 0),
      attributions,
    });
  }
  return out;
}

/** Indices of the run of consecutive added lines around i, nearest first (before wins a tie). */
function* neighbors(added: readonly { line: number }[], i: number): Generator<number> {
  let lo = i;
  while (lo > 0 && added[lo - 1]!.line === added[lo]!.line - 1) lo--;
  let hi = i;
  while (hi < added.length - 1 && added[hi + 1]!.line === added[hi]!.line + 1) hi++;
  for (let d = 1; i - d >= lo || i + d <= hi; d++) {
    if (i - d >= lo) yield i - d;
    if (i + d <= hi) yield i + d;
  }
}

/** One Attribution per session for this file, with contiguous ranges. */
function group(commit: string, path: string, added: readonly { line: number; key: LineKey }[], hits: readonly (LineHit | undefined)[]): Attribution[] {
  const bySession = new Map<string, { hit: LineHit; idx: number[] }>();
  hits.forEach((h, i) => {
    if (!h) return;
    const id = h.pool ? h.pool.src.sessionId : h.gitAi!.sessionId;
    const g = bySession.get(id) ?? { hit: h, idx: [] };
    bySession.set(id, g);
    g.idx.push(i);
  });
  const out: Attribution[] = [];
  for (const [sessionId, { hit, idx }] of bySession) {
    const ranges: AttributedRange[] = [];
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      ranges.push({ start: added[run[0]!]!.line, end: added[run.at(-1)!]!.line, contentHash: contentHash(run.map((i) => added[i]!.key)) });
      run = [];
    };
    for (const i of idx) {
      if (run.length && added[i]!.line !== added[run.at(-1)!]!.line + 1) flush();
      run.push(i);
    }
    flush();
    const methods = new Map<AttributionMethod, number>();
    let conf = 0;
    for (const i of idx) {
      const h = hits[i]!;
      conf += h.conf;
      methods.set(h.method, (methods.get(h.method) ?? 0) + 1);
    }
    const method = [...methods].sort((a, b) => b[1] - a[1])[0]![0];
    const who = hit.pool ? { agent: hit.pool.src.agent, model: hit.pool.src.model } : { agent: hit.gitAi!.agent, model: hit.gitAi!.model };
    out.push({
      commit,
      path,
      ranges,
      lines: idx.length,
      sessionId,
      agent: who.agent,
      ...(who.model ? { model: who.model } : {}),
      confidence: round2(conf / idx.length),
      method,
      source: hit.pool ? "coding.sh" : "git-ai",
    });
  }
  return out.sort((a, b) => a.ranges[0]!.start - b.ranges[0]!.start);
}
