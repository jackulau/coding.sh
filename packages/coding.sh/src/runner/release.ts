// The agent release each run ran on (AD-13). Agents ship often (twelve Claude
// Code releases in 20 days) and auto-update, and 29% of release transitions
// change the agent's own instructions or tools (Paixao et al., arXiv
// 2610.37332). A harness A/B whose arms ran on different releases measures the
// change and the release together, so compare records the release per run and
// says when the arms differ.
import type { RunResult, Session } from "../core/types.ts";

/** How long a detected release is trusted before the agent is asked again. */
export const RELEASE_TTL_MS = 60_000;

/**
 * A memo of `detect().version` per agent that expires after `ttlMs`, so an
 * auto-update during a long comparison shows up on the runs after it. A
 * detect() that throws or reports no version gives undefined.
 */
export function releaseCache(o: { ttlMs?: number; now?: () => number } = {}): (agent: string, detect: () => Promise<{ version?: string }>) => Promise<string | undefined> {
  const ttl = o.ttlMs ?? RELEASE_TTL_MS;
  const now = o.now ?? Date.now;
  const memo = new Map<string, { at: number; version: Promise<string | undefined> }>();
  return (agent, detect) => {
    const t = now();
    const hit = memo.get(agent);
    if (hit && t - hit.at < ttl) return hit.version;
    let version: Promise<string | undefined>;
    try {
      version = detect().then(
        (d) => d.version || undefined,
        () => undefined,
      );
    } catch {
      version = Promise.resolve(undefined);
    }
    memo.set(agent, { at: t, version });
    return version;
  };
}

/** A run's release: what its captured session says, else what detect() said when it started. */
export function runRelease(r: RunResult, s: Session | undefined): string | undefined {
  return s?.agentVersion || r.agentVersion || undefined;
}

export interface ReleaseMix {
  /** Valid runs per release, per arm. */
  baseline: Record<string, number>;
  candidate: Record<string, number>;
  /** Valid runs with no known release, per arm. */
  unknown: { baseline: number; candidate: number };
  /** Tasks whose runs (both arms) ran on more than one release. */
  splitTasks: number;
}

/** Releases of each arm's (valid) runs; the captured session's release wins over the recorded one. */
export function releaseMix(A: readonly RunResult[], B: readonly RunResult[], sessions?: ReadonlyMap<string, Session>): ReleaseMix {
  const byTask = new Map<string, Set<string>>();
  const count = (rs: readonly RunResult[]) => {
    const out: Record<string, number> = {};
    let unknown = 0;
    for (const r of rs) {
      const v = runRelease(r, sessions?.get(r.id));
      if (!v) {
        unknown++;
        continue;
      }
      out[v] = (out[v] ?? 0) + 1;
      byTask.set(r.taskId, (byTask.get(r.taskId) ?? new Set()).add(v));
    }
    return { out, unknown };
  };
  const a = count(A);
  const b = count(B);
  return {
    baseline: sortKeys(a.out),
    candidate: sortKeys(b.out),
    unknown: { baseline: a.unknown, candidate: b.unknown },
    splitTasks: [...byTask.values()].filter((s) => s.size > 1).length,
  };
}

/**
 * "arms-differ": the arms ran on different sets of releases, so B − A mixes
 * the change with the release. "mixed": both arms ran on the same two or more
 * releases (the agent updated mid-comparison and interleaving spread it).
 */
export type ReleaseConfound = "arms-differ" | "mixed";

export interface AgentVersions extends ReleaseMix {
  /** The agent both arms run, when they run the same one. */
  agent?: string;
  /** Absent when both arms ran on one release, the arms run different agents, or under half of an arm's runs have a known release. */
  confound?: ReleaseConfound;
}

/** The release report for two arms; undefined when no valid run has a known release. */
export function agentVersions(A: readonly RunResult[], B: readonly RunResult[], sessions: ReadonlyMap<string, Session> | undefined, agents: { baseline?: string; candidate?: string } = {}): AgentVersions | undefined {
  const mix = releaseMix(A, B, sessions);
  const ka = Object.keys(mix.baseline);
  const kb = Object.keys(mix.candidate);
  if (!ka.length && !kb.length) return undefined;
  const sameAgent = !agents.baseline || !agents.candidate || agents.baseline === agents.candidate;
  const agent = sameAgent ? (agents.baseline ?? agents.candidate) : undefined;
  // Too little known to say anything: an arm with under half its runs on a known release.
  const enough = (known: number, unknown: number) => known > 0 && known >= unknown;
  const na = A.length - mix.unknown.baseline;
  const nb = B.length - mix.unknown.candidate;
  let confound: ReleaseConfound | undefined;
  if (sameAgent && enough(na, mix.unknown.baseline) && enough(nb, mix.unknown.candidate)) {
    if (ka.join("\u0000") !== kb.join("\u0000")) confound = "arms-differ";
    else if (ka.length > 1) confound = "mixed";
  }
  return { ...mix, ...(agent ? { agent } : {}), ...(confound ? { confound } : {}) };
}

/** `2.1.316 (12 runs)` or `2.1.316 (6 runs) and 2.1.319 (6 runs)`. */
export function releaseList(m: Record<string, number>, short = false): string {
  const parts = Object.entries(m).map(([v, n]) => (short ? `${v} ×${n}` : `${v} (${n} run${n === 1 ? "" : "s"})`));
  if (short || parts.length < 2) return parts.join(", ");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The report note for a release confound; undefined without one. */
export function releaseNote(v: AgentVersions | undefined): string | undefined {
  if (!v?.confound) return undefined;
  const who = v.agent ? `${v.agent} ` : "";
  if (v.confound === "arms-differ") {
    return (
      `baseline ran on ${who}${releaseList(v.baseline)}, candidate on ${who}${releaseList(v.candidate)}; ` +
      `the agent release differs between arms, so the delta mixes your change with the release. ` +
      `Rerun both arms together on one release, with the agent's auto-update off`
    );
  }
  const versions = Object.keys(v.baseline);
  return (
    `both arms ran on ${who}${versions.slice(0, -1).join(", ")} and ${versions.at(-1)}: the release changed mid-comparison` +
    `${v.splitTasks ? ` (${v.splitTasks} task${v.splitTasks === 1 ? "" : "s"} ran on more than one)` : ""}. ` +
    `Interleaved runs spread it across both arms, but each task's result can mix in the release`
  );
}

function sortKeys(m: Record<string, number>): Record<string, number> {
  const cmp = (x: string, y: string) => x.localeCompare(y, "en", { numeric: true });
  return Object.fromEntries(Object.entries(m).sort(([x], [y]) => cmp(x, y)));
}
