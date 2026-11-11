// coding.sh proxy: a local pass-through for the Anthropic and OpenAI APIs that
// logs every call as an llm.call event. See docs/how-to/capture-with-proxy.md.
import { pricesFor } from "../core/pricing.ts";
import { createRedactor } from "../core/redact.ts";
import type { BlobStore, Config, IndexStore } from "../core/types.ts";
import type { AgentEvent } from "../schema/index.ts";
import { createRecorder, type Recorder, storeWriter } from "./record.ts";
import { type ProxyServer, type ProxyServerOptions, startProxy } from "./server.ts";

export { classify, parseRequest } from "./wire.ts";
export { createRecorder, storeWriter } from "./record.ts";
export { createProxyHandler, DEFAULT_PROXY_PORT, DEFAULT_UPSTREAMS, startProxy } from "./server.ts";

export interface LocalProxyOptions extends Omit<ProxyServerOptions, "recorder"> {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  env?: NodeJS.ProcessEnv;
  onEvent?: (e: AgentEvent) => void;
}

/** A recorder over this store with the config's redaction, capture mode and prices. */
export function recorderFor(o: {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  env?: NodeJS.ProcessEnv;
  /** Replaces the store write (default: putEvents, then rebuild the sessions). */
  write?: (events: AgentEvent[]) => Promise<void>;
  /** Project stamped on every event (serve). */
  project?: string;
  onError?: (e: Error) => void;
  onEvent?: (e: AgentEvent) => void;
}): Recorder {
  const cap = o.config.capture;
  return createRecorder({
    blobs: o.blobs,
    redactor: createRedactor({ redact: cap.redact, patterns: cap.redactPatterns, env: o.env ?? process.env }),
    metadata: cap.mode === "metadata",
    prices: pricesFor(o.config.pricing),
    write: o.write ?? storeWriter(o.index),
    env: o.env ?? process.env,
    ...(o.project ? { project: o.project } : {}),
    ...(o.onError ? { onError: o.onError } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
  });
}

/** Starts the proxy recording into a local store. */
export async function startLocalProxy(o: LocalProxyOptions): Promise<ProxyServer & { recorder: Recorder }> {
  const recorder = recorderFor(o);
  const server = await startProxy({ ...o, recorder });
  return Object.assign(server, { recorder });
}
