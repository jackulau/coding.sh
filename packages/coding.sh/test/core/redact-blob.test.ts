import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rawBlob as sharedRawBlob } from "../../src/adapters/_shared/normalize.ts";
import { rawBlob as moreRawBlob } from "../../src/adapters/more/_util.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { normalizeContext } from "../../src/core/ingest.ts";
import { createRedactor, redactBlobValue, redactForBlob, redactionTally, SECRET_NEEDLES } from "../../src/core/redact.ts";

// Built from parts so no secret-looking literal sits in the source.
const SECRET = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"].join("");
// The same without the "KEY" it ends in: no rule has a needle in it, so only a secret name before it marks it.
const BARE = SECRET.replace("KEY", "");

const redactor = createRedactor({ redact: ["secrets"] });
const config = defaultConfig({ CODING_SH_HOME: "/work/demo/.coding.sh", HOME: "/home/user" });

function context() {
  const stored: string[] = [];
  const blobs = {
    put: async (d: string | Uint8Array) => {
      stored.push(typeof d === "string" ? d : new TextDecoder().decode(d));
      return `ref${stored.length}`;
    },
  };
  return { ctx: normalizeContext({ config, redactor }, blobs, false), stored };
}

// What a hook line carries: a tool output with a NAME=value line after a newline.
const raw = { hook_event_name: "PostToolUse", tool_response: { stdout: `A=1\nAWS_SECRET_ACCESS_KEY=${SECRET}\nB=2` } };

describe("raw blobs are redacted before they are serialized", () => {
  it("shared rawBlob: a NAME=value after a newline is not stored", async () => {
    const { ctx, stored } = context();
    await sharedRawBlob(ctx, raw);
    assert.equal(stored.length, 1);
    assert.ok(!stored[0]!.includes(SECRET), stored[0]);
    assert.match(stored[0]!, /redacted/);
    assert.match(stored[0]!, /PostToolUse/);
  });

  it("more rawBlob: the same", async () => {
    const { ctx, stored } = context();
    await moreRawBlob(ctx, raw);
    assert.ok(!stored[0]!.includes(SECRET), stored[0]);
  });

  it("a string raw value is redacted as text", async () => {
    const { ctx, stored } = context();
    await sharedRawBlob(ctx, `A=1\nAWS_SECRET_ACCESS_KEY=${SECRET}`);
    assert.ok(!stored[0]!.includes(SECRET), stored[0]);
  });

  it("redactForBlob follows a JSON document inside a string and counts hits", () => {
    const tally = redactionTally();
    const out = redactForBlob(redactor, { a: JSON.stringify({ out: `X=1\nAWS_SECRET_ACCESS_KEY=${SECRET}` }) }, tally);
    assert.ok(!JSON.stringify(out).includes(SECRET));
    assert.ok(Object.keys(tally.kinds).length > 0);
  });
});

