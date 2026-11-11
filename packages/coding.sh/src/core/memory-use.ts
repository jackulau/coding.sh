// Session.stats.memoryUse: what a session's events say about memory and
// instruction files, kept by the session fold so `harness audit` reads session
// rows instead of every event (EZ-6: the events of 3,600 sessions took 10 s and
// more to read, however narrow the read).
//
// The audit (core/memory-audit.ts auditMemory) must count the same from this
// as from the events, so the fold keeps what memoryOps reads of each event and
// drops only what cannot change a count:
// - a path that is no memory or instruction file wherever the home is
//   (memoryKind of the resolved path: the audit's own test, on a `~/…` key,
//   passes no path this one fails);
// - a repeat of the same use of the same file: the audit keeps one mark per
//   session and the latest time, so the first place and the last time stay;
// - an earlier naming of the same skill: the audit matches a name to the
//   SKILL.md files it knows by then, which only grow, so the last naming
//   marks all an earlier one did, and it is the one kept.
// The order of what is left is the events' order.
//
// A relative path needs the session's directory, the first one an event
// carries. Until the fold has it such a path waits as written (only one that
// could name a memory file: MEMORY_PATH_TEXT) and is resolved when the session is built.
//
// sessions.ts imports this file and memory-audit.ts imports sessions.ts: only
// inside functions, as with skills-use.ts.
import type { AgentEvent, MemoryUse } from "../schema/index.ts";
import { memoryKind, memoryOps, resolvePath } from "./memory-audit.ts";
import { MEMORY_EVENT_KINDS, MEMORY_PATH_TEXT } from "./memory-events.ts";

/** Where and when one use was seen: its place in the order, and its last time. */
type Seen = [seq: number, ts: number];

export interface MemoryUseState {
  /** The next place in the order. */
  n: number;
  /** By `<use>\n<absolute path>`, a file: its first place. By `<use>\n\n<path as written>`, a relative path waiting for the session's directory. */
  paths: Record<string, Seen>;
  /** By `<by>\n<name>`, a skill named without a path: its last place. */
  skills: Record<string, Seen>;
}

export function memoryUseState(): MemoryUseState {
  return { n: 0, paths: {}, skills: {} };
}

const WAITING = "\n";
/** The audit's test of a resolved path, before it knows the home (homeKey drops a trailing slash first). */
const isMemoryPath = (abs: string): boolean => memoryKind(abs.replace(/\/+$/, "")) !== undefined;

/** Folds the next event, in time order. `cwd`: the session's directory, once an earlier event gave it. */
export function foldMemoryUse(s: MemoryUseState, e: AgentEvent, cwd: string | undefined): void {
  if (!MEMORY_EVENT_KINDS.includes(e.kind)) return;
  for (const op of memoryOps(e)) {
    if (op.skill !== undefined) {
      const key = `${op.by}\n${op.skill}`;
      s.skills[key] = [s.n++, Math.max(s.skills[key]?.[1] ?? 0, op.ts)];
      continue;
    }
    const abs = resolvePath(op.path!, cwd);
    let key: string;
    if (abs !== undefined) {
      if (!isMemoryPath(abs)) continue;
      key = `${op.use}\n${abs}`;
    } else if (cwd === undefined && op.path!.includes(MEMORY_PATH_TEXT)) key = `${op.use}\n${WAITING}${op.path}`;
    else continue;
    const seen = s.paths[key];
    if (seen) seen[1] = Math.max(seen[1], op.ts);
    else s.paths[key] = [s.n++, op.ts];
  }
}

/** The session's stats.memoryUse, or undefined when its events name no memory or instruction file. `cwd`: the session's directory. */
export function memoryUseOf(s: MemoryUseState, cwd: string | undefined): MemoryUse[] | undefined {
  const all: { seq: number; use: MemoryUse }[] = [];
  const files = new Map<string, MemoryUse>();
  for (const [key, [seq, ts]] of Object.entries(s.paths).sort((a, b) => a[1][0] - b[1][0])) {
    const cut = key.indexOf("\n");
    const use = key.slice(0, cut) as MemoryUse["use"];
    let path: string | undefined = key.slice(cut + 1);
    if (path.startsWith(WAITING)) {
      path = resolvePath(path.slice(WAITING.length), cwd);
      if (path === undefined || !isMemoryPath(path)) continue;
    }
    const had = files.get(`${use}\n${path}`);
    if (had) had.ts = Math.max(had.ts, ts);
    else {
      const u: MemoryUse = { use, path, ts };
      files.set(`${use}\n${path}`, u);
      all.push({ seq, use: u });
    }
  }
  for (const [key, [seq, ts]] of Object.entries(s.skills)) {
    const cut = key.indexOf("\n");
    all.push({ seq, use: { use: "read", skill: key.slice(cut + 1), by: key.slice(0, cut) as "tool" | "harness", ts } });
  }
  return all.length ? all.sort((a, b) => a.seq - b.seq).map((x) => x.use) : undefined;
}

/** stats.memoryUse of a whole session's events (any order), as the fold gives it. */
export function memoryUseOfEvents(events: readonly AgentEvent[], cwd: string | undefined): MemoryUse[] | undefined {
  const s = memoryUseState();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) foldMemoryUse(s, e, cwd);
  return memoryUseOf(s, cwd);
}
