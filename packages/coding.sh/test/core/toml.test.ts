import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToml, stringifyToml, TomlError } from "../../src/core/toml.ts";

describe("parseToml", () => {
  it("parses scalars, comments and tables", () => {
    const doc = parseToml(`
# top comment
title = "coding.sh" # inline comment
count = 1_000
neg = -42
hex = 0xff
oct = 0o17
bin = 0b101
pi = 3.14
exp = 1e3
negexp = -2.5E-2
yes = true
no = false
big = inf
nope = nan

[store]
index = 'sqlite://~/.coding.sh/index.db'
"quoted key" = "v"

[capture]
redact = ["secrets", "env",] # trailing comma
nested = [[1, 2], ["a"]]
multi = [
  "a", # comment inside array
  "b",
]
`);
    assert.equal(doc.title, "coding.sh");
    assert.equal(doc.count, 1000);
    assert.equal(doc.neg, -42);
    assert.equal(doc.hex, 255);
    assert.equal(doc.oct, 15);
    assert.equal(doc.bin, 5);
    assert.equal(doc.pi, 3.14);
    assert.equal(doc.exp, 1000);
    assert.equal(doc.negexp, -0.025);
    assert.equal(doc.yes, true);
    assert.equal(doc.no, false);
    assert.equal(doc.big, Infinity);
    assert.ok(Number.isNaN(doc.nope));
    assert.deepEqual(doc.store, { index: "sqlite://~/.coding.sh/index.db", "quoted key": "v" });
    assert.deepEqual(doc.capture, { redact: ["secrets", "env"], nested: [[1, 2], ["a"]], multi: ["a", "b"] });
  });

  it("handles string escapes and literal strings", () => {
    const doc = parseToml(String.raw`
a = "tab\there \"q\" \\ \u00e9 \U0001F600"
b = 'C:\no\escapes'
c = "# not a comment"
`);
    assert.equal(doc.a, 'tab\there "q" \\ é 😀');
    assert.equal(doc.b, "C:\\no\\escapes");
    assert.equal(doc.c, "# not a comment");
  });

  it("handles multi-line strings", () => {
    const doc = parseToml('a = """\nline1\nline2"""\nb = \'\'\'\nraw \\n\n\'\'\'\nc = """one \\\n    two"""\nd = """x""""\n');
    assert.equal(doc.a, "line1\nline2");
    assert.equal(doc.b, "raw \\n\n");
    assert.equal(doc.c, "one two");
    assert.equal(doc.d, 'x"');
  });

  it("supports arrays of tables with sub-tables, dotted keys and inline tables", () => {
    const doc = parseToml(`
[[sinks]]
kind = "otlp"
headers = { Authorization = "Bearer x", "x-y" = "z" }

[[sinks]]
kind = "http"
[sinks.headers]
a = "b"

[a.b]
c.d = 1
`);
    assert.deepEqual(doc.sinks, [
      { kind: "otlp", headers: { Authorization: "Bearer x", "x-y": "z" } },
      { kind: "http", headers: { a: "b" } },
    ]);
    assert.deepEqual(doc.a, { b: { c: { d: 1 } } });
  });

  it("allows a super-table after its sub-table", () => {
    assert.deepEqual(parseToml("[a.b]\nx = 1\n[a]\ny = 2\n"), { a: { b: { x: 1 }, y: 2 } });
  });

  it("treats __proto__ as an ordinary key", () => {
    const doc2 = parseToml('"__proto__" = 1');
    assert.equal(Object.getPrototypeOf(doc2), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(doc2, "__proto__")?.value, 1);
  });

  const bad: [string, RegExp, number][] = [
    ["a = 1\na = 2", /duplicate key "a"/, 2],
    ["[t]\n[t]", /defined more than once/, 2],
    ["a = \"unterminated", /unterminated string/, 1],
    ["a = bare", /strings must be quoted/, 1],
    ["a = 1979-05-27", /date\/time values are not supported/, 1],
    ["a = 1 2", /expected end of line/, 1],
    ["\n\nkey", /expected = after key/, 3],
    ['a = "\\q"', /invalid escape/, 1],
    ["a = [1, 2", /expected , or \]|unterminated array/, 1],
    ["a = { b = 1, }", /trailing comma/, 1],
    ["a = 1\n[a]", /already holds a value/, 2],
    ["[x]\ny = { z = 1 }\n[x.y]", /defined more than once/, 3],
    ["a = 99999999999999999999", /safe range/, 1],
    ["a = 0o9", /invalid number/, 1],
  ];
  for (const [src, re, line] of bad) {
    it(`rejects ${JSON.stringify(src)} at line ${line}`, () => {
      assert.throws(() => parseToml(src, "cfg.toml"), (err: unknown) => {
        assert.ok(err instanceof TomlError, String(err));
        assert.match(err.message, re);
        assert.equal(err.line, line);
        assert.ok(err.message.startsWith(`cfg.toml:${line}:`), err.message);
        return true;
      });
    });
  }

  it("accepts CRLF line endings and a BOM", () => {
    assert.deepEqual(parseToml("\uFEFFa = 1\r\n[b]\r\nc = 'd'\r\n"), { a: 1, b: { c: "d" } });
  });
});

describe("stringifyToml", () => {
  it("round-trips a config-shaped object", () => {
    const obj = {
      version: 1,
      ratio: 0.5,
      name: 'quote " and \\ and\nnewline',
      on: true,
      list: ["a", "b"],
      empty: {},
      capture: { mode: "full", redact: ["secrets"], maxInlineBytes: 4096 },
      deep: { inner: { x: 1 } },
      sinks: [
        { kind: "otlp", endpoint: "http://x", headers: { Authorization: "Bearer y" } },
        { kind: "http", endpoint: "http://z" },
      ],
      "odd key": 1,
    };
    const text = stringifyToml(obj);
    assert.deepEqual(parseToml(text), obj);
    assert.match(text, /\[\[sinks\]\]/);
    assert.match(text, /\[sinks\.headers\]/);
  });

  it("omits null/undefined and rejects unsupported values", () => {
    assert.deepEqual(parseToml(stringifyToml({ a: 1, b: undefined, c: null })), { a: 1 });
    assert.throws(() => stringifyToml({ d: new Date() }), /cannot serialize/);
    assert.throws(() => stringifyToml({ a: [1, null] }), /cannot serialize null/);
    assert.equal(stringifyToml({}), "");
  });

  it("serializes special floats", () => {
    assert.deepEqual(parseToml(stringifyToml({ a: Infinity, b: -Infinity, c: 1.25 })), { a: Infinity, b: -Infinity, c: 1.25 });
  });
});
