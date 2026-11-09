// Per-run OpenTelemetry (opt-in, `compare --otel`): the agent process gets an
// OTLP endpoint, a W3C TRACEPARENT derived from the run id, and the resource
// attribute coding_sh.run_id=<id>, which otel/map.ts reads into each event's
// runId. Spans an OTel-instrumented agent exports then land in the index
// tagged with the run, and join the run's session when they carry its
// session.id. Claude Code also needs its telemetry switches (CLAUDE_TELEMETRY_ENV).
// Only the agent sees this env: setup and the verifier do not. Off by default.
import { createHash } from "node:crypto";
import type { BlobStore, IndexStore } from "../core/types.ts";

/** What a run's agent exports to: an endpoint, and a wait for exports still in flight once it exits. */
export interface RunOtel {
  /** Base URL, e.g. http://127.0.0.1:43123 (the SDK appends /v1/traces). */
  endpoint: string;
  /** Resolves once no export has arrived for a short while (at most a couple of seconds). */
  settle?: () => Promise<void>;
}

/** `true` starts a receiver for the run (or the experiment) on an ephemeral port; an endpoint sends there. */
export type OtelOpt = boolean | { endpoint: string };

/** Claude Code exports nothing unless these are set (code.claude.com/docs/en/monitoring-usage). */
export const CLAUDE_TELEMETRY_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORT_INTERVAL: "1000",
  OTEL_METRIC_EXPORT_INTERVAL: "1000",
};

/** Agents whose telemetry needs CLAUDE_TELEMETRY_ENV. */
const CLAUDE_AGENTS = new Set(["claude-code"]);

export const RUN_ATTRIBUTE = "coding_sh.run_id";

/** A deterministic trace id (32 hex) and root span id (16 hex) for a run id, never all zeros. */
export function runTraceContext(runId: string): { traceId: string; spanId: string } {
  const h = createHash("sha256").update(`coding.sh run ${runId}`).digest("hex");
  const nz = (s: string) => (/^0+$/.test(s) ? `${s.slice(0, -1)}1` : s);
  return { traceId: nz(h.slice(0, 32)), spanId: nz(h.slice(32, 48)) };
}

/**
 * OTEL_RESOURCE_ATTRIBUTES with coding_sh.run_id set to the run: attributes
 * already there (service.name, team tags) stay, an older run id is replaced.
 */
export function withRunAttribute(existing: string | undefined, runId: string): string {
  const kept = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s.split("=")[0]?.trim() !== RUN_ATTRIBUTE);
  return [...kept, `${RUN_ATTRIBUTE}=${encodeURIComponent(runId)}`].join(",");
}

/**
 * The env an agent run gets for OTel: endpoint, protocol, TRACEPARENT, the run
 * attribute and, for Claude Code, its telemetry switches. `base` is the env
 * the agent would get otherwise (its OTEL_RESOURCE_ATTRIBUTES is kept).
 */
export function otelEnv(runId: string, adapterId: string, endpoint: string, base: Record<string, string | undefined>): Record<string, string> {
  const { traceId, spanId } = runTraceContext(runId);
  return {
    ...(CLAUDE_AGENTS.has(adapterId) ? CLAUDE_TELEMETRY_ENV : {}),
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_RESOURCE_ATTRIBUTES: withRunAttribute(base.OTEL_RESOURCE_ATTRIBUTES, runId),
    TRACEPARENT: `00-${traceId}-${spanId}-01`,
  };
}

/** How long exports must be quiet before a run counts them all in, and the most a run waits. */
const QUIET_MS = 300;
const MAX_WAIT_MS = 2000;

/**
 * An OTLP receiver on 127.0.0.1 and an ephemeral port that writes into `index`.
 * `settle` waits until no export has arrived for QUIET_MS (at most MAX_WAIT_MS).
 */
export async function startRunReceiver(index: IndexStore, blobs: BlobStore): Promise<RunOtel & { close: () => Promise<void> }> {
  const { startReceiver } = await import("../otel/receiver.ts");
  let last = Date.now();
  const rx = await startReceiver({ port: 0, store: index, blobs, onBatch: () => void (last = Date.now()) });
  const settle = async () => {
    const until = Date.now() + MAX_WAIT_MS;
    last = Math.max(last, Date.now() - QUIET_MS / 2);
    while (Date.now() < until && Date.now() - last < QUIET_MS) await new Promise((r) => setTimeout(r, 50));
  };
  return { endpoint: rx.url, settle, close: () => rx.close() };
}
