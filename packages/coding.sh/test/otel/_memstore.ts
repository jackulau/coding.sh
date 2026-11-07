// Tiny in-memory IndexStore/BlobStore for the OTLP receiver tests. Only the
// methods the receiver uses do real work; the rest satisfy the interface.
import { createHash } from "node:crypto";
import type { AgentEvent, BlobRef, Session } from "../../src/schema/index.ts";
import type { BlobStore, EvalTask, HarnessBundle, IndexStore, Label, RunResult, SearchHit } from "../../src/core/types.ts";

const clone = <T>(v: T): T => structuredClone(v);

export class MemIndex implements IndexStore {
  readonly kind = "test-memory";
  readonly events = new Map<string, { seq: number; event: AgentEvent }>();
  readonly sessions = new Map<string, Session>();
  /** Fail the next N putEvents calls (to test 503s). */
  failPuts = 0;
  private seq = 0;
  private readonly cursors = new Map<string, number>();

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async putEvents(batch: AgentEvent[]): Promise<{ inserted: number }> {
    if (this.failPuts > 0) {
      this.failPuts--;
      throw new Error("disk full");
    }
    let inserted = 0;
    for (const e of batch) {
      if (this.events.has(e.id)) continue;
      this.events.set(e.id, { seq: this.seq++, event: clone(e) });
      inserted++;
    }
    return { inserted };
  }

  async upsertSession(session: Session): Promise<void> {
    this.sessions.set(session.id, clone(session));
  }

  async getSession(id: string): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    return s && clone(s);
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map(clone);
  }

  async listEvents(sessionId: string, opts: { kinds?: string[] } = {}): Promise<AgentEvent[]> {
    return [...this.events.values()]
      .filter(({ event: e }) => e.sessionId === sessionId && (!opts.kinds?.length || opts.kinds.includes(e.kind)))
      .sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq)
      .map((r) => clone(r.event));
  }

  async search(): Promise<SearchHit[]> {
    return [];
  }
  async getCursor(source: string): Promise<number> {
    return this.cursors.get(source) ?? 0;
  }
  async setCursor(source: string, offset: number): Promise<void> {
    this.cursors.set(source, offset);
  }
  async putTask(_task: EvalTask): Promise<void> {}
  async getTask(): Promise<EvalTask | undefined> {
    return undefined;
  }
  async listTasks(): Promise<EvalTask[]> {
    return [];
  }
  async putBundle(_bundle: HarnessBundle): Promise<void> {}
  async getBundle(): Promise<HarnessBundle | undefined> {
    return undefined;
  }
  async listBundles(): Promise<HarnessBundle[]> {
    return [];
  }
  async putRun(_run: RunResult): Promise<void> {}
  async listRuns(): Promise<RunResult[]> {
    return [];
  }
  async putLabel(_label: Label): Promise<void> {}
  async listLabels(): Promise<Label[]> {
    return [];
  }
  async *referencedBlobs(): AsyncIterable<BlobRef> {}

  all(): AgentEvent[] {
    return [...this.events.values()].sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq).map((r) => clone(r.event));
  }
}

export class MemBlobs implements BlobStore {
  readonly kind = "test-memory";
  readonly data = new Map<string, Uint8Array>();

  async put(data: Uint8Array | string): Promise<BlobRef> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const ref = createHash("sha256").update(bytes).digest("hex");
    if (!this.data.has(ref)) this.data.set(ref, new Uint8Array(bytes));
    return ref;
  }
  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    return this.data.get(ref);
  }
  async getText(ref: BlobRef): Promise<string | undefined> {
    const b = this.data.get(ref);
    return b && new TextDecoder().decode(b);
  }
  async has(refs: BlobRef[]): Promise<boolean[]> {
    return refs.map((r) => this.data.has(r));
  }
  async *list(): AsyncIterable<BlobRef> {
    yield* this.data.keys();
  }
  async delete(ref: BlobRef): Promise<void> {
    this.data.delete(ref);
  }
}
