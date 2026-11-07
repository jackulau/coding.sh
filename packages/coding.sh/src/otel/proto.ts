// Minimal protobuf wire-format decoder for OTLP export requests (traces and
// logs), plus the tiny encoder needed for OTLP responses. Zero dependencies.
//
// Field numbers are from opentelemetry-proto (main, verified 2026-11):
//   collector/trace/v1/trace_service.proto  ExportTraceServiceRequest  1 resource_spans
//   collector/logs/v1/logs_service.proto    ExportLogsServiceRequest   1 resource_logs
//   resource/v1/resource.proto  Resource     1 attributes  2 dropped_attributes_count  3 entity_refs
//   common/v1/common.proto      AnyValue     1 string 2 bool 3 int64 4 double 5 array 6 kvlist 7 bytes
//                                            (8 string_value_strindex: profiles-only, ignored)
//                               ArrayValue   1 values      KeyValueList 1 values
//                               KeyValue     1 key 2 value (3 key_strindex: profiles-only, ignored)
//                               InstrumentationScope 1 name 2 version 3 attributes
//   trace/v1/trace.proto  ResourceSpans 1 resource 2 scope_spans 3 schema_url
//                         ScopeSpans    1 scope 2 spans 3 schema_url
//                         Span   1 trace_id 2 span_id 3 trace_state 4 parent_span_id 5 name
//                                6 kind 7 start_time_unix_nano(fixed64) 8 end_time_unix_nano(fixed64)
//                                9 attributes 11 events 13 links 15 status 16 flags(fixed32)
//                         Span.Event 1 time_unix_nano(fixed64) 2 name 3 attributes
//                         Span.Link  1 trace_id 2 span_id 3 trace_state 4 attributes 6 flags
//                         Status     2 message 3 code
//   logs/v1/logs.proto    ResourceLogs 1 resource 2 scope_logs 3 schema_url
//                         ScopeLogs    1 scope 2 log_records 3 schema_url
//                         LogRecord 1 time_unix_nano(fixed64) 11 observed_time_unix_nano(fixed64)
//                                   2 severity_number 3 severity_text 5 body 6 attributes
//                                   8 flags(fixed32) 9 trace_id 10 span_id 12 event_name
//   Export*ServiceResponse 1 partial_success { 1 rejected_* (int64) 2 error_message }
//   google.rpc.Status      1 code(int32) 2 message
import {
  type Attrs,
  bytesToHex,
  int64Value,
  normId,
  type OtelLink,
  type OtelLogRecord,
  type OtelResource,
  type OtelScope,
  type OtelSpan,
  type OtelSpanEvent,
  type OtelValue,
  OtlpDecodeError,
  type ResourceLogs,
  type ResourceSpans,
  type ScopeLogs,
  type ScopeSpans,
} from "./model.ts";

const WT_VARINT = 0;
const WT_I64 = 1;
const WT_LEN = 2;
const WT_I32 = 5;
/** AnyValue nesting (array/kvlist) deeper than this is rejected, to bound recursion. */
const MAX_DEPTH = 32;

const utf8 = new TextDecoder("utf-8");

/** Cursor over one length-delimited region of a protobuf buffer. */
export class ProtoReader {
  pos: number;
  readonly buf: Uint8Array;
  readonly end: number;
  private view: DataView | undefined;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  eof(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new OtlpDecodeError(`protobuf: truncated message at byte ${this.pos}`);
  }

  /** Varint as a JS number (exact up to 2^53; used for tags, lengths, enums, uint32). */
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      this.need(1);
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new OtlpDecodeError(`protobuf: varint too long at byte ${this.pos}`);
  }

  /** Varint as an unsigned 64-bit bigint. */
  varint64(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      this.need(1);
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw new OtlpDecodeError(`protobuf: varint too long at byte ${this.pos}`);
  }

  private dv(): DataView {
    return (this.view ??= new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength));
  }

  fixed64(): bigint {
    this.need(8);
    const v = this.dv().getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  fixed32(): number {
    this.need(4);
    const v = this.dv().getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    this.need(8);
    const v = this.dv().getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bytes(): Uint8Array {
    const len = this.varint();
    this.need(len);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return utf8.decode(this.bytes());
  }

  /** Reader over the next length-delimited field (a sub-message). */
  message(): ProtoReader {
    const len = this.varint();
    this.need(len);
    const sub = new ProtoReader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return sub;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WT_VARINT:
        this.varint64();
        return;
      case WT_I64:
        this.need(8);
        this.pos += 8;
        return;
      case WT_LEN: {
        const len = this.varint();
        this.need(len);
        this.pos += len;
        return;
      }
      case WT_I32:
        this.need(4);
        this.pos += 4;
        return;
      default:
        // 3/4 are deprecated groups; nothing in OTLP uses them.
        throw new OtlpDecodeError(`protobuf: unsupported wire type ${wireType} at byte ${this.pos}`);
    }
  }

  /**
   * Iterates fields; `handle` returns true when it consumed the value.
   * Unknown fields, and known fields with an unexpected wire type, are skipped
   * (forward compatibility, like every protobuf runtime).
   */
  fields(handle: (field: number, wireType: number) => boolean): void {
    while (!this.eof()) {
      const tag = this.varint();
      const field = Math.floor(tag / 8);
      const wt = tag & 7;
      if (field === 0) throw new OtlpDecodeError(`protobuf: invalid field number 0 at byte ${this.pos}`);
      if (!handle(field, wt)) this.skip(wt);
    }
  }
}

