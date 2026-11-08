// Durable long jobs (exp run / sweep, compare, bench run, workflows run).
// Agent trials can take hours, so every job checkpoints each finished trial as
// it finishes, and a job killed by Ctrl-C, a crash, a reboot or a killed remote
// shell resumes where it stopped:
//
//   <root>/jobs/<id>.json    header: kind, name, config hash, plan size,
//                            runner state (seed, ids), status; rewritten atomically
//   <root>/jobs/<id>.jsonl   one appended line per finished trial (the trial's
//                            own record in `data`); the last line per key wins
//
// A trial cut short by an interrupt is never written, so it runs again on
// resume. A trial whose last attempt still hit an infrastructure error (rate
// limit, 5xx, network) is written with `infra` set: its outcome is unknown, it
// stays out of the statistics, and a resume runs it again.
//
// Liveness: the owner refreshes the header's mtime every HEARTBEAT_MS. A job
// that says "running" but whose owner is a dead pid on this host, or whose
// heartbeat is older than STALE_MS (reboot, pid reuse, another host), reads as
// "interrupted".
import { appendFile, mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { paths } from "../core/paths.ts";
import { writeFileDurable } from "../store/durable.ts";
import type { InfraKind } from "./retry.ts";

export type JobKind = "exp run" | "exp ab" | "exp replay" | "exp aa" | "exp sweep" | "exp matrix" | "compare" | "bench run" | "workflows run" | "refine run";

/**
 * running: the owner is alive. interrupted: stopped before every trial ran
 * (Ctrl-C, SIGTERM, crash, reboot). incomplete: every trial ran but some hit
 * infrastructure errors after their retries (a resume re-runs those).
 * completed: every trial finished.
 */
export type JobStatus = "running" | "interrupted" | "incomplete" | "completed";

export interface JobConfig {
  /** sha256 over every part: a resume needs the same hash. */
  hash: string;
  /** Per-part hashes, so a refused resume can say what changed. */
  parts: Record<string, string>;
}

export interface JobSession {
  pid: number;
  host: string;
  startedAt: number;
  endedAt?: number;
}

export interface JobHeader {
  v: 1;
  id: string;
  kind: JobKind;
  name: string;
  config: JobConfig;
  /** Trials the plan holds (a sweep revises it once the race picks a winner). */
  total: number;
  /** Trials at once, for the ETA. */
  concurrency: number;
  createdAt: number;
  updatedAt: number;
  /** As last written; see liveStatus for what it means now. */
  status: JobStatus;
  /** One per start or resume; the last is the current owner. */
  sessions: JobSession[];
  /** The command line that started it (resume hints). */
  command?: string[];
  /** Ids of the records it produces (experiments, runs), so `--resume <id>` finds the job by those too. */
  refs: string[];
  /** Runner state that a resume must reuse (seed, experiment ids), by scope. */
  state: Record<string, unknown>;
}

export interface TrialLine {
  key: string;
  /** When the trial finished. */
  at: number;
  /** Wall time, retries and backoff included. */
  ms: number;
  /** Attempts the trial took (only when more than one). */
  attempts?: number;
  costUsd?: number;
  /** The last attempt still hit an infrastructure error: outcome unknown, re-run on resume. */
  infra?: InfraKind;
  outcome?: "pass" | "fail" | "error";
  /** The runner's own record of the trial (a CaseRun, a Cell, a run id). */
  data?: unknown;
}

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 5 * 60_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function checkId(id: string): string {
  if (!ID.test(id) || id.includes("..")) throw new Error(`invalid job id ${JSON.stringify(id)}`);
  return id;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a header's status means now: a "running" job with no live owner was interrupted. */
export function liveStatus(h: JobHeader, heartbeatAt: number, now = Date.now()): JobStatus {
  if (h.status !== "running") return h.status;
  const owner = h.sessions.at(-1);
  if (!owner) return "interrupted";
  if (now - heartbeatAt > STALE_MS) return "interrupted";
  if (owner.host === hostname() && owner.pid !== process.pid && !pidAlive(owner.pid)) return "interrupted";
  return "running";
}

/** Lines of a job log, last line per key; a torn last line (killed mid-write) is skipped. */
export function parseLines(text: string): Map<string, TrialLine> {
  const out = new Map<string, TrialLine>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as TrialLine;
      if (v && typeof v.key === "string") {
        out.delete(v.key); // re-insert so the map keeps the order trials last finished in
        out.set(v.key, v);
      }
    } catch {
      // partial line
    }
  }
  return out;
}

export interface JobProgress {
  /** Trials finished with a known outcome. */
  done: number;
  /** Trials whose last attempt hit an infrastructure error (run again on resume). */
  infra: number;
  total: number;
  /** Extra attempts infra retries took, over every trial. */
  retries: number;
  /** Cost of the trials that report one, and how many did. */
  costUsd: number;
  costKnown: number;
  /** Since the job was created, idle time between sessions left out. */
  activeMs: number;
  /** Remaining time at the current pace; undefined when it can't be told (nothing ran yet, or not running). */
  etaMs?: number;
}

