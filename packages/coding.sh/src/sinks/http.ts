// Generic HTTP sink: POSTs {schema, v, events, sessions} JSON to an endpoint.
// For collectors that speak coding.sh/trace natively (or a small relay).
import type { AgentEvent, Session } from "../schema/index.ts";
import { SCHEMA_ID, SCHEMA_VERSION } from "../schema/index.ts";
import type { BlobStore, Sink, SinkAck, SinkConfig } from "../core/types.ts";
import { sessionToMetadata, toMetadata } from "../core/redact.ts";
import { postJson } from "./post.ts";

export interface HttpSinkOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpSink implements Sink {
  readonly name: string;
  readonly mode: "full" | "metadata";
  private readonly config: SinkConfig;
  private readonly opts: HttpSinkOptions;

  constructor(config: SinkConfig, opts: HttpSinkOptions = {}) {
    if (!config.endpoint) throw new Error(`http sink ${config.name ?? ""} needs an endpoint`);
    this.config = config;
    this.name = config.name ?? config.kind;
    this.mode = config.mode;
    this.opts = opts;
  }

  async write(batch: AgentEvent[], sessions: Session[], _blobs: BlobStore): Promise<SinkAck> {
    // Defence in depth: ingest already strips metadata-mode batches.
    const meta = this.mode === "metadata";
    const body = {
      schema: SCHEMA_ID,
      v: SCHEMA_VERSION,
      mode: this.mode,
      events: meta ? batch.map(toMetadata) : batch,
      sessions: meta ? sessions.map(sessionToMetadata) : sessions,
    };
    return postJson(this.config.endpoint, body, { headers: this.config.headers, timeoutMs: this.opts.timeoutMs, fetch: this.opts.fetch });
  }
}

export function createHttpSink(config: SinkConfig): Sink {
  return new HttpSink(config);
}