// ---------------------------------------------------------------- common

function base64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
}

function anyValue(r: ProtoReader, depth: number): OtelValue {
  if (depth > MAX_DEPTH) throw new OtlpDecodeError("protobuf: AnyValue nested too deeply");
  let out: OtelValue = null;
  r.fields((f, wt) => {
    if (f === 1 && wt === WT_LEN) out = r.string();
    else if (f === 2 && wt === WT_VARINT) out = r.varint() !== 0;
    else if (f === 3 && wt === WT_VARINT) out = int64Value(BigInt.asIntN(64, r.varint64()));
    else if (f === 4 && wt === WT_I64) out = r.double();
    else if (f === 5 && wt === WT_LEN) {
      const arr: OtelValue[] = [];
      const sub = r.message();
      sub.fields((g, gwt) => {
        if (g !== 1 || gwt !== WT_LEN) return false;
        arr.push(anyValue(sub.message(), depth + 1));
        return true;
      });
      out = arr;
    } else if (f === 6 && wt === WT_LEN) {
      const obj: Record<string, OtelValue> = {};
      const sub = r.message();
      sub.fields((g, gwt) => {
        if (g !== 1 || gwt !== WT_LEN) return false;
        keyValueInto(sub.message(), obj, depth + 1);
        return true;
      });
      out = obj;
    } else if (f === 7 && wt === WT_LEN) out = base64(r.bytes());
    else return false;
    return true;
  });
  return out;
}

function keyValueInto(r: ProtoReader, into: Record<string, OtelValue>, depth: number): void {
  let key = "";
  let value: OtelValue = null;
  r.fields((f, wt) => {
    if (f === 1 && wt === WT_LEN) key = r.string();
    else if (f === 2 && wt === WT_LEN) value = anyValue(r.message(), depth);
    else return false;
    return true;
  });
  // defineProperty: a key named "__proto__" must stay data, not change the prototype.
  Object.defineProperty(into, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Handles a repeated KeyValue field into `attrs` when (f, wt) matches `field`. */
function attr(r: ProtoReader, attrs: Attrs, field: number, f: number, wt: number): boolean {
  if (f !== field || wt !== WT_LEN) return false;
  keyValueInto(r.message(), attrs, 0);
  return true;
}

function resource(r: ProtoReader): OtelResource {
  const attributes: Attrs = {};
  r.fields((f, wt) => attr(r, attributes, 1, f, wt));
  return { attributes };
}

function scope(r: ProtoReader): OtelScope {
  const s: OtelScope = { name: "", attributes: {} };
  r.fields((f, wt) => {
    if (f === 1 && wt === WT_LEN) s.name = r.string();
    else if (f === 2 && wt === WT_LEN) s.version = r.string() || undefined;
    else return attr(r, s.attributes, 3, f, wt);
    return true;
  });
  if (s.version === undefined) delete s.version;
  return s;
}

const id = (r: ProtoReader): string | undefined => normId(bytesToHex(r.bytes()));

function setIf<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v !== undefined && v !== "") o[k] = v;
}

// ---------------------------------------------------------------- traces

function spanEvent(r: ProtoReader): OtelSpanEvent {
  const e: OtelSpanEvent = { timeUnixNano: "0", name: "", attributes: {} };
  r.fields((f, wt) => {
    if (f === 1 && wt === WT_I64) e.timeUnixNano = r.fixed64().toString();
    else if (f === 2 && wt === WT_LEN) e.name = r.string();
    else return attr(r, e.attributes, 3, f, wt);
    return true;
  });
  return e;
}

