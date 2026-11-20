// Background ingest for `coding.sh ui`: a worker thread with its own store
// connection. node:sqlite is synchronous, so an ingest on the thread that
// serves HTTP stalls every request until it finishes (21 s on a big spool);
// here the viewer's thread only reads, and WAL lets those reads run while
// the worker writes. The viewer listens at once and shows what is already
// indexed, with the worker's progress behind /api/ingest.
//
// This file is both sides: imported, it exports startBackgroundIngest; run as
// a worker (its own URL, from source or from a bundle chunk), it ingests every
// `intervalMs` until told to stop. Stopping aborts the pass at its next
// checkpoint, so the ingest lock is released and cursors cover what was stored.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { reapSqliteCopies } from "../adapters/_shared/sqlite-copies.ts";

/** What /api/ingest reports. */
export interface IngestStatus {
  /** A pass is reading spool files that hold unread lines. */
  ingesting: boolean;
  /** Spool files still holding unread lines (0 when idle). */
  filesPending: number;
  /** When the last pass finished (ms epoch), null before the first. */
  lastIngestAt: number | null;
  /** Past sessions are being imported (init, or the background import it started). Set by `coding.sh ui`. */
  importing?: boolean;
  /** `coding.sh init` has set up capture (the empty list then says to start a new agent session). Set by `coding.sh ui`. */
  captureSetUp?: boolean;
}

export interface BackgroundIngest {
  status(): IngestStatus;
  /** Stops after the current checkpoint and closes the worker's store. */
  close(): Promise<void>;
}

export interface BackgroundIngestOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Pause between passes (default 3 s). */
  intervalMs?: number;
  /** A pass failed (the worker keeps going) or the worker died. */
  onError?: (message: string) => void;
}

const KIND = "coding.sh/ingest-worker";
/** How long close() waits for the pass to reach a checkpoint before terminating the worker. */
const CLOSE_GRACE_MS = 10_000;

const TAIL_KIND = "coding.sh/tail-worker";
/** Set in a child process that runs this file as a script to do one tail import (see tailWithin). */
const TAIL_ENV = "CODING_SH_TAIL_CHILD";

interface Data {
  kind: typeof KIND;
  cwd: string;
  intervalMs: number;
}

type Message = { type: "status"; status: IngestStatus } | { type: "error"; message: string };

export function startBackgroundIngest(opts: BackgroundIngestOptions): BackgroundIngest {
  let status: IngestStatus = { ingesting: false, filesPending: 0, lastIngestAt: null };
  const data: Data = { kind: KIND, cwd: opts.cwd, intervalMs: opts.intervalMs ?? 3000 };
  // The worker's process.env is `env`, so adapters that read process.env see the same as this command.
  const worker = new Worker(new URL(import.meta.url), { workerData: data, env: { ...opts.env } });
  worker.on("message", (m: Message) => {
    if (m.type === "status") status = m.status;
    else opts.onError?.(m.message);
  });
  worker.on("error", (e) => opts.onError?.(e.message));
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  let closing: Promise<void> | undefined;
  return {
    status: () => status,
    close() {
      closing ??= (async () => {
        worker.postMessage("stop");
        const timer = setTimeout(() => void worker.terminate(), CLOSE_GRACE_MS);
        await exited;
        clearTimeout(timer);
      })();
      return closing;
    },
  };
}

/**
 * One budgeted read's import from the adapters that read a capture path (T3 Code's database, transcripts of agents
 * whose hooks are not installed). Reading them can take many seconds (walking a projects dir, closing a big database)
 * in calls that do not return until done, so the read does not run them on its own thread: a child process with its
 * own store connection does, and the read stops waiting at `deadline` and kills it. A child, not a worker thread: a
 * thread stuck in a native call (a sync file or SQLite call) cannot be terminated, and the process then cannot exit
 * until the call returns (12 to 42 s on a loaded Windows machine); killing a process is immediate. What it stored is
 * kept, and its cursors are set only after the events they cover, so the background ingest the read starts resumes.
 * The child stops by itself a little before the deadline (tailMarginMs), with the cursors of each file it read
 * through committed as it went, so the kill is only for a read that does not return (a scan, a big database).
 * Resolves with the files left unread: `late` when the child was still reading at the deadline (at least one), 0
 * when it failed, or had not started reading yet (a budget of 0 ms answers without any wait). `busy`: another
 * process was reading the same sources (paths.tailLock), so this one read nothing.
 */
