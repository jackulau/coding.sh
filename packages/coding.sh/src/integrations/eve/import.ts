// Read-only importer for eve's local traces.
//
// `eve dev` writes every span of every turn to the app's local trace store:
//   <app>/.eve/traces/v1/<traceId>/segments/<spanId>.otlp.json
// one OTLP/JSON ExportTraceServiceRequest per span (only "eve.agent" spans;
// Workflow infrastructure spans are filtered out by eve). `eve traces show
// --json` prints the same spans in its own shape. Both go through the same
// OTLP mapper as live export plus enrichFromEve, so an imported session and
// a live-collected one have identical event ids (re-import is a no-op).
//
// Nothing here writes, spawns, or talks to the network. Vercel Agent Runs
// (`vercel agent-runs trace <runId> --json`) is not read: its JSON is a
// Vercel API response we have not verified, and fetching it needs the
// user's Vercel credentials. Spans shaped like OTLP or `eve traces --json`
// inside any JSON file are accepted.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, BlobRef } from "../../schema/index.ts";
import { sha256Hex } from "../../core/ids.ts";
import { decodeTraceJson } from "../../otel/json.ts";
import { type MapContext, mapTraces, TraceSessionMap } from "../../otel/map.ts";
import type { Attrs, OtelSpan, OtelValue, ResourceSpans } from "../../otel/model.ts";
import { enrichGatewaySpan } from "../gateway/otel.ts";
import { enrichFromEve, type EveEnrichOptions } from "./map.ts";

export interface ImportEveOptions extends EveEnrichOptions {
  /** Payload values larger than this move to blobs (default 16 KiB). */
  maxInlineBytes?: number;
  /** Store large content; returns its ref. Default: content is not kept (ref = sha256, preview stays inline). */
  blob?(data: string | Uint8Array): Promise<BlobRef>;
  /** Keep each normalized source span as blobs[0] (default: only when `blob` is given). */
  keepRaw?: boolean;
  /** Skip traces that started before this time (ms since epoch). */
  since?: number;
  /** Called for each unreadable segment or file (default: ignored). */
  onError?(path: string, error: Error): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The `.eve/traces/v1` directory for an app root, a `.eve` dir, a traces dir, or the v1 dir itself. */
export async function resolveEveTraceStore(dir: string): Promise<string | undefined> {
  for (const c of [join(dir, ".eve", "traces", "v1"), join(dir, "traces", "v1"), join(dir, "v1")]) if (await isDir(c)) return c;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory() && (await isDir(join(dir, e.name, "segments")))) return dir;
  return undefined;
}

// ---------------------------------------------------------------- `eve traces --json` shape

interface EveCliSpan {
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind?: number;
  scope?: string;
  startTimeNs: string;
  endTimeNs?: string;
  statusCode?: number;
  statusMessage?: string | null;
  attributes?: Record<string, unknown>;
  events?: { name: string; timeNs?: string; attributes?: Record<string, unknown> }[];
}

function isCliTrace(v: unknown): v is { traceId: string; spans: EveCliSpan[] } {
  return isObj(v) && typeof v.traceId === "string" && Array.isArray(v.spans) && v.spans.every((s) => isObj(s) && typeof s.spanId === "string" && "startTimeNs" in s);
}

const nsString = (v: unknown): string => (typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : "0");

function cliTraceToOtlp(t: { traceId: string; spans: EveCliSpan[] }): ResourceSpans[] {
  const byScope = new Map<string, OtelSpan[]>();
  for (const s of t.spans) {
    const span: OtelSpan = {
      traceId: t.traceId.toLowerCase(),
      spanId: s.spanId.toLowerCase(),
      name: s.name,
      kind: s.kind ?? 1,
      startTimeUnixNano: nsString(s.startTimeNs),
      endTimeUnixNano: nsString(s.endTimeNs ?? s.startTimeNs),
      attributes: (s.attributes ?? {}) as Attrs,
      events: (s.events ?? []).map((e) => ({ name: e.name, timeUnixNano: nsString(e.timeNs), attributes: (e.attributes ?? {}) as Attrs })),
      links: [],
      status: { code: s.statusCode ?? 0, ...(s.statusMessage ? { message: s.statusMessage } : {}) },
    };
    if (s.parentSpanId) span.parentSpanId = s.parentSpanId.toLowerCase();
    const scope = s.scope ?? "eve.agent";
    byScope.set(scope, [...(byScope.get(scope) ?? []), span]);
  }
  return [{ resource: { attributes: {} as Record<string, OtelValue> }, scopeSpans: [...byScope].map(([name, spans]) => ({ scope: { name, attributes: {} }, spans })) }];
}

