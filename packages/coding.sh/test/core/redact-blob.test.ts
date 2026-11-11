import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rawBlob as sharedRawBlob } from "../../src/adapters/_shared/normalize.ts";
import { rawBlob as moreRawBlob } from "../../src/adapters/more/_util.ts";
import type { Config } from "../../src/core/config.ts";
import { normalizeContext } from "../../src/core/ingest.ts";
import { createRedactor, redactForBlob, redactionTally } from "../../src/core/redact.ts";

// Built from parts so no secret-looking literal sits in the source.
const SECRET = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"].join("");

const redactor = createRedactor({ redact: ["secrets"] });
const config = { capture: { maxInlineBytes: 1000 } } as unknown as Config;

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