export function tailWithin(opts: { env: NodeJS.ProcessEnv; cwd: string; deadline: number; /** Tests: block the child this long before it reads, as a slow adapter does. */ stallMs?: number }): Promise<{ pending: number; late: boolean; busy?: true }> {
  return new Promise((resolve) => {
    const data: TailData = { kind: TAIL_KIND, cwd: opts.cwd, deadline: opts.deadline, stallMs: opts.stallMs };
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...opts.env, NODE_OPTIONS: undefined, [TAIL_ENV]: JSON.stringify(data) } });
    } catch {
      resolve({ pending: 0, late: false });
      return;
    }
    let done = false;
    let reading = false;
    let out = "";
    const finish = (r: { pending: number; late: boolean; busy?: true }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish(reading ? { pending: 1, late: true } : { pending: 0, late: false });
      child.kill();
      // Killed mid-copy of a big SQLite store (T3 Code's is 1.7 GB), the child can't remove the copy: this process
      // does, when the child is gone or at the latest as this process exits (a read answers and exits at once).
      const pid = child.pid;
      if (pid !== undefined) {
        const reap = () => {
          process.off("exit", reap);
          reapSqliteCopies({ killed: pid });
        };
        child.once("exit", reap);
        process.once("exit", reap);
      }
    }, Math.max(0, opts.deadline - Date.now()));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      for (let i = out.indexOf("\n"); i >= 0; i = out.indexOf("\n")) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (line === "reading") reading = true;
        else if (line === "tail busy") finish({ pending: 0, late: false, busy: true });
        else if (line.startsWith("tail ")) finish({ pending: Number(line.slice(5)) || 0, late: false });
      }
    });
    child.on("error", () => finish({ pending: 0, late: false }));
    child.on("exit", () => finish({ pending: 0, late: false }));
  });
}

interface TailData {
  kind: typeof TAIL_KIND;
  cwd: string;
  deadline: number;
  stallMs: number | undefined;
}

/**
 * How long before the parent's deadline its tail child stops reading: a quarter of the time left, between 100 and
 * 500 ms, for the last file's commit and the store's close.
 */
export const tailMarginMs = (left: number): number => Math.min(500, Math.max(100, Math.floor(left / 4)));

async function runTail(d: TailData): Promise<void> {
  delete process.env[TAIL_ENV]; // not inherited by anything this import starts
  const [{ openContext }, { tailIngest }] = await Promise.all([import("../core/context.ts"), import("./common.ts")]);
  const ctx = await openContext({ env: process.env, cwd: d.cwd });
  let r = { pending: 0, busy: false };
  try {
    process.stdout.write("reading\n");
    // A native call that does not return until done, as a big database read is: not interruptible in-process.
    if (d.stallMs) spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${Math.floor(d.stallMs)})`], { stdio: "ignore" });
    // Another process reading the same sources (a background ingest, another read's child): not again here.
    r = await tailIngest(ctx, { deadline: d.deadline - tailMarginMs(d.deadline - Date.now()), waitMs: 0 });
  } finally {
    await ctx.close();
  }
  process.stdout.write(r.busy ? "tail busy\n" : `tail ${r.pending}\n`);
}

async function runWorker(d: Data): Promise<void> {
  const port = parentPort!;
  const post = (m: Message) => port.postMessage(m);
  const stop = new AbortController();
  let wake: (() => void) | undefined;
  port.on("message", (m) => {
    if (m !== "stop") return;
    stop.abort();
    wake?.();
  });
  const [{ openContext }, { autoIngest }] = await Promise.all([import("../core/context.ts"), import("./common.ts")]);
  const ctx = await openContext({ env: process.env, cwd: d.cwd });
  let status: IngestStatus = { ingesting: false, filesPending: 0, lastIngestAt: null };
  const set = (s: Partial<IngestStatus>) => {
    const next = { ...status, ...s };
    if (next.ingesting === status.ingesting && next.filesPending === status.filesPending && next.lastIngestAt === status.lastIngestAt) return;
    status = next;
    post({ type: "status", status });
  };
  try {
    while (!stop.signal.aborted) {
      try {
        await autoIngest(ctx, {
          signal: stop.signal,
          onProgress: ({ filesPending }) => set({ ingesting: filesPending > 0, filesPending }),
        });
      } catch (e) {
        post({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      set({ ingesting: false, filesPending: 0, lastIngestAt: Date.now() });
      // Monitors score new sessions, each at most once a minute (src/monitor); their errors go to monitors.json.
      if (!stop.signal.aborted && existsSync(ctx.paths.monitors)) {
        const { monitorsAfterIngest } = await import("../monitor/run.ts");
        await monitorsAfterIngest(ctx, { signal: stop.signal });
      }
      if (stop.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, d.intervalMs);
        wake = () => (clearTimeout(t), resolve());
      });
    }
  } finally {
    await ctx.close();
    port.close();
  }
}

if (!isMainThread && (workerData as Data | undefined)?.kind === KIND) void runWorker(workerData as Data);
else if (isMainThread && process.env[TAIL_ENV]) void runTail(JSON.parse(process.env[TAIL_ENV]) as TailData).catch(() => process.exit(0));