/** Any supported JSON document → ResourceSpans batches. */
export function eveJsonToResourceSpans(doc: unknown): ResourceSpans[] {
  if (Array.isArray(doc)) return doc.flatMap(eveJsonToResourceSpans);
  if (isObj(doc) && (Array.isArray(doc.resourceSpans) || Array.isArray(doc.resource_spans))) return decodeTraceJson(doc);
  if (isCliTrace(doc)) return cliTraceToOtlp(doc);
  return [];
}

function parseDocs(text: string): unknown[] {
  const t = text.trim();
  if (!t) return [];
  try {
    return [JSON.parse(t)];
  } catch {
    // JSONL: one document per line.
    return t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown);
  }
}

// ---------------------------------------------------------------- import

function traceStartMs(batches: ResourceSpans[]): number {
  let min = Infinity;
  for (const rs of batches)
    for (const ss of rs.scopeSpans)
      for (const s of ss.spans) {
        try {
          const ms = Number(BigInt(s.startTimeUnixNano) / 1_000_000n);
          if (ms > 0 && ms < min) min = ms;
        } catch {
          /* unset time */
        }
      }
  return min === Infinity ? 0 : min;
}

/** Groups batches by traceId (spans of one trace may be spread across files). */
function groupByTrace(batches: ResourceSpans[]): Map<string, ResourceSpans[]> {
  const out = new Map<string, ResourceSpans[]>();
  for (const rs of batches)
    for (const ss of rs.scopeSpans) {
      const byTrace = new Map<string, OtelSpan[]>();
      for (const s of ss.spans) {
        const t = s.traceId ?? "";
        byTrace.set(t, [...(byTrace.get(t) ?? []), s]);
      }
      for (const [t, spans] of byTrace) out.set(t, [...(out.get(t) ?? []), { resource: rs.resource, scopeSpans: [{ scope: ss.scope, spans }] }]);
    }
  return out;
}

async function readStore(store: string, opts: ImportEveOptions): Promise<Map<string, ResourceSpans[]>> {
  const out = new Map<string, ResourceSpans[]>();
  const traces = (await readdir(store, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const trace of traces) {
    const segDir = join(store, trace, "segments");
    const files = (await readdir(segDir).catch(() => [] as string[])).filter((f) => f.endsWith(".otlp.json")).sort();
    const batches: ResourceSpans[] = [];
    for (const f of files) {
      const p = join(segDir, f);
      try {
        batches.push(...eveJsonToResourceSpans(JSON.parse(await readFile(p, "utf8"))));
      } catch (err) {
        opts.onError?.(p, err as Error);
      }
    }
    if (batches.length) out.set(trace, batches);
  }
  return out;
}

/**
 * Import eve runs as coding.sh events. `source` is an eve app root (or its
 * `.eve`, `.eve/traces`, `.eve/traces/v1` dir), or a JSON/JSONL file holding
 * OTLP/JSON export requests or `eve traces show --json` output.
 * Yields each trace's events, oldest trace first.
 */
export async function* importEveRuns(source: string, opts: ImportEveOptions = {}): AsyncIterable<AgentEvent> {
  let traces: Map<string, ResourceSpans[]>;
  if (await isDir(source)) {
    const store = await resolveEveTraceStore(source);
    if (!store) throw new Error(`no eve trace store under ${source} (expected .eve/traces/v1; run the agent with \`eve dev\` first)`);
    traces = await readStore(store, opts);
  } else {
    const docs = parseDocs(await readFile(source, "utf8"));
    traces = groupByTrace(docs.flatMap(eveJsonToResourceSpans));
  }

  const ctx: MapContext = {
    maxInlineBytes: opts.maxInlineBytes ?? 16 * 1024,
    blob: opts.blob ?? (async (data) => sha256Hex(data)),
    keepRaw: opts.keepRaw ?? opts.blob !== undefined,
    traceSessions: new TraceSessionMap(),
    // eve apps call models through AI Gateway: tag those calls and keep their generation ids.
    enrichSpan: (span, events, info) => enrichGatewaySpan(span, enrichFromEve(span, events, info, opts), info),
  };
  const ordered = [...traces].map(([id, batches]) => ({ id, batches, start: traceStartMs(batches) })).sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
  for (const t of ordered) {
    if (opts.since !== undefined && t.start < opts.since) continue;
    const res = await mapTraces(t.batches, ctx);
    for (const err of res.errors) opts.onError?.(`trace ${t.id}`, new Error(err));
    yield* res.events.sort((x, y) => x.ts - y.ts);
  }
}
