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
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

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