function spanLink(r: ProtoReader): OtelLink {
  const l: OtelLink = { attributes: {} };
  r.fields((f, wt) => {
    if (f === 1 && wt === WT_LEN) setIf(l, "traceId", id(r));
    else if (f === 2 && wt === WT_LEN) setIf(l, "spanId", id(r));
    else return attr(r, l.attributes, 4, f, wt);
    return true;
  });
  return l;
}

function span(r: ProtoReader): OtelSpan {
  const s: OtelSpan = {
    name: "",
    kind: 0,
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    attributes: {},
    events: [],
    links: [],
    status: { code: 0 },
  };
  r.fields((f, wt) => {
    if (wt === WT_LEN) {
      switch (f) {
        case 1:
          setIf(s, "traceId", id(r));
          return true;
        case 2:
          setIf(s, "spanId", id(r));
          return true;
        case 3:
          setIf(s, "traceState", r.string());
          return true;
        case 4:
          setIf(s, "parentSpanId", id(r));
          return true;
        case 5:
          s.name = r.string();
          return true;
        case 9:
          return attr(r, s.attributes, 9, f, wt);
        case 11:
          s.events.push(spanEvent(r.message()));
          return true;
        case 13:
          s.links.push(spanLink(r.message()));
          return true;
        case 15: {
          const st = r.message();
          st.fields((g, gwt) => {
            if (g === 2 && gwt === WT_LEN) setIf(s.status, "message", st.string());
            else if (g === 3 && gwt === WT_VARINT) s.status.code = st.varint();
            else return false;
            return true;
          });
          return true;
        }
      }
      return false;
    }
    if (f === 6 && wt === WT_VARINT) s.kind = r.varint();
    else if (f === 7 && wt === WT_I64) s.startTimeUnixNano = r.fixed64().toString();
    else if (f === 8 && wt === WT_I64) s.endTimeUnixNano = r.fixed64().toString();
    else if (f === 16 && wt === WT_I32) s.flags = r.fixed32();
    else return false;
    return true;
  });
  return s;
}

function scopeSpans(r: ProtoReader): ScopeSpans {
  const ss: ScopeSpans = { scope: { name: "", attributes: {} }, spans: [] };
  r.fields((f, wt) => {
    if (wt !== WT_LEN) return false;
    if (f === 1) ss.scope = scope(r.message());
    else if (f === 2) ss.spans.push(span(r.message()));
    else if (f === 3) setIf(ss.scope, "schemaUrl", r.string());
    else return false;
    return true;
  });
  return ss;
}

function resourceSpans(r: ProtoReader): ResourceSpans {
  const rs: ResourceSpans = { resource: { attributes: {} }, scopeSpans: [] };
  let schemaUrl: string | undefined;
  r.fields((f, wt) => {
    if (wt !== WT_LEN) return false;
    if (f === 1) rs.resource = resource(r.message());
    else if (f === 2) rs.scopeSpans.push(scopeSpans(r.message()));
    else if (f === 3) schemaUrl = r.string();
    else return false;
    return true;
  });
  setIf(rs.resource, "schemaUrl", schemaUrl);
  return rs;
}

/** Decodes an ExportTraceServiceRequest. Throws OtlpDecodeError on malformed input. */
export function decodeTraceRequest(buf: Uint8Array): ResourceSpans[] {
  const r = new ProtoReader(buf);
  const out: ResourceSpans[] = [];
  r.fields((f, wt) => {
    if (f !== 1 || wt !== WT_LEN) return false;
    out.push(resourceSpans(r.message()));
    return true;
  });
  return out;
}

// ---------------------------------------------------------------- logs

function logRecord(r: ProtoReader): OtelLogRecord {
  const l: OtelLogRecord = { timeUnixNano: "0", observedTimeUnixNano: "0", severityNumber: 0, attributes: {} };
  r.fields((f, wt) => {
    if (wt === WT_LEN) {
      switch (f) {
        case 3:
          setIf(l, "severityText", r.string());
          return true;
        case 5:
          l.body = anyValue(r.message(), 0);
          return true;
        case 6:
          return attr(r, l.attributes, 6, f, wt);
        case 9:
          setIf(l, "traceId", id(r));
          return true;
        case 10:
          setIf(l, "spanId", id(r));
          return true;
        case 12:
          setIf(l, "eventName", r.string());
          return true;
      }
      return false;
    }
    if (f === 1 && wt === WT_I64) l.timeUnixNano = r.fixed64().toString();
    else if (f === 11 && wt === WT_I64) l.observedTimeUnixNano = r.fixed64().toString();
    else if (f === 2 && wt === WT_VARINT) l.severityNumber = r.varint();
    else if (f === 8 && wt === WT_I32) l.flags = r.fixed32();
    else return false;
    return true;
  });
  return l;
}

