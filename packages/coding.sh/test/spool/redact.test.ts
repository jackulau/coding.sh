// The hook redacts a payload before it writes it: no secret the rules know is in
// any spool file, inline or in a side file, and ingest stores the same event
// (redaction counts included) as it does from the original payload.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { Adapter, SpoolLine } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { createRedactor, redactionTally } from "../../src/core/redact.ts";
import { redactPayload, spoolLineRedactor, withSpoolRedactions } from "../../src/spool/redact.ts";
import { appendSpool, MAX_INLINE_LINE_BYTES } from "../../src/spool/write.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { PKG_ROOT, tsNodeArgs } from "../capture/_helpers.ts";

// Vendor-shaped values, joined at run time so the source holds no key-shaped literal.
const GITHUB = ["gh", "p_", "R4nd0mT0k3nV4lu3xQ9zLm2Wp8Ks5Yt7Hc1D"].join("");
const ANTHROPIC = ["sk-", "ant-", "api03-", "Zx8Qw2Lm4Np6Rt8Vb0Cd2Ef4Gh6Jk8"].join("");
const AWS = ["AK", "IA", "Q3ZT7XW2LMNB4KRP"].join("");
/** In an env file in a JSON document: in the document's text its name follows the escape `\n`. */
const HIDDEN = ["Wq7", "Lp2Zr9Kx4Vb8"].join("");
const SECRETS = [GITHUB, ANTHROPIC, AWS, HIDDEN];
const BS = String.fromCharCode(92);

/** appendSpool's options with the redaction rules of the env's config. */
const R = (env: NodeJS.ProcessEnv) => ({ redact: spoolLineRedactor(env) });

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function home() {
  const root = mkdtempSync(join(tmpdir(), "csh-spoolred-"));
  roots.push(root);
  const h = join(root, "home");
  return { h, env: { CODING_SH_HOME: h, HOME: join(root, "user"), USERPROFILE: join(root, "user"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv };
}

/** Every file under `dir` whose bytes hold one of `needles`. */
function holding(dir: string, needles: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    const bytes = readFileSync(p);
    if (needles.some((n) => bytes.includes(n))) out.push(p);
  }
  return out;
}

/** raw = { session, text, doc } → one user.message with the same fields. */
const fake: Adapter = {
  id: "fake",
  displayName: "Fake",
  tier: "A",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    const raw = line.raw as { session: string; text: string; doc: string };
    const e: AgentEvent = { id: ctx.id(line.agent, raw.session, line.event), v: 0, sessionId: raw.session, ts: 1, agent: line.agent, kind: "user.message", cwd: line.cwd, payload: { text: raw.text, doc: raw.doc } };
    return [e];
  },
};
const adapters = new Map([["fake", fake]]);

function payload(session: string, pad: number): string {
  // A tool result that is itself JSON text, with an env file in one of its strings: in the text,
  // the name follows the escape `\n`. Only secret-assignment knows the name CREDENTIALS.
  const doc = JSON.stringify({ stdout: `loaded\nGOOGLE_CREDENTIALS=${HIDDEN}\n` }, null, 2);
  return JSON.stringify({ session, cwd: "/w", text: `token ${GITHUB} key ${ANTHROPIC} id ${AWS} ${"y".repeat(pad)}`, doc });
}

function runHook(env: NodeJS.ProcessEnv, input: string) {
  const r = spawnSync(process.execPath, [...tsNodeArgs(), join(PKG_ROOT, "src", "spool", "hook.ts"), "fake", "UserPromptSubmit"], { input, env: { ...env, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
}

function spoolLines(h: string): SpoolLine[] {
  const dir = join(h, "spool", "fake");
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SpoolLine));
}

/** The events ingest stores from the original payload, written to the spool as it was before the hook redacted. */
async function storedFromOriginal(text: string, session: string): Promise<AgentEvent[]> {
  const { h, env } = home();
  const dir = join(h, "spool", "fake");
  mkdirSync(dir, { recursive: true });
  const line: SpoolLine = { v: 0, agent: "fake", event: "UserPromptSubmit", ts: Date.now(), pid: 1, cwd: "/w", raw: JSON.parse(text) };
  writeFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(line) + "\n");
  const index = new MemoryIndexStore();
  const res = await ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters, env, lock: false });
  assert.deepEqual(res.errors, []);
  return index.listEvents(session);
}

