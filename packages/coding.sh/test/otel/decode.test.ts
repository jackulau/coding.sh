import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeLogsJson, decodeTraceJson, jsonAnyValue, jsonId } from "../../src/otel/json.ts";
import { OtlpDecodeError } from "../../src/otel/model.ts";
import { decodeLogsRequest, decodeTraceRequest, encodeExportResponse, encodeStatus, ProtoReader, ProtoWriter } from "../../src/otel/proto.ts";
import { encodeLogs, encodeTraces, fixture } from "./_encode.ts";

const TRACE_FIXTURES = ["genai-semconv.json", "openinference.json", "vercel-ai.json", "claude-code-traces.json"];

describe("protobuf wire primitives", () => {
  it("decodes varints including multi-byte and 10-byte negative int64", () => {
    assert.equal(new ProtoReader(Uint8Array.from([0xac, 0x02])).varint(), 300);
    const minusOne = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    assert.equal(BigInt.asIntN(64, new ProtoReader(minusOne).varint64()), -1n);
    assert.deepEqual(new ProtoWriter().varint(-1).finish(), minusOne);
    assert.deepEqual(new ProtoWriter().varint(300).finish(), Uint8Array.from([0xac, 0x02]));
  });

  it("decodes every AnyValue variant", () => {
    const w = new ProtoWriter();
    const kv = (key: string, build: (v: ProtoWriter) => void) => w.message(9, (k) => k.string(1, key).message(2, build));
    w.bytes(1, Uint8Array.from(Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex")));
    w.bytes(2, Uint8Array.from(Buffer.from("a1a2a3a4a5a6a7a8", "hex")));
    kv("s", (v) => v.string(1, "héllo"));
    kv("t", (v) => v.uint(2, 1));
    kv("f", (v) => v.uint(2, 0));
    kv("i", (v) => v.uint(3, 42));
    kv("neg", (v) => v.uint(3, -7));
    kv("big", (v) => v.uint(3, 9007199254740993n));
    kv("d", (v) => v.double(4, 1.5));
    kv("arr", (v) => v.message(5, (a) => a.message(1, (x) => x.string(1, "a")).message(1, (x) => x.uint(3, 2))));
    kv("kv", (v) => v.message(6, (l) => l.message(1, (k) => k.string(1, "nested").message(2, (x) => x.uint(2, 1)))));
    kv("b", (v) => v.bytes(7, Uint8Array.from([0xde, 0xad])));
    kv("empty", () => {});
    kv("__proto__", (v) => v.string(1, "data, not a prototype"));
    const req = new ProtoWriter().message(1, (rs) => rs.message(2, (ss) => ss.bytes(2, w.finish()))).finish();
    const [rs] = decodeTraceRequest(req);
    const span = rs!.scopeSpans[0]!.spans[0]!;
    assert.equal(span.traceId, "0102030405060708090a0b0c0d0e0f10");
    assert.equal(span.spanId, "a1a2a3a4a5a6a7a8");
    assert.deepEqual({ ...span.attributes }, {
      s: "héllo",
      t: true,
      f: false,
      i: 42,
      neg: -7,
      big: "9007199254740993",
      d: 1.5,
      arr: ["a", 2],
      kv: { nested: true },
      b: "3q0=",
      empty: null,
      ["__proto__"]: "data, not a prototype",
    });
    assert.equal(Object.getPrototypeOf(span.attributes), Object.prototype);
  });

  it("skips unknown fields of every wire type", () => {
    const span = new ProtoWriter()
      .string(5, "kept")
      .uint(99, 123) // unknown varint
      .fixed64(98, 1n) // unknown i64
      .string(97, "x") // unknown len
      .fixed32(96, 7) // unknown i32
      .finish();
    const req = new ProtoWriter().message(1, (rs) => rs.message(2, (ss) => ss.bytes(2, span))).finish();
    assert.equal(decodeTraceRequest(req)[0]!.scopeSpans[0]!.spans[0]!.name, "kept");
  });

  it("rejects truncated and malformed input with OtlpDecodeError", () => {
    const good = encodeTraces(fixture("genai-semconv.json"));
    assert.throws(() => decodeTraceRequest(good.subarray(0, good.length - 7)), OtlpDecodeError);
    assert.throws(() => decodeTraceRequest(Uint8Array.from([0x0b])), OtlpDecodeError); // wire type 3 (group)
    assert.throws(() => decodeTraceRequest(Uint8Array.from([0x0a, 0x05, 0x01])), OtlpDecodeError); // length past end
    assert.throws(() => decodeLogsRequest(Uint8Array.from([0x00])), OtlpDecodeError); // field 0
  });

  it("treats all-zero ids as unset", () => {
    const span = new ProtoWriter().bytes(1, new Uint8Array(16)).bytes(4, new Uint8Array(8)).finish();
    const req = new ProtoWriter().message(1, (rs) => rs.message(2, (ss) => ss.bytes(2, span))).finish();
    const s = decodeTraceRequest(req)[0]!.scopeSpans[0]!.spans[0]!;
    assert.equal(s.traceId, undefined);
    assert.equal(s.parentSpanId, undefined);
  });

  it("encodes responses: empty success, partial_success, google.rpc.Status", () => {
    assert.equal(encodeExportResponse().length, 0);
    const r = new ProtoReader(encodeExportResponse(2, "bad span"));
    let rejected = 0;
    let msg = "";
    r.fields((f) => {
      assert.equal(f, 1);
      const sub = r.message();
      sub.fields((g) => {
        if (g === 1) rejected = sub.varint();
        else msg = sub.string();
        return true;
      });
      return true;
    });
    assert.deepEqual([rejected, msg], [2, "bad span"]);
    assert.deepEqual(encodeStatus(3, "x"), Uint8Array.from([0x08, 0x03, 0x12, 0x01, 0x78]));
  });
});

describe("JSON and protobuf decode to the same model", () => {
  for (const name of TRACE_FIXTURES) {
    it(name, () => {
      const json = fixture(name);
      assert.deepEqual(decodeTraceRequest(encodeTraces(json)), decodeTraceJson(json));
    });
  }
  it("claude-code-logs.json", () => {
    const json = fixture("claude-code-logs.json");
    assert.deepEqual(decodeLogsRequest(encodeLogs(json)), decodeLogsJson(json));
  });
});

describe("OTLP/JSON quirks", () => {
  it("accepts snake_case keys, base64 ids, enum names and numeric int64", () => {
    const [rs] = decodeTraceJson({
      resource_spans: [
        {
          resource: { attributes: [{ key: "service.name", value: { string_value: "svc" } }] },
          scope_spans: [
            {
              scope: { name: "s" },
              spans: [
                {
                  trace_id: Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex").toString("base64"),
                  span_id: "A1A2A3A4A5A6A7A8",
                  parent_span_id: "",
                  name: "x",
                  kind: "SPAN_KIND_CLIENT",
                  start_time_unix_nano: 1767225600000000000,
                  end_time_unix_nano: "1767225601000000000",
                  status: { code: "STATUS_CODE_ERROR", message: "boom" },
                  attributes: [{ key: "n", value: { int_value: 5 } }, { key: "nan", value: { doubleValue: "NaN" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const s = rs!.scopeSpans[0]!.spans[0]!;
    assert.equal(rs!.resource.attributes["service.name"], "svc");
    assert.equal(s.traceId, "0102030405060708090a0b0c0d0e0f10");
    assert.equal(s.spanId, "a1a2a3a4a5a6a7a8");
    assert.equal(s.parentSpanId, undefined);
    assert.equal(s.kind, 3);
    assert.deepEqual(s.status, { code: 2, message: "boom" });
    assert.equal(s.startTimeUnixNano, "1767225600000000000");
    assert.deepEqual(s.attributes, { n: 5, nan: "NaN" });
  });

  it("decodes nested AnyValues and empty values", () => {
    assert.deepEqual(jsonAnyValue({ arrayValue: { values: [{ intValue: "9007199254740993" }, { boolValue: false }, {}] } }), ["9007199254740993", false, null]);
    assert.deepEqual(jsonAnyValue({ kvlistValue: { values: [{ key: "a", value: { stringValue: "b" } }] } }), { a: "b" });
    assert.deepEqual(jsonAnyValue({ arrayValue: {} }), []);
  });

  it("rejects non-object bodies and non-array resourceSpans", () => {
    assert.throws(() => decodeTraceJson([]), OtlpDecodeError);
    assert.throws(() => decodeTraceJson("x"), OtlpDecodeError);
    assert.throws(() => decodeTraceJson({ resourceSpans: {} }), OtlpDecodeError);
    assert.deepEqual(decodeTraceJson({}), []);
    assert.throws(() => jsonId("not an id!", 8), OtlpDecodeError);
  });
});
