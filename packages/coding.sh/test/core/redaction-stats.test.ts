// Secret exposure: redaction tallies per rule, payload.redactions at ingest (inline,
// blob-only, metadata mode, idempotent), Session.stats.redactions and the
// secret:exposed tag, and the marker fallback for events stored before counting.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { createRedactor, isPlaceholderSecret, redactEventCounted, redactionTally, toMetadata } from "../../src/core/redact.ts";
import { exposesSecret, SECRET_EXPOSED } from "../../src/core/redaction-stats.ts";
import { buildSession, failureFlags, FLAGS } from "../../src/core/sessions.ts";
import type { Adapter, Config } from "../../src/core/types.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

// Built at runtime so no scanner mistakes this file for a leak.
const ANT = ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-");
const GH = ["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const KEY_PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAx9Kq2Lm8Np4Rt7Vw1Yb3Hd6Gf0Jc5SeU2", "-----END RSA PRIVATE KEY-----"].join("\n");

const r = createRedactor({ redact: ["secrets"] });

describe("redaction tally", () => {
  const tallyOf = (s: string) => {
    const t = redactionTally();
    const out = r.string(s, t);
    return { out, ...t };
  };

  test("counts plain, fastApply and keepPrefix rules", () => {
    assert.deepEqual(tallyOf(`key ${ANT} and ${ANT}`).kinds, { "anthropic-key": 2 });
    assert.deepEqual(tallyOf(KEY_PEM).kinds, { "private-key": 1 });
    assert.deepEqual(tallyOf("curl -H 'Authorization: Bearer abcdef0123456789abcdef'").kinds, { bearer: 1 });
    assert.deepEqual(tallyOf("the password is hunter22x").kinds, { "prose-secret": 1 });
  });

  test("markers already in the input are not hits", () => {
    const t = tallyOf("coding.sh show printed [redacted:github-token] earlier");
    assert.deepEqual(t.kinds, {});
    assert.equal(t.preexisting, true);
    const both = tallyOf(`[redacted:github-token] then ${GH}`);
    assert.deepEqual(both.kinds, { "github-token": 1 });
  });

  test("secret-named keys and secret flags in argv count", () => {
    const t = redactionTally();
    r.value({ headers: { authorization: "anything at all" }, argv: ["tool", "--api-key", "plainvalue"] }, t);
    assert.deepEqual(t.kinds, { "secret-field": 1, "secret-flag": 1 });
  });

  test("a made-up vendor key is redacted but counted as placeholder-key, so it exposes nothing", () => {
    // The shapes this repo's own tests and docs use, built at runtime like ANT above.
    const fakes = [
      ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
      ["sk", "ant", "api03", "SECRET".repeat(6), "abcdefAA"].join("-"),
      ["sk", "ant", "api03", "FORKKEY".repeat(3), "abcdefAA"].join("-"),
      ["sk", "ant", "api03", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-"),
      ["sk", "ant", "test", "SECRET", "key", "123456"].join("-"),
      ["sk", "ant", "oat01", "stub", "token"].join("-"),
      ["csh", "ik", "a".repeat(43)].join("_"),
      ["ghp_", "0123456789abcdefghijABCDEFGHIJ012345"].join(""),
      ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["-----BEGIN RSA PRIVATE KEY-----", "MIIEow", "IBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n"),
    ];
    for (const f of fakes) {
      const t = tallyOf(`here: ${f} done`);
      assert.doesNotMatch(t.out, new RegExp(f.slice(0, 12).replace(/[-]/g, "\\-")), `still redacted: ${f}`);
      assert.deepEqual(t.kinds, { "placeholder-key": 1 }, f);
      assert.equal(exposesSecret(t.kinds), false, f);
    }
    // Random-looking keys, as live ones are, keep their vendor kind.
    for (const [real, kind] of [[ANT, "anthropic-key"], [GH, "github-token"], [["AKIA", "Q3ZJ7HXW2LKD9PNR"].join(""), "aws-access-key"], [["sk", "live", "51Hq8ZbLx2Mw9Kt4Rv7Pn3Jd"].join("_"), "stripe-key"], [KEY_PEM, "private-key"]]) {
      assert.deepEqual(tallyOf(`x ${real} y`).kinds, { [kind!]: 1 }, real);
      assert.equal(isPlaceholderSecret(real!), false, real);
    }
  });

  test("no tally, no change in output", () => {
    assert.equal(r.string(`x ${ANT}`), r.string(`x ${ANT}`, redactionTally()));
  });
});

describe("redactEventCounted", () => {
  const ev = (payload: Record<string, unknown>, over: Partial<AgentEvent> = {}): AgentEvent => ({ id: "e1", v: 0, sessionId: "s", ts: 1, agent: "fake", kind: "tool.end", payload, ...over });

  test("writes counts, never values", () => {
    const out = redactEventCounted(r, ev({ output: `token ${ANT}` }));
    assert.deepEqual(out.payload.redactions, { "anthropic-key": 1 });
    assert.ok(!JSON.stringify(out).includes(ANT));
  });

  test("nothing redacted: no field; quoted markers only: an empty object", () => {
    assert.equal(redactEventCounted(r, ev({ output: "hello" })).payload.redactions, undefined);
    assert.deepEqual(redactEventCounted(r, ev({ output: "[redacted:openai-key]" })).payload.redactions, {});
  });

  test("re-finishing a stored event keeps its counts", () => {
    const once = redactEventCounted(r, ev({ output: `token ${ANT}` }));
    assert.deepEqual(redactEventCounted(r, once).payload.redactions, { "anthropic-key": 1 });
  });

  test("metadata mode keeps the counts and drops the content", () => {
    const meta = toMetadata(redactEventCounted(r, ev({ output: `token ${ANT}` })));
    assert.deepEqual(meta.payload, { redactions: { "anthropic-key": 1 } });
  });
});

describe("Session.stats.redactions and secret:exposed", () => {
  const e = (n: number, payload: Record<string, unknown>, kind: EventKind = "tool.end"): AgentEvent => ({ id: `e${n}`, v: 0, sessionId: "s", ts: n, agent: "fake", kind, payload });

  test("sums counts and tags vendor tokens", () => {
    const s = buildSession([e(1, { redactions: { "anthropic-key": 1 } }), e(2, { redactions: { "anthropic-key": 1, password: 2 } }), e(3, { text: "hi" }, "user.message")]);
    assert.deepEqual(s.stats.redactions, { "anthropic-key": 2, password: 2 });
    assert.ok(s.flags.includes(SECRET_EXPOSED));
    assert.equal(FLAGS.secretExposed, "secret:exposed");
  });

  test("heuristic kinds raise stats only", () => {
    const s = buildSession([e(1, { redactions: { "prose-secret": 1 } })]);
    assert.deepEqual(s.stats.redactions, { "prose-secret": 1 });
    assert.ok(!s.flags.includes(SECRET_EXPOSED));
  });

  test("legacy events: markers in the payload are counted", () => {
    const s = buildSession([e(1, { output: "x [redacted:github-token] y [redacted:password]" }), e(2, { input: { command: "echo [redacted:github-token]" } }, "tool.start")]);
    assert.deepEqual(s.stats.redactions, { "github-token": 2, password: 1 });
    assert.ok(s.flags.includes(SECRET_EXPOSED));
  });

  test("an empty payload.redactions means the markers were quoted, not hits", () => {
    const s = buildSession([e(1, { output: "[redacted:github-token]", redactions: {} })]);
    assert.equal(s.stats.redactions, undefined);
    assert.deepEqual(s.flags, []);
  });

  test("absent when nothing was redacted; deterministic; a tag, not a failure", () => {
    const events = [e(1, { redactions: { "github-token": 1 } })];
    assert.equal(buildSession([e(1, { output: "fine" })]).stats.redactions, undefined);
    assert.deepEqual(buildSession(events), buildSession(events));
    assert.deepEqual(failureFlags([SECRET_EXPOSED]), []);
    assert.equal(exposesSecret(undefined), false);
  });
});

describe("ingest records payload.redactions", () => {
  const roots: string[] = [];
  after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // raw = { session, kind, blob?, ...payload } → one event, with `blob` offloaded.
  const fake: Adapter = {
    id: "fake",
    displayName: "Fake",
    tier: "A",
    detect: async () => ({ installed: true, hooked: true }),
    install: async () => [],
    uninstall: async () => [],
    async normalize(line, ctx) {
      const { session, kind, blob, ...payload } = line.raw as Record<string, unknown>;
      const ev: AgentEvent = { id: ctx.id(String(session), line.ts), v: 0, sessionId: String(session), ts: line.ts, agent: "fake", kind: (kind as EventKind) ?? "tool.end", payload };
      if (typeof blob === "string") ev.blobs = [await ctx.blob(blob)];
      return [ev];
    },
  };

  async function run(lines: Record<string, unknown>[], capture: Partial<Config["capture"]> = {}) {
    const root = mkdtempSync(join(tmpdir(), "csh-redcount-"));
    roots.push(root);
    const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
    const config = defaultConfig(env);
    Object.assign(config.capture, capture);
    const dir = join(env.CODING_SH_HOME, "spool", "fake");
    mkdirSync(dir, { recursive: true });
    let ts = 1_700_000_000_000;
    appendFileSync(join(dir, "2026-11-06.1.jsonl"), lines.map((raw) => JSON.stringify({ v: 0, agent: "fake", event: "E", ts: (ts += 1000), pid: 1, cwd: join(root, "work"), raw }) + "\n").join(""));
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const o = { config, index, blobs, sinks: [], env, spoolDir: join(env.CODING_SH_HOME, "spool"), adapters: new Map([["fake", fake]]) };
    await ingest(o);
    return { index, blobs, again: () => ingest(o) };
  }

  test("inline: counted and tagged; the secret is stored nowhere", async () => {
    const { index, blobs } = await run([{ session: "s1", output: `here ${ANT}` }]);
    const [stored] = await index.listEvents("s1");
    assert.deepEqual(stored!.payload.redactions, { "anthropic-key": 1 });
    const s = await index.getSession("s1");
    assert.deepEqual(s!.stats.redactions, { "anthropic-key": 1 });
    assert.ok(s!.flags.includes(SECRET_EXPOSED));
    assert.ok(!JSON.stringify(await index.listEvents("s1")).includes(ANT));
    assert.ok(!JSON.stringify(s).includes(ANT));
    for (const ref of stored!.blobs ?? []) assert.ok(!String(await blobs.get(ref)).includes(ANT));
  });

  test("a key only in an offloaded blob is still counted", async () => {
    const { index } = await run([{ session: "s2", output: "(see blob)", blob: `long output\n${GH}\n` }]);
    const [stored] = await index.listEvents("s2");
    assert.deepEqual(stored!.payload.redactions, { "github-token": 1 });
    assert.ok((await index.getSession("s2"))!.flags.includes(SECRET_EXPOSED));
  });

  test("password-like values count without the tag", async () => {
    const { index } = await run([{ session: "s3", kind: "user.message", text: "the password is hunter22x" }]);
    const s = await index.getSession("s3");
    assert.deepEqual(s!.stats.redactions, { "prose-secret": 1 });
    assert.ok(!s!.flags.includes(SECRET_EXPOSED));
  });

  test("metadata mode keeps the counts", async () => {
    const { index } = await run([{ session: "s4", output: `here ${ANT}` }], { mode: "metadata" });
    const s = await index.getSession("s4");
    assert.deepEqual(s!.stats.redactions, { "anthropic-key": 1 });
  });

  test("ingesting again does not double the counts", async () => {
    const { index, again } = await run([{ session: "s5", output: `${ANT} ${GH}` }]);
    await again();
    assert.deepEqual((await index.getSession("s5"))!.stats.redactions, { "anthropic-key": 1, "github-token": 1 });
  });
});