describe("redactBlobValue runs only the rules the value's JSON text holds a needle of", () => {
  it("no needle holds a character that JSON text escapes, so the text holds every needle its strings hold", () => {
    for (const [kind, n] of Object.entries(SECRET_NEEDLES)) {
      for (const x of n.any) {
        assert.doesNotMatch(x, /["\\\u0000-\u001f\ud800-\udfff]/, `${kind}: ${JSON.stringify(x)}`);
        // ASCII: lower-cased the same in a string and in the text around it.
        if (n.fold) assert.match(x, /^[\x20-\x7e]+$/, `${kind}: ${JSON.stringify(x)}`);
      }
    }
  });

  it("gives the text and counts of redacting each string, then the serialized text", () => {
    const token = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    let deep: unknown = { out: `AWS_SECRET_ACCESS_KEY=${SECRET}`, argv: ["--api-key", "abcdefgh"] };
    for (let i = 0; i < 70; i++) deep = { n: deep };
    const values: unknown[] = [
      // Only the text pass finds this one: the key is not a secret attribute key.
      { mytoken: "abcdefgh1234567890" },
      ["node", "cli.js", "--api-key", "abcd1234efgh", "--token=xyz98765", token],
      raw,
      { a: JSON.stringify({ out: `X=1\nAWS_SECRET_ACCESS_KEY=${SECRET}`, inner: JSON.stringify({ t: token }) }) },
      { note: "[redacted:openai-key] and [redacted:secret-flag]", api_key: "abcdefgh", plain: "hello" },
      { a: "AUTHOR\u0130ZAT\u0130ON: Token abcdefgh12345678", b: "\u212Aey: abcdefgh12345678", c: "\ud800 lone", d: "tab\there" },
      deep,
      { big: "x".repeat(10_000), list: [1, true, null, {}, []] },
      `plain text AWS_SECRET_ACCESS_KEY=${SECRET}`,
      42,
    ];
    for (const r of [redactor, createRedactor({ redact: ["secrets", "email"], patterns: ["INTERNAL-[A-Z]+"] })]) {
      for (const v of values) {
        const want = redactionTally();
        const clean = redactForBlob(r, v, want);
        const expected = typeof clean === "string" ? clean : r.string(JSON.stringify(clean) ?? "", want);
        const got = redactionTally();
        const label = JSON.stringify(v).slice(0, 120);
        assert.equal(redactBlobValue(r, v, got), expected, label);
        assert.equal(JSON.stringify(got), JSON.stringify(want), label);
      }
    }
  });
});

describe("redactBlobValue copies only what redaction changes", () => {
  const token = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
  /** redactForBlob, then serialized, then the string rules on that text: what redactBlobValue gives. */
  const reference = (v: unknown) => {
    const tally = redactionTally();
    const clean = redactForBlob(redactor, v, tally);
    return { text: typeof clean === "string" ? clean : redactor.string(JSON.stringify(clean) ?? "", tally), tally: JSON.stringify(tally) };
  };
  const deepFreeze = <T>(v: T): T => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) deepFreeze(x);
      Object.freeze(v);
    }
    return v;
  };

  it("leaves the value as it was, whether it changed in parts or not at all", () => {
    const values: unknown[] = [
      { a: { b: ["plain", { c: "text" }] }, d: [1, null, true], e: {} },
      { a: { b: ["plain", { c: `AWS_SECRET_ACCESS_KEY=${SECRET}` }] }, d: ["x", token], e: { f: "same" } },
      [{ a: "plain" }, ["--api-key", "abcdefgh"], { api_key: "abcdefgh" }, { s: JSON.stringify({ t: token }) }],
    ];
    for (const v of values) {
      const before = JSON.stringify(v);
      const want = reference(JSON.parse(before));
      const tally = redactionTally();
      // Frozen: a write into the input throws (an ES module is strict).
      assert.equal(redactBlobValue(redactor, deepFreeze(v), tally), want.text, before);
      assert.equal(JSON.stringify(tally), want.tally, before);
      assert.equal(JSON.stringify(v), before);
    }
  });

  it("serializes a value that is not JSON data as before: a copy of its own keys", () => {
    class Box {
      x = "plain";
      y = { z: "token=abcdef1234567890" };
    }
    const values: unknown[] = [
      { d: new Date(0), plain: "hello" },
      [new Date(0), "x"],
      { s: new String(token), n: new Number(3) },
      { toJSON: () => ({ other: token }), a: "plain" },
      // toJSON reads the copy it is called on: the redacted one.
      { a: `api_token\t=\t${BARE}`, toJSON(this: { a: string }) { return { b: this.a.slice("api_token".length) }; } },
      Object.assign(Object.create(null), { a: "plain", inner: Object.assign(Object.create(null), { b: "text" }) }),
      Object.assign(Object.create({ inherited: token }), { own: "plain" }),
      new Box(),
      { a: [1, , 3], b: { c: [undefined, "plain"] } },
    ];
    for (const v of values) {
      const want = reference(v);
      const tally = redactionTally();
      const label = String(JSON.stringify(v)).slice(0, 120);
      const out = redactBlobValue(redactor, v, tally);
      assert.equal(out, want.text, label);
      assert.equal(JSON.stringify(tally), want.tally, label);
      assert.ok(!out.includes(BARE), label);
    }
  });

  it("reads a getter or a Proxy once, and redacts what that read gave", () => {
    const given = `api_token\t=\t${SECRET}`;
    let reads = 0;
    // `given` on the first read, "plain" on any later one.
    const read = () => (++reads === 1 ? given : "plain");
    const cases: Array<[make: () => unknown, plain: unknown]> = [
      [() => ({ a: token, get b() { return read(); } }), { a: token, b: given }],
      [() => ({ x: [{ a: token, get b() { return read(); } }] }), { x: [{ a: token, b: given }] }],
      [() => Object.defineProperty([token, "plain"], 1, { get: read, enumerable: true }), [token, given]],
      [() => new Proxy({ a: token, b: "plain" }, { get: (t, k, rcv) => (k === "b" ? read() : Reflect.get(t, k, rcv)) }), { a: token, b: given }],
      [() => new Proxy([token, "plain"], { get: (t, k, rcv) => (k === "1" ? read() : Reflect.get(t, k, rcv)) }), [token, given]],
    ];
    for (const [make, plain] of cases) {
      const want = reference(plain);
      const label = JSON.stringify(plain);
      reads = 0;
      const tally = redactionTally();
      const out = redactBlobValue(redactor, make(), tally);
      assert.equal(reads, 1, label);
      assert.equal(out, want.text, label);
      assert.equal(JSON.stringify(tally), want.tally, label);
      assert.ok(!out.includes(SECRET), label);
    }
  });

  it("reads an array Proxy's length as map does, also a fraction, a number below 0 or NaN", () => {
    const cases: Array<[length: number, plain: unknown]> = [
      [1.5, [token]],
      [-1, []],
      [Number.NaN, []],
    ];
    for (const [length, plain] of cases) {
      const v = new Proxy([token, "plain"], { get: (t, k, rcv) => (k === "length" ? length : Reflect.get(t, k, rcv)) });
      const want = reference(plain);
      const tally = redactionTally();
      assert.equal(redactBlobValue(redactor, v, tally), want.text, String(length));
      assert.equal(JSON.stringify(tally), want.tally, String(length));
    }
  });
});

describe("redactBlobValue on the recorded adapter fixtures", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters");

  it("gives the text and counts of redactForBlob and the text pass for every JSON line", () => {
    const values: Array<[label: string, v: unknown]> = [];
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".jsonl")).sort();
    for (const rel of files) {
      for (const [n, line] of readFileSync(join(root, rel), "utf8").split("\n").entries()) {
        const t = line.trim();
        if (!t.startsWith("{") && !t.startsWith("[")) continue;
        try {
          values.push([`${rel}:${n + 1}`, JSON.parse(t)]);
        } catch {
          continue; // a line cut short, as a recording can end
        }
      }
    }
    assert.ok(values.length > 500, `${values.length} lines`);
    for (const r of [redactor, createRedactor({ redact: ["secrets", "email"], patterns: ["INTERNAL-[A-Z]+"] })]) {
      for (const [label, v] of values) {
        const want = redactionTally();
        const clean = redactForBlob(r, v, want);
        const expected = typeof clean === "string" ? clean : r.string(JSON.stringify(clean) ?? "", want);
        const got = redactionTally();
        assert.equal(redactBlobValue(r, v, got), expected, label);
        assert.equal(JSON.stringify(got), JSON.stringify(want), label);
      }
    }
  });
});
