// OTLP/JSON fixture → protobuf bytes, written straight from the .proto field
// numbers (not from the decoder) so the JSON and protobuf paths can be checked
// against each other. Accepts only the canonical lowerCamel JSON form.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { ProtoWriter } from "../../src/otel/proto.ts";

type J = Record<string, any>;

const hex = (s: string | undefined): Uint8Array => (s ? Uint8Array.from(Buffer.from(s, "hex")) : new Uint8Array());

function anyValue(w: ProtoWriter, v: J): void {
  if ("stringValue" in v) w.string(1, v.stringValue);
  else if ("boolValue" in v) w.uint(2, v.boolValue ? 1 : 0);
  else if ("intValue" in v) w.uint(3, BigInt(v.intValue));
  else if ("doubleValue" in v) w.double(4, Number(v.doubleValue));
  else if ("arrayValue" in v) w.message(5, (a) => (v.arrayValue.values ?? []).forEach((x: J) => a.message(1, (b) => anyValue(b, x))));
  else if ("kvlistValue" in v) w.message(6, (a) => (v.kvlistValue.values ?? []).forEach((kv: J) => a.message(1, (b) => keyValue(b, kv))));
  else if ("bytesValue" in v) w.bytes(7, Uint8Array.from(Buffer.from(v.bytesValue, "base64")));
}

function keyValue(w: ProtoWriter, kv: J): void {
  w.string(1, kv.key);
  if (kv.value) w.message(2, (b) => anyValue(b, kv.value));
}

function attrs(w: ProtoWriter, field: number, list: J[] | undefined): void {
  for (const kv of list ?? []) w.message(field, (b) => keyValue(b, kv));
}

function resource(w: ProtoWriter, r: J | undefined): void {
  if (r) w.message(1, (b) => attrs(b, 1, r.attributes));
}

function scope(w: ProtoWriter, s: J | undefined): void {
  if (!s) return;
  w.message(1, (b) => {
    if (s.name) b.string(1, s.name);
    if (s.version) b.string(2, s.version);
    attrs(b, 3, s.attributes);
  });
}

function span(w: ProtoWriter, s: J): void {
  if (s.traceId) w.bytes(1, hex(s.traceId));
  if (s.spanId) w.bytes(2, hex(s.spanId));
  if (s.traceState) w.string(3, s.traceState);
  if (s.parentSpanId) w.bytes(4, hex(s.parentSpanId));
  if (s.name) w.string(5, s.name);
  if (s.kind) w.uint(6, s.kind);
  if (s.startTimeUnixNano) w.fixed64(7, s.startTimeUnixNano);
  if (s.endTimeUnixNano) w.fixed64(8, s.endTimeUnixNano);
  attrs(w, 9, s.attributes);
  for (const e of s.events ?? []) {
    w.message(11, (b) => {
      if (e.timeUnixNano) b.fixed64(1, e.timeUnixNano);
      if (e.name) b.string(2, e.name);
      attrs(b, 3, e.attributes);
    });
  }
  for (const l of s.links ?? []) {
    w.message(13, (b) => {
      if (l.traceId) b.bytes(1, hex(l.traceId));
      if (l.spanId) b.bytes(2, hex(l.spanId));
      attrs(b, 4, l.attributes);
    });
  }
  if (s.status) {
    w.message(15, (b) => {
      if (s.status.message) b.string(2, s.status.message);
      if (s.status.code) b.uint(3, s.status.code);
    });
  }
  if (s.flags !== undefined) w.fixed32(16, s.flags);
}

function logRecord(w: ProtoWriter, l: J): void {
  if (l.timeUnixNano) w.fixed64(1, l.timeUnixNano);
  if (l.severityNumber) w.uint(2, l.severityNumber);
  if (l.severityText) w.string(3, l.severityText);
  if (l.body) w.message(5, (b) => anyValue(b, l.body));
  attrs(w, 6, l.attributes);
  if (l.flags !== undefined) w.fixed32(8, l.flags);
  if (l.traceId) w.bytes(9, hex(l.traceId));
  if (l.spanId) w.bytes(10, hex(l.spanId));
  if (l.observedTimeUnixNano) w.fixed64(11, l.observedTimeUnixNano);
  if (l.eventName) w.string(12, l.eventName);
}

export function encodeTraces(req: J): Uint8Array {
  const w = new ProtoWriter();
  for (const rs of req.resourceSpans ?? []) {
    w.message(1, (a) => {
      resource(a, rs.resource);
      for (const ss of rs.scopeSpans ?? []) {
        a.message(2, (b) => {
          scope(b, ss.scope);
          for (const s of ss.spans ?? []) b.message(2, (c) => span(c, s));
          if (ss.schemaUrl) b.string(3, ss.schemaUrl);
        });
      }
      if (rs.schemaUrl) a.string(3, rs.schemaUrl);
    });
  }
  return w.finish();
}

export function encodeLogs(req: J): Uint8Array {
  const w = new ProtoWriter();
  for (const rl of req.resourceLogs ?? []) {
    w.message(1, (a) => {
      resource(a, rl.resource);
      for (const sl of rl.scopeLogs ?? []) {
        a.message(2, (b) => {
          scope(b, sl.scope);
          for (const l of sl.logRecords ?? []) b.message(2, (c) => logRecord(c, l));
          if (sl.schemaUrl) b.string(3, sl.schemaUrl);
        });
      }
      if (rl.schemaUrl) a.string(3, rl.schemaUrl);
    });
  }
  return w.finish();
}

const FIXTURES = new URL("../fixtures/otel/", import.meta.url);

/** Fresh copy of a fixture each call, so tests can mutate it. */
export function fixture(name: string): J {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

export const gzip = (b: Uint8Array | string): Uint8Array => new Uint8Array(gzipSync(b));

/** Splits a trace fixture into one request per span (for out-of-order delivery tests). */
export function splitSpans(req: J): J[] {
  const out: J[] = [];
  for (const rs of req.resourceSpans)
    for (const ss of rs.scopeSpans)
      for (const s of ss.spans) out.push({ resourceSpans: [{ ...rs, scopeSpans: [{ ...ss, spans: [s] }] }] });
  return out;
}

// ---- tiny OTLP/JSON builders for hand-written traces

export const sAttr = (key: string, v: string): J => ({ key, value: { stringValue: v } });
export const iAttr = (key: string, v: number): J => ({ key, value: { intValue: String(v) } });

const BASE_MS = 1767225600000n;
const nanos = (ms: number) => String((BASE_MS + BigInt(ms)) * 1_000_000n);

/** One OTLP/JSON span; start/end are ms offsets from 2026-01-01T00:00:00Z. */
export function otlpSpan(traceId: string, spanId: string, parentSpanId: string | undefined, name: string, attributes: J[], startMs: number, endMs: number): J {
  const s: J = { traceId, spanId, name, kind: 1, startTimeUnixNano: nanos(startMs), endTimeUnixNano: nanos(endMs), attributes, status: {} };
  if (parentSpanId) s.parentSpanId = parentSpanId;
  return s;
}

/** An ExportTraceServiceRequest (OTLP/JSON) holding `spans` under one resource/scope. */
export function otlpTraces(serviceName: string, spans: J[]): J {
  return { resourceSpans: [{ resource: { attributes: [sAttr("service.name", serviceName)] }, scopeSpans: [{ scope: { name: "test" }, spans }] }] };
}