describe("the hook redacts before it writes", () => {
  for (const [name, pad, side] of [
    ["an inline line", 0, false],
    ["a side file", 20_000, true],
  ] as const) {
    it(`${name}: no spool file holds a secret, and ingest stores the redacted event once, as it does from the original`, async () => {
      const { h, env } = home();
      const text = payload(`s-${pad}`, pad);
      assert.equal(Buffer.byteLength(text) > MAX_INLINE_LINE_BYTES, side);
      runHook(env, text);
      assert.deepEqual(holding(h, SECRETS), []);
      const [line, ...rest] = spoolLines(h);
      assert.deepEqual(rest, []);
      assert.equal(!!line!.rawFile, side);
      assert.deepEqual(line!.redactions, { "anthropic-key": 1, "aws-access-key": 1, "github-token": 1, "secret-assignment": 1 });

      const index = new MemoryIndexStore();
      const opts = { config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters, env, lock: false as const };
      const res = await ingest(opts);
      assert.deepEqual([res.errors, res.events], [[], 1]);
      const [stored] = await index.listEvents(`s-${pad}`);
      assert.match(stored!.payload.text as string, /^token \[redacted:github-token\] key \[redacted:anthropic-key\] id \[redacted:aws-access-key\] y*$/);
      assert.ok(!SECRETS.some((s) => JSON.stringify(stored).includes(s)));
      const [original] = await storedFromOriginal(text, `s-${pad}`);
      assert.deepEqual(stored!.payload.text, original!.payload.text);
      // The name follows the escape `\n`: ingest alone finds it too.
      assert.deepEqual(stored!.payload.doc, original!.payload.doc);
      assert.deepEqual(stored!.payload.redactions, original!.payload.redactions);
      const again = await ingest(opts);
      assert.deepEqual([again.lines, again.events, again.errors], [0, 0, []]);
      assert.deepEqual(holding(h, SECRETS), []);
    });
  }

  it("a payload with nothing to redact is written as it came", () => {
    const { h, env } = home();
    const small = JSON.stringify({ session: "plain", cwd: "/w", text: "hello" });
    const big = JSON.stringify({ session: "plain", cwd: "/w", text: "z".repeat(5000) }, null, 1);
    runHook(env, small);
    runHook(env, big);
    const [a, b] = spoolLines(h);
    assert.deepEqual(a!.raw, JSON.parse(small));
    assert.equal(a!.redactions, undefined);
    assert.equal(readFileSync(b!.rawFile!, "utf8"), big);
    assert.equal(b!.redactions, undefined);
  });

  it("follows capture.redact in the user's config", () => {
    const { h, env } = home();
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "config.toml"), `[capture]\nredact = ["none"]\n`);
    const raw = { text: `token ${GITHUB}` };
    appendSpool({ v: 0, agent: "fake", event: "a", ts: Date.now(), pid: 1, cwd: "/w", raw }, env, R(env));
    const [line] = spoolLines(h);
    assert.deepEqual(line!.raw, raw);

    const { h: h2, env: env2 } = home();
    mkdirSync(h2, { recursive: true });
    writeFileSync(join(h2, "config.toml"), `[capture]\nredact = ["secrets", "email"]\n`);
    const mail = ["dev", "@", "example.org"].join("");
    appendSpool({ v: 0, agent: "fake", event: "a", ts: Date.now(), pid: 1, cwd: "/w", raw: { text: `${mail} ${GITHUB}` } }, env2, R(env2));
    const [line2] = spoolLines(h2);
    assert.deepEqual(line2!.raw, { text: "[redacted:email] [redacted:github-token]" });
    assert.deepEqual(line2!.redactions, { email: 1, "github-token": 1 });
  });

  it("redactPayload keeps a document's text when its strings had everything to redact", () => {
    const r = createRedactor();
    const doc = JSON.stringify({ out: `key ${GITHUB}` }, null, 2);
    const tally = redactionTally();
    const clean = redactPayload(r, { doc }, tally) as { doc: string };
    assert.equal(clean.doc, doc.replace(GITHUB, "[redacted:github-token]"));
    assert.deepEqual(tally.kinds, { "github-token": 1 });
    const plain = { a: ["b", { c: "d" }] };
    assert.deepEqual(redactPayload(r, plain, redactionTally()), plain);
  });

  it("redactPayload redacts a document inside a document next to a value the rules replace, and counts each value once", () => {
    const r = createRedactor();
    // The password is too short for the text rules: only its key in the inner document shows it
    // is secret. In the outer document's text, the log's value runs to the backslash of the
    // escaped quote after it; the rule keeps that escape whole, so the text still parses.
    const inner = JSON.stringify({ password: "hunter", log: `the password is ${HIDDEN}` });
    const tally = redactionTally();
    const clean = redactPayload(r, { tool_response: { stdout: JSON.stringify({ content: inner }) } }, tally) as { tool_response: { stdout: string } };
    const doc: unknown = JSON.parse((JSON.parse(clean.tool_response.stdout) as { content: string }).content);
    assert.deepEqual(doc, { password: "[redacted:secret-field]", log: "the password is [redacted:prose-secret]" });
    assert.deepEqual(tally.kinds, { "secret-field": 1, "prose-secret": 1 });
  });

  it("redactPayload redacts a document as documents when a match in its text runs past one of its strings", () => {
    const r = createRedactor();
    // With its data on the BEGIN line and no END line, a private key runs to the end of the
    // text, past the end of the string that holds it: the document's text no longer parses.
    const pem = ["-----BEGIN RSA PRI", "VATE KEY----- ", "Zx8Qw2Lm4Np6Rt8Vb0Cd2Ef4Gh6Jk8Mn1Pq3Rs5Tu7Vw9Xy"].join("");
    const tally = redactionTally();
    const clean = redactPayload(r, { stdout: JSON.stringify({ key: pem, note: "kept" }) }, tally) as { stdout: string };
    assert.deepEqual(JSON.parse(clean.stdout), { key: "[redacted:private-key]", note: "kept" });
    assert.deepEqual(tally.kinds, { "private-key": 1 });
  });

  it("redactPayload finds a key right after an escape in JSON text", () => {
    const tally = redactionTally();
    const out = redactPayload(createRedactor(), { prompt: `see {"msg":"a${BS}n${ANTHROPIC}"}` }, tally);
    assert.deepEqual(out, { prompt: `see {"msg":"a${BS}n[redacted:anthropic-key]"}` });
    assert.deepEqual(tally.kinds, { "anthropic-key": 1 });
  });

  it("redactPayload redacts a value as its document does when a match in the text stops at an escape inside it", () => {
    // In the text, the token after `Token` ends at the backslash of `\u00e9`; in the document the
    // string holds é, and the whole value is one token.
    const tally = redactionTally();
    const body = `{"m":"a${BS}nAuthorization: Token abcd1234${BS}u00e9efgh5678"}`;
    const out = redactPayload(createRedactor(), { body }, tally) as { body: string };
    assert.equal(out.body, `{"m":"a${BS}nAuthorization: Token [redacted:auth-header]"}`);
    assert.deepEqual(tally.kinds, { "auth-header": 1 });
  });

  it("redactPayload gives the text and counts of a redactor that shares no work between strings", () => {
    const r = createRedactor();
    // redactForBlob shares each string's result only for a redactor createRedactor made, not a copy.
    const unshared = { ...r };
    const doc = JSON.stringify({ a: `key ${GITHUB}`, b: [`key ${GITHUB}`, `key ${GITHUB}`], c: JSON.stringify({ password: "hunter", d: `key ${GITHUB}` }) });
    const pem = ["-----BEGIN RSA PRI", "VATE KEY----- ", "Zx8Qw2Lm4Np6Rt8Vb0Cd2Ef4Gh6Jk8Mn1Pq3Rs5Tu7Vw9Xy"].join("");
    const body = `{"m":"a${BS}nAuthorization: Token abcd1234${BS}u00e9efgh5678","n":"key ${GITHUB}","o":"key ${GITHUB}"}`;
    const payloads: unknown[] = [
      // The text's result is kept.
      { stdout: doc, again: doc, prompt: `{"msg":"a${BS}n${ANTHROPIC}","m2":"a${BS}n${ANTHROPIC}"}` },
      // The text no longer parses as many documents: the original is redacted as documents.
      { stdout: JSON.stringify({ key: pem, note: `key ${GITHUB}`, more: `key ${GITHUB}` }) },
      // The text shows more than the original redacted as documents.
      { body, again: body },
      `{"a":"[redacted:email] ${GITHUB}","b":"[redacted:email] ${GITHUB}"}`,
    ];
    for (const p of payloads) {
      const shared = redactionTally();
      const alone = redactionTally();
      const label = JSON.stringify(p).slice(0, 80);
      assert.equal(JSON.stringify(redactPayload(r, p, shared)), JSON.stringify(redactPayload(unshared, p, alone)), label);
      assert.equal(JSON.stringify(shared), JSON.stringify(alone), label);
    }
  });

  it("redactPayload redacts with the rules it is given after a call that had other rules", () => {
    // In the payload's text the control character is written as an escape, so only the
    // document's string matches the pattern. The word is in no other test.
    const word = ["zq", "purple", "monkey"].join("");
    const ctl = String.fromCharCode(1);
    const input = () => ({ tool_name: "Bash", tool_response: { stdout: JSON.stringify({ msg: `x${ctl}${word}` }) } });
    redactPayload(createRedactor({ env: {} }), input(), redactionTally());
    const tally = redactionTally();
    const out = JSON.stringify(redactPayload(createRedactor({ env: {}, patterns: [`${ctl}zq[a-z]+`] }), input(), tally));
    assert.ok(!out.includes(word), out);
    assert.ok(out.includes("[redacted:pattern]"), out);
    assert.deepEqual(tally.kinds, { pattern: 1 });
  });

  it("withSpoolRedactions adds the line's counts to the event's", () => {
    const e: AgentEvent = { id: "e", v: 0, sessionId: "s", ts: 1, agent: "fake", kind: "user.message", payload: { text: "x", redactions: { password: 1 } } };
    assert.deepEqual(withSpoolRedactions(e, { "github-token": 2, password: 1 }).payload.redactions, { "github-token": 2, password: 2 });
    assert.equal(withSpoolRedactions(e, undefined), e);
    assert.equal(withSpoolRedactions(e, {}), e);
  });
});