function scopeLogs(r: ProtoReader): ScopeLogs {
  const sl: ScopeLogs = { scope: { name: "", attributes: {} }, logRecords: [] };
  r.fields((f, wt) => {
    if (wt !== WT_LEN) return false;
    if (f === 1) sl.scope = scope(r.message());
    else if (f === 2) sl.logRecords.push(logRecord(r.message()));
    else if (f === 3) setIf(sl.scope, "schemaUrl", r.string());
    else return false;
    return true;
  });
  return sl;
}

function resourceLogs(r: ProtoReader): ResourceLogs {
  const rl: ResourceLogs = { resource: { attributes: {} }, scopeLogs: [] };
  let schemaUrl: string | undefined;
  r.fields((f, wt) => {
    if (wt !== WT_LEN) return false;
    if (f === 1) rl.resource = resource(r.message());
    else if (f === 2) rl.scopeLogs.push(scopeLogs(r.message()));
    else if (f === 3) schemaUrl = r.string();
    else return false;
    return true;
  });
  setIf(rl.resource, "schemaUrl", schemaUrl);
  return rl;
}

/** Decodes an ExportLogsServiceRequest. Throws OtlpDecodeError on malformed input. */
export function decodeLogsRequest(buf: Uint8Array): ResourceLogs[] {
  const r = new ProtoReader(buf);
  const out: ResourceLogs[] = [];
  r.fields((f, wt) => {
    if (f !== 1 || wt !== WT_LEN) return false;
    out.push(resourceLogs(r.message()));
    return true;
  });
  return out;
}

/**
 * Walks an ExportMetricsServiceRequest just far enough to validate framing.
 * Metrics are accepted and dropped for now; this keeps a corrupt body a 400.
 */
export function validateMessage(buf: Uint8Array): void {
  const r = new ProtoReader(buf);
  r.fields(() => false);
}

// ---------------------------------------------------------------- encoding

/** Append-only protobuf writer: just enough for OTLP responses (and test fixtures). */
export class ProtoWriter {
  private chunks: number[] = [];

  varint(v: number | bigint): this {
    let x = BigInt.asUintN(64, BigInt(v));
    while (x >= 0x80n) {
      this.chunks.push(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    this.chunks.push(Number(x));
    return this;
  }

  tag(field: number, wireType: number): this {
    return this.varint(field * 8 + wireType);
  }

  bytes(field: number, b: Uint8Array): this {
    this.tag(field, WT_LEN).varint(b.length);
    for (const x of b) this.chunks.push(x);
    return this;
  }

  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }

  uint(field: number, v: number | bigint): this {
    return this.tag(field, WT_VARINT).varint(v);
  }

  fixed64(field: number, v: bigint | string): this {
    this.tag(field, WT_I64);
    let x = BigInt.asUintN(64, BigInt(v));
    for (let i = 0; i < 8; i++) {
      this.chunks.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  fixed32(field: number, v: number): this {
    this.tag(field, WT_I32);
    for (let i = 0; i < 4; i++) this.chunks.push((v >>> (8 * i)) & 0xff);
    return this;
  }

  double(field: number, v: number): this {
    this.tag(field, WT_I64);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    for (const x of b) this.chunks.push(x);
    return this;
  }

  message(field: number, build: (w: ProtoWriter) => void): this {
    const w = new ProtoWriter();
    build(w);
    return this.bytes(field, w.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/**
 * Export{Trace,Logs,Metrics}ServiceResponse. The three share a layout:
 * partial_success = 1 { rejected_* = 1, error_message = 2 }. Success is empty.
 */
export function encodeExportResponse(rejected = 0, errorMessage = ""): Uint8Array {
  const w = new ProtoWriter();
  if (rejected > 0 || errorMessage) {
    w.message(1, (p) => {
      if (rejected > 0) p.uint(1, rejected);
      if (errorMessage) p.string(2, errorMessage);
    });
  }
  return w.finish();
}

/** google.rpc.Status, the body OTLP/HTTP servers send with 4xx/5xx. */
export function encodeStatus(code: number, message: string): Uint8Array {
  return new ProtoWriter().uint(1, code).string(2, message).finish();
}