/** Progress, ETA and cost so far, from the header and its trial lines. */
export function progressOf(h: JobHeader, lines: ReadonlyMap<string, TrialLine>, status: JobStatus, now = Date.now()): JobProgress {
  let done = 0;
  let infra = 0;
  let retries = 0;
  let costUsd = 0;
  let costKnown = 0;
  let msSum = 0;
  for (const l of lines.values()) {
    if (l.infra) infra++;
    else {
      done++;
      msSum += l.ms;
    }
    if (l.attempts && l.attempts > 1) retries += l.attempts - 1;
    if (typeof l.costUsd === "number" && Number.isFinite(l.costUsd)) {
      costUsd += l.costUsd;
      costKnown++;
    }
  }
  const activeMs = h.sessions.reduce((s, x) => s + Math.max(0, (x.endedAt ?? (status === "running" ? now : h.updatedAt)) - x.startedAt), 0);
  const p: JobProgress = { done, infra, total: h.total, retries, costUsd, costKnown, activeMs };
  const left = Math.max(0, h.total - done);
  if (status === "running" && left > 0) {
    const cur = h.sessions.at(-1);
    const since = cur ? [...lines.values()].filter((l) => l.at >= cur.startedAt && !l.infra).length : 0;
    if (cur && since > 0) p.etaMs = (left * (now - cur.startedAt)) / since;
    else if (done > 0) p.etaMs = (left * (msSum / done)) / Math.max(1, h.concurrency);
  } else if (left === 0 && status === "running") p.etaMs = 0;
  return p;
}

export interface JobView {
  header: JobHeader;
  status: JobStatus;
  lines: Map<string, TrialLine>;
  progress: JobProgress;
}

