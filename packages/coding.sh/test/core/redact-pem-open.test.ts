// A private key whose END line is missing (cut off by a clip, a truncated paste or a log line
// limit) is redacted from its BEGIN line to the end of the text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor, redactEventCounted } from "../../src/core/redact.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" + "a1B2c3D4".repeat(40);
const r = createRedactor({ redact: ["secrets"] });

describe("a private key with no END line", () => {
  for (const header of ["-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----"]) {
    it(`${header} is redacted to the end`, () => {
      const out = r.string(`cat key.pem\n${header}\n${BODY.slice(0, 200)}`);
      assert.equal(out, "cat key.pem\n[redacted:private-key]");
    });
  }
  it("after a complete key, the open one is redacted too", () => {
    const whole = `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----`;
    const out = r.string(`${whole}\nnext: -----BEGIN EC PRIVATE KEY-----\n${BODY}`);
    assert.equal(out, "[redacted:private-key]\nnext: [redacted:private-key]");
  });
  it("a stray END line before an open BEGIN does not keep it", () => {
    assert.equal(r.string(`-----END PRIVATE KEY----- x -----BEGIN PRIVATE KEY-----\n${BODY}`), "-----END PRIVATE KEY----- x [redacted:private-key]");
  });
  it("text with no BEGIN line is unchanged", () => {
    const s = `a public key: -----BEGIN PUBLIC KEY-----\n${BODY}\n and -----END PRIVATE KEY-----`;
    assert.equal(r.string(s), s);
  });
  it("a clipped tool output counts the hit", () => {
    const e: AgentEvent = { id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "tool.end", payload: { output: `-----BEGIN PRIVATE KEY-----\n${BODY.slice(0, 300)}…` } };
    const out = redactEventCounted(r, e);
    assert.ok(!JSON.stringify(out).includes(BODY.slice(0, 40)));
    assert.deepEqual((out.payload as { redactions?: object }).redactions, { "private-key": 1 });
  });
  it("a clip inside the END line still redacts the key", () => {
    const out = r.string(`-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIV`);
    assert.equal(out, "[redacted:private-key]");
  });
  it("an encrypted PEM key, whose BEGIN line is followed by headers, is redacted", () => {
    const out = r.string(`-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123\n\n${BODY.slice(0, 100)}`);
    assert.equal(out, "[redacted:private-key]");
  });
  it("a BEGIN line named in prose, with no key data after it, is left alone", () => {
    for (const s of [
      "The file starts with -----BEGIN PRIVATE KEY----- and ends with the END line.",
      "grep -l '-----BEGIN RSA PRIVATE KEY-----' ~/.ssh/*",
      "-----BEGIN PRIVATE KEY-----\n...\n(key elided)",
    ]) {
      assert.equal(r.string(s), s);
      const e: AgentEvent = { id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "tool.end", payload: { output: s } };
      assert.equal((redactEventCounted(r, e).payload as { redactions?: object }).redactions, undefined, "nothing is counted");
    }
  });
  it("many open BEGIN lines stay linear", () => {
    const prose = "-----BEGIN PRIVATE KEY-----x".repeat(40_000);
    let t = performance.now();
    assert.equal(r.string(prose), prose);
    assert.ok(performance.now() - t < 500, `${Math.round(performance.now() - t)} ms`);
    t = performance.now();
    assert.equal(r.string(`${prose}-----BEGIN PRIVATE KEY-----\n${BODY}`), `${prose}[redacted:private-key]`);
    assert.ok(performance.now() - t < 500, `${Math.round(performance.now() - t)} ms`);
  });
});
