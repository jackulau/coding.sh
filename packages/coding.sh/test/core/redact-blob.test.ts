import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rawBlob as sharedRawBlob } from "../../src/adapters/_shared/normalize.ts";
import { rawBlob as moreRawBlob } from "../../src/adapters/more/_util.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { normalizeContext } from "../../src/core/ingest.ts";
import { createRedactor, redactBlobValue, redactForBlob, redactionTally, SECRET_NEEDLES } from "../../src/core/redact.ts";

// Built from parts so no secret-looking literal sits in the source.
const SECRET = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"].join("");

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