export class JobStore {
  readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, "jobs");
  }

  static forEnv(env?: NodeJS.ProcessEnv): JobStore {
    return new JobStore(paths(env).root);
  }

  headerPath(id: string): string {
    return join(this.dir, `${checkId(id)}.json`);
  }
  logPath(id: string): string {
    return join(this.dir, `${checkId(id)}.jsonl`);
  }

  private async readHeader(id: string): Promise<{ header: JobHeader; heartbeatAt: number } | undefined> {
    try {
      const file = this.headerPath(id);
      const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      const header = JSON.parse(text) as JobHeader;
      if (header?.v !== 1 || header.id !== id) return undefined;
      return { header, heartbeatAt: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async readLines(id: string): Promise<Map<string, TrialLine>> {
    try {
      return parseLines(await readFile(this.logPath(id), "utf8"));
    } catch {
      return new Map();
    }
  }

  /** A job with its live status and progress; undefined when there is none. */
  async get(id: string, now = Date.now()): Promise<JobView | undefined> {
    if (!ID.test(id)) return undefined;
    const r = await this.readHeader(id);
    if (!r) return undefined;
    const lines = await this.readLines(id);
    const status = liveStatus(r.header, r.heartbeatAt, now);
    return { header: r.header, status, lines, progress: progressOf(r.header, lines, status, now) };
  }

  /** By job id, else the job that produced the record with this id (an experiment or run id). */
  async find(ref: string): Promise<JobView | undefined> {
    const direct = await this.get(ref);
    if (direct) return direct;
    return (await this.list()).find((j) => j.header.refs.includes(ref));
  }

  /** Every job, newest first (ids sort by time within a prefix, so order by createdAt). */
  async list(filter: { kind?: JobKind } = {}): Promise<JobView[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: JobView[] = [];
    for (const f of files) {
      const v = await this.get(f.slice(0, -".json".length));
      if (v && (!filter.kind || v.header.kind === filter.kind)) out.push(v);
    }
    return out.sort((a, b) => b.header.createdAt - a.header.createdAt || (a.header.id < b.header.id ? 1 : -1));
  }

  /** Start a new job owned by this process. */
  async create(o: { id: string; kind: JobKind; name: string; config: JobConfig; total: number; concurrency: number; command?: string[]; now?: number }): Promise<Job> {
    const now = o.now ?? Date.now();
    const header: JobHeader = {
      v: 1,
      id: checkId(o.id),
      kind: o.kind,
      name: o.name,
      config: o.config,
      total: o.total,
      concurrency: o.concurrency,
      createdAt: now,
      updatedAt: now,
      status: "running",
      sessions: [{ pid: process.pid, host: hostname(), startedAt: now }],
      ...(o.command ? { command: o.command } : {}),
      refs: [],
      state: {},
    };
    await mkdir(this.dir, { recursive: true });
    const job = new Job(this, header, new Map());
    await job.save();
    return job;
  }

  /** Delete a job (one that failed before any trial ran). */
  async remove(id: string): Promise<void> {
    await rm(this.logPath(id), { force: true });
    await rm(this.headerPath(id), { force: true });
  }

  /** Take over an existing job (a resume): a new session, its finished trials loaded. */
  async resume(id: string, o: { concurrency?: number; command?: string[]; now?: number } = {}): Promise<Job> {
    const r = await this.readHeader(id);
    if (!r) throw new Error(`no job ${id}`);
    const now = o.now ?? Date.now();
    const h = r.header;
    const last = h.sessions.at(-1);
    if (last && last.endedAt === undefined) last.endedAt = Math.max(last.startedAt, h.updatedAt);
    h.sessions.push({ pid: process.pid, host: hostname(), startedAt: now });
    h.status = "running";
    h.updatedAt = now;
    if (o.concurrency) h.concurrency = o.concurrency;
    if (o.command) h.command = o.command;
    // A torn last line (killed mid-write) is ended, so the next line starts clean instead of joining it.
    const log = await readFile(this.logPath(id), "utf8").catch(() => "");
    if (log && !log.endsWith("\n")) await appendFile(this.logPath(id), "\n", "utf8");
    const job = new Job(this, h, parseLines(log));
    await job.save();
    return job;
  }
}

/** A namespaced view of a job: a nested stage (a sweep's held-out run) keeps its keys and state apart. */
export interface JobScope {
  readonly job: Job;
  readonly prefix: string;
  /** The finished (or infra-failed) trial recorded under this key, if any. */
  done(key: string): TrialLine | undefined;
  record(key: string, line: Omit<TrialLine, "key" | "at"> & { at?: number }): Promise<void>;
  state<T>(name: string): T | undefined;
  setState(name: string, value: unknown): Promise<void>;
  scope(prefix: string): JobScope;
}

export class Job {
  readonly store: JobStore;
  readonly header: JobHeader;
  readonly lines: Map<string, TrialLine>;
  private writes: Promise<void> = Promise.resolve();
  private beat?: NodeJS.Timeout;

  constructor(store: JobStore, header: JobHeader, lines: Map<string, TrialLine>) {
    this.store = store;
    this.header = header;
    this.lines = lines;
    if (header.status === "running") {
      // Heartbeat: a fresh mtime says the owner is alive (see liveStatus).
      this.beat = setInterval(() => {
        const t = new Date();
        utimes(this.store.headerPath(header.id), t, t).catch(() => {});
      }, HEARTBEAT_MS);
      this.beat.unref();
    }
  }

  get id(): string {
    return this.header.id;
  }
  /** True when this job was started before (it holds finished trials from an earlier session). */
  get resumed(): boolean {
    return this.header.sessions.length > 1;
  }

  /** Serialized atomic rewrite of the header. */
  save(): Promise<void> {
    const h = this.header;
    const next = this.writes.then(async () => {
      h.updatedAt = Date.now();
      await writeFileDurable(this.store.headerPath(h.id), JSON.stringify(h) + "\n");
    });
    this.writes = next.catch(() => {});
    return next;
  }

  async record(line: TrialLine): Promise<void> {
    this.lines.delete(line.key);
    this.lines.set(line.key, line);
    // One small O_APPEND write per line: concurrent trials interleave whole lines.
    await appendFile(this.store.logPath(this.id), JSON.stringify(line) + "\n", "utf8");
  }

  async setTotal(total: number): Promise<void> {
    if (this.header.total === total) return;
    this.header.total = total;
    await this.save();
  }

  async addRefs(...ids: string[]): Promise<void> {
    const fresh = ids.filter((x) => !this.header.refs.includes(x));
    if (!fresh.length) return;
    this.header.refs.push(...fresh);
    await this.save();
  }

  /** Trials recorded with an infra error as their last attempt. */
  infraCount(): number {
    let n = 0;
    for (const l of this.lines.values()) if (l.infra) n++;
    return n;
  }

  /** End this session with a final status; stops the heartbeat. */
  async finish(status: Exclude<JobStatus, "running">): Promise<void> {
    if (this.beat) clearInterval(this.beat);
    this.beat = undefined;
    this.header.status = status;
    const cur = this.header.sessions.at(-1);
    if (cur) cur.endedAt = Date.now();
    await this.save();
  }

  /**
   * Run `fn` as this job's session. If it throws, the job ends interrupted
   * (resumable), or is deleted when it is new and nothing ran yet, so a run
   * that fails on bad input leaves nothing behind to offer.
   */
  async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!this.resumed && this.lines.size === 0) {
        if (this.beat) clearInterval(this.beat);
        this.beat = undefined;
        await this.writes;
        await this.store.remove(this.id);
      } else await this.finish("interrupted").catch(() => {});
      throw e;
    }
  }

  scope(prefix = ""): JobScope {
    const job = this;
    const k = (key: string) => `${prefix}${key}`;
    return {
      job,
      prefix,
      done: (key) => job.lines.get(k(key)),
      record: (key, line) => job.record({ ...line, key: k(key), at: line.at ?? Date.now() }),
      state: <T>(name: string) => job.header.state[k(name)] as T | undefined,
      setState: async (name, value) => {
        job.header.state[k(name)] = value;
        await job.save();
      },
      scope: (sub) => job.scope(`${prefix}${sub}`),
    };
  }
}
