// zstd compression on a worker thread, for a bulk writer's small blobs.
//
// An ingest puts one blob per hook line, most of them under a KiB, and
// zstdCompressSync costs tens of microseconds each, nearly all of it setting up
// and tearing down the compressor, not compressing. On the ingest's own thread
// that was a tenth of a bulk drain. Here the bytes go to one worker in batches
// (one message each way per batch, the inputs and outputs packed into one
// transferred buffer), so the ingest goes on normalizing while the worker
// compresses. The worker runs the same zstdCompressSync at the same level as
// the caller would, so the frames are byte for byte the ones the caller would
// have written.
//
// A batch is sent once BATCH_ITEMS inputs are queued, on flush(), or at the next
// turn of the event loop, whichever comes first. If the worker cannot start or
// dies, its outstanding inputs, and every later one, are compressed on the
// caller's thread: the pool never fails a compress that zstdCompressSync would not.
// An idle worker does not keep the process alive.
import { Worker } from "node:worker_threads";
import { constants, zstdCompressSync } from "node:zlib";

/** Inputs queued before a batch goes to the worker without waiting for the next turn of the event loop. */
const BATCH_ITEMS = 128;

/** The worker: compresses each input of a batch and sends the frames back in one buffer. */
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { constants, zstdCompressSync } = require("node:zlib");
parentPort.on("message", (m) => {
  const opts = { params: { [constants.ZSTD_c_compressionLevel]: m.level } };
  const input = new Uint8Array(m.buf);
  const frames = [];
  let at = 0;
  let total = 0;
  for (const len of m.lens) {
    const f = zstdCompressSync(input.subarray(at, at + len), opts);
    at += len;
    total += f.byteLength;
    frames.push(f);
  }
  const out = new Uint8Array(total);
  const lens = new Array(frames.length);
  at = 0;
  for (let i = 0; i < frames.length; i++) {
    out.set(frames[i], at);
    at += frames[i].byteLength;
    lens[i] = frames[i].byteLength;
  }
  parentPort.postMessage({ id: m.id, buf: out.buffer, lens }, [out.buffer]);
});
`;

interface Job {
  bytes: Uint8Array;
  resolve: (frame: Uint8Array) => void;
}

/** zstdCompressSync at `level`, as every caller of the pool would have run it. */
export function zstdFrame(bytes: Uint8Array, level: number): Uint8Array {
  return zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: level } });
}

export class ZstdPool {
  private readonly level: number;
  private worker: Worker | undefined;
  /** The worker failed to start or died: compress on this thread from now on. */
  private dead = false;
  private queue: Job[] = [];
  private scheduled = false;
  private nextId = 0;
  /** Batches sent and not yet answered, by id. */
  private readonly sent = new Map<number, Job[]>();

  constructor(level: number) {
    this.level = level;
  }

  /** The zstd frame of `bytes`, compressed on the worker. Never rejects. */
  compress(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.dead) return Promise.resolve(zstdFrame(bytes, this.level));
    return new Promise((resolve) => {
      this.queue.push({ bytes, resolve });
      if (this.queue.length >= BATCH_ITEMS) this.flush();
      else if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => {
          this.scheduled = false;
          this.flush();
        });
      }
    });
  }

  /** Sends what is queued now, without waiting for the batch to fill. */
  flush(): void {
    if (!this.queue.length) return;
    const jobs = this.queue;
    this.queue = [];
    const worker = this.start();
    if (!worker) return this.local(jobs);
    let size = 0;
    for (const j of jobs) size += j.bytes.byteLength;
    const buf = new Uint8Array(size);
    const lens = new Array<number>(jobs.length);
    let at = 0;
    for (let i = 0; i < jobs.length; i++) {
      buf.set(jobs[i]!.bytes, at);
      at += jobs[i]!.bytes.byteLength;
      lens[i] = jobs[i]!.bytes.byteLength;
    }
    const id = this.nextId++;
    this.sent.set(id, jobs);
    if (this.sent.size === 1) worker.ref();
    try {
      worker.postMessage({ id, level: this.level, buf: buf.buffer, lens }, [buf.buffer]);
    } catch {
      this.fail();
    }
  }

  /** Stops the worker; anything still outstanding is compressed here first. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.fail();
    this.dead = false;
    if (worker) await worker.terminate();
  }

  private start(): Worker | undefined {
    if (this.worker || this.dead) return this.worker;
    try {
      const worker = new Worker(WORKER_SOURCE, { eval: true, stdout: false, stderr: false });
      worker.on("message", (m: { id: number; buf: ArrayBuffer; lens: number[] }) => {
        const jobs = this.sent.get(m.id);
        if (!jobs) return;
        this.sent.delete(m.id);
        if (!this.sent.size) worker.unref();
        const out = new Uint8Array(m.buf);
        let at = 0;
        for (let i = 0; i < jobs.length; i++) {
          const len = m.lens[i]!;
          jobs[i]!.resolve(out.subarray(at, at + len));
          at += len;
        }
      });
      worker.on("error", () => this.fail());
      worker.on("exit", () => {
        if (this.worker === worker) this.fail();
      });
      worker.unref();
      this.worker = worker;
      return worker;
    } catch {
      this.dead = true;
      return undefined;
    }
  }

  /** The worker is gone: what it had, and what is queued, is compressed here. */
  private fail(): void {
    this.dead = true;
    const worker = this.worker;
    this.worker = undefined;
    worker?.removeAllListeners("message");
    const jobs = [...this.sent.values()].flat();
    this.sent.clear();
    jobs.push(...this.queue);
    this.queue = [];
    this.local(jobs);
    if (worker) void worker.terminate().catch(() => {});
  }

  private local(jobs: Job[]): void {
    for (const j of jobs) j.resolve(zstdFrame(j.bytes, this.level));
  }
}
