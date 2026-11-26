import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeLogsJson, decodeTraceJson, jsonAnyValue, jsonId } from "../../src/otel/json.ts";
import { int64Value, OtlpDecodeError } from "../../src/otel/model.ts";
import { decodeLogsRequest, decodeTraceRequest, encodeExportResponse, encodeStatus, ProtoReader, ProtoWriter } from "../../src/otel/proto.ts";
import { forAll, gen } from "../_prop.ts";
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

  it("treats ids of the wrong length as unset, on spans, links and log records", () => {
    const id = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
    const link = new ProtoWriter().bytes(1, id("ab".repeat(8))).bytes(2, id("01".repeat(8))).finish();
    const span = new ProtoWriter().bytes(1, id("abcdef")).bytes(2, id("01".repeat(16))).bytes(4, id("02".repeat(4))).bytes(13, link).finish();
    const req = new ProtoWriter().message(1, (rs) => rs.message(2, (ss) => ss.bytes(2, span))).finish();
    const s = decodeTraceRequest(req)[0]!.scopeSpans[0]!.spans[0]!;
    assert.deepEqual([s.traceId, s.spanId, s.parentSpanId], [undefined, undefined, undefined]);
    assert.deepEqual(s.links, [{ spanId: "01".repeat(8), attributes: {} }]);

    const log = new ProtoWriter().bytes(9, id("ab".repeat(15))).bytes(10, id("cd".repeat(8))).finish();
    const logs = new ProtoWriter().message(1, (rl) => rl.message(2, (sl) => sl.bytes(2, log))).finish();
    const l = decodeLogsRequest(logs)[0]!.scopeLogs[0]!.logRecords[0]!;
    assert.equal(l.traceId, undefined);
    assert.equal(l.spanId, "cd".repeat(8));
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

  it("reads an int64 as a number when it is a safe integer, else as its decimal text", () => {
    const int = (v: unknown) => jsonAnyValue({ intValue: v });
    assert.equal(int("9007199254740991"), 9007199254740991);
    assert.equal(int("-9007199254740991"), -9007199254740991);
    assert.equal(int("9007199254740992"), "9007199254740992");
    assert.equal(int("-9223372036854775808"), "-9223372036854775808");
    assert.equal(int(" -000042 "), -42);
    assert.equal(int("-0"), 0);
    assert.equal(int("000"), 0);
    assert.equal(int("00009007199254740993"), "9007199254740993");
    assert.equal(int("-0000012345678901234567"), "-12345678901234567");
    // JSON can carry an integer past int64; it is kept as its text too.
    assert.equal(int("00018446744073709551616"), "18446744073709551616");
    for (const bad of ["", " ", "-", "+1", "1.5", "1e3", "0x10", "--1", "1 2", "- 1"]) assert.equal(int(bad), null, JSON.stringify(bad));
    for (const bad of [null, true, {}, [], NaN, Infinity]) assert.equal(int(bad), null);
    assert.equal(int(1.9), 1);
    assert.equal(int(-1.9), -1);
  });

  it("reads int64 text as a BigInt of the whole text gives it, for any digits, sign, zeros and spaces", async () => {
    const viaBigInt = (v: string): number | string | null => (/^-?\d+$/.test(v.trim()) ? int64Value(BigInt(v.trim())) : null);
    const text = gen.map(
      gen.tuple<[string, string, string, string, string, string]>(
        gen.pick(["", " ", "  "]),
        gen.pick(["", "-", "+", "--"]),
        gen.pick(["", "0", "00", "0000"]),
        gen.string({ alphabet: "0123456789", maxLength: 42, avgLength: 16 }),
        gen.pick(["", "", "x", ".5", "e3", " 1", "-"]),
        gen.pick(["", " "]),
      ),
      (parts) => parts.join(""),
    );
    await forAll(text, (v) => assert.deepEqual(jsonAnyValue({ intValue: v }), viaBigInt(v)), { runs: 3000, label: "int64 text" });
    // The edges of the safe range, of 16 digits and of int64, with and without leading zeros.
    for (const e of [0n, 1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, 10n ** 16n - 1n, 10n ** 16n, 2n ** 63n - 1n, 2n ** 63n, 2n ** 64n]) {
      for (const v of ["", "-"].flatMap((sign) => ["", "0", "000"].map((zeros) => `${sign}${zeros}${e}`))) assert.deepEqual(jsonAnyValue({ intValue: v }), viaBigInt(v), v);
    }
  });

  it("reads an int64 from JSON text as from protobuf", async () => {
    const fromProto = (x: bigint) => {
      const span = new ProtoWriter().message(9, (k) => k.string(1, "n").message(2, (v) => v.uint(3, x))).finish();
      const req = new ProtoWriter().message(1, (rs) => rs.message(2, (ss) => ss.bytes(2, span))).finish();
      return decodeTraceRequest(req)[0]!.scopeSpans[0]!.spans[0]!.attributes.n;
    };
    // 64 random bits, shifted right by 0 to 64 so every size of value comes up, then given a sign.
    const value = gen.map(gen.tuple<[number, number, number, boolean]>(gen.int(0, 0xffff_ffff), gen.int(0, 0xffff_ffff), gen.int(0, 64), gen.bool), ([hi, lo, shift, negative]) => {
      const magnitude = ((BigInt(hi) << 32n) | BigInt(lo)) >> BigInt(shift);
      return BigInt.asIntN(64, negative ? -magnitude : magnitude);
    });
    const cases = gen.tuple<[bigint, string, string, string]>(value, gen.pick(["", "0", "000"]), gen.pick(["", " "]), gen.pick(["", " "]));
    await forAll(cases, ([x, zeros, before, after]) => {
      const want = fromProto(x);
      const abs = x < 0n ? -x : x;
      assert.equal(jsonAnyValue({ intValue: `${before}${x < 0n ? "-" : ""}${zeros}${abs}${after}` }), want);
      if (abs <= BigInt(Number.MAX_SAFE_INTEGER)) assert.equal(jsonAnyValue({ intValue: Number(x) }), want);
    }, { runs: 2000, label: "int64 from JSON and protobuf" });
  });

  it("reads a stringValue that holds an object or array as no value, and a number or boolean as its text", () => {
    // An object or array, one level deep or many, is read as no value.
    assert.equal(jsonAnyValue({ stringValue: { toString: 1 } }), null);
    assert.equal(jsonAnyValue({ stringValue: [{ toString: 1 }] }), null);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    assert.equal(jsonAnyValue({ stringValue: deep }), null);
    assert.equal(jsonAnyValue({ stringValue: 5 }), "5");
    assert.equal(jsonAnyValue({ string_value: true }), "true");
  });

  it("reads a time outside fixed64 as unset, as protobuf cannot carry one", () => {
    // 1e23 ns is past what fixed64 holds, and past what a Date holds.
    const start = (t: unknown) => decodeTraceJson({ resourceSpans: [{ scopeSpans: [{ spans: [{ startTimeUnixNano: t }] }] }] })[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano;
    for (const t of ["99999999999999999999999", "18446744073709551616", "1e300", "-1e300", "-5", 1e300, "9".repeat(1_000_000)]) assert.equal(start(t), "0", String(t).slice(0, 30));
    assert.equal(start("18446744073709551615"), "18446744073709551615");
    assert.equal(start("0001767225600000000000"), "1767225600000000000");
    assert.equal(start("1.5e18"), "1500000000000000000");
    assert.equal(start(1767225600000000000), "1767225600000000000");
  });

  it("keeps a double past what a number holds as its protojson string, from JSON as from protobuf", () => {
    // JSON.parse reads 1e400 as Infinity, and protobuf carries NaN. JSON has no such number, so each is kept as text.
    const json = `{"resourceSpans":[{"scopeSpans":[{"spans":[{"kind":1e400,"status":{"code":-1e400},"attributes":[{"key":"big","value":{"doubleValue":1e400}},{"key":"low","value":{"doubleValue":-1e400}}]}]}]}]}`;
    const s = decodeTraceJson(JSON.parse(json))[0]!.scopeSpans[0]!.spans[0]!;
    assert.deepEqual(s.attributes, { big: "Infinity", low: "-Infinity" });
    assert.deepEqual([s.kind, s.status.code], [0, 0]);
    for (const [d, text] of [[NaN, "NaN"], [Infinity, "Infinity"], [-Infinity, "-Infinity"]] as const) {
      const span = new ProtoWriter().message(9, (k) => k.string(1, "d").message(2, (v) => v.double(4, d))).finish();
      const req = new ProtoWriter().message(1, (rs) => rs.message(2, (ss) => ss.bytes(2, span))).finish();
      assert.equal(decodeTraceRequest(req)[0]!.scopeSpans[0]!.spans[0]!.attributes.d, text);
    }
  });

  it("rejects non-object bodies and non-array resourceSpans", () => {
    assert.throws(() => decodeTraceJson([]), OtlpDecodeError);
    assert.throws(() => decodeTraceJson("x"), OtlpDecodeError);
    assert.throws(() => decodeTraceJson({ resourceSpans: {} }), OtlpDecodeError);
    assert.deepEqual(decodeTraceJson({}), []);
  });

  it("reads an id that is not hex or base64 of its length as unset, as an all-zero one", () => {
    const bad: [unknown, 8 | 16][] = [
      ["not an id!", 8],
      ["xyz", 8],
      ["abc", 8],
      ["0123456789abcdeg", 8],
      ["0123456789abcdef", 16],
      ["0123456789abcdef0123456789abcdef", 8],
      ["0".repeat(16), 8],
      ["", 8],
      [12345, 8],
    ];
    for (const [v, bytes] of bad) assert.equal(jsonId(v, bytes), undefined, JSON.stringify(v));
    assert.equal(jsonId("0123456789ABCDEF", 8), "0123456789abcdef");
    assert.equal(jsonId("ASNFZ4mrze8=", 8), "0123456789abcdef");
    assert.equal(jsonId("ASNFZ4mrze8", 8), "0123456789abcdef");

    const links = [{ traceId: "12", spanId: "0123456789abcdef" }];
    const s = decodeTraceJson({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "s", traceId: "xyz", spanId: "abc", parentSpanId: "not hex!", links }] }] }] })[0]!.scopeSpans[0]!.spans[0]!;
    assert.deepEqual([s.traceId, s.spanId, s.parentSpanId], [undefined, undefined, undefined]);
    assert.deepEqual(s.links, [{ spanId: "0123456789abcdef", attributes: {} }]);
    const l = decodeLogsJson({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId: "xyz", spanId: "0123456789abcdef" }] }] }] })[0]!.scopeLogs[0]!.logRecords[0]!;
    assert.equal(l.traceId, undefined);
    assert.equal(l.spanId, "0123456789abcdef");
  });
});
