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
import { redactPayload, withSpoolRedactions } from "../../src/spool/redact.ts";
import { appendSpool, MAX_INLINE_LINE_BYTES } from "../../src/spool/write.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { PKG_ROOT, tsNodeArgs } from "../capture/_helpers.ts";

// Vendor-shaped values, joined at run time so the source holds no key-shaped literal.
const GITHUB = ["gh", "p_", "R4nd0mT0k3nV4lu3xQ9zLm2Wp8Ks5Yt7Hc1D"].join("");
const ANTHROPIC = ["sk-", "ant-", "api03-", "Zx8Qw2Lm4Np6Rt8Vb0Cd2Ef4Gh6Jk8"].join("");
const AWS = ["AK", "IA", "Q3ZT7XW2LMNB4KRP"].join("");
/** Only redacted inside its JSON document: in the document's text the name follows the `n` of `\n`. */
const HIDDEN = ["Wq7", "Lp2Zr9Kx4Vb8"].join("");
const SECRETS = [GITHUB, ANTHROPIC, AWS, HIDDEN];

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
  // A tool result that is itself JSON text, with an env file in one of its strings.
  const doc = JSON.stringify({ stdout: `loaded\nAPI_TOKEN=${HIDDEN}\n` }, null, 2);
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
      // Ingest alone misses the value hidden in the document's text; the hook finds it and counts it.
      assert.ok((original!.payload.doc as string).includes(HIDDEN));
      assert.deepEqual(stored!.payload.redactions, { ...(original!.payload.redactions as object), "secret-assignment": 1 });
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
    appendSpool({ v: 0, agent: "fake", event: "a", ts: Date.now(), pid: 1, cwd: "/w", raw }, env);
    const [line] = spoolLines(h);
    assert.deepEqual(line!.raw, raw);

    const { h: h2, env: env2 } = home();
    mkdirSync(h2, { recursive: true });
    writeFileSync(join(h2, "config.toml"), `[capture]\nredact = ["secrets", "email"]\n`);
    const mail = ["dev", "@", "example.org"].join("");
    appendSpool({ v: 0, agent: "fake", event: "a", ts: Date.now(), pid: 1, cwd: "/w", raw: { text: `${mail} ${GITHUB}` } }, env2);
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

  it("withSpoolRedactions adds the line's counts to the event's", () => {
    const e: AgentEvent = { id: "e", v: 0, sessionId: "s", ts: 1, agent: "fake", kind: "user.message", payload: { text: "x", redactions: { password: 1 } } };
    assert.deepEqual(withSpoolRedactions(e, { "github-token": 2, password: 1 }).payload.redactions, { "github-token": 2, password: 2 });
    assert.equal(withSpoolRedactions(e, undefined), e);
    assert.equal(withSpoolRedactions(e, {}), e);
  });
});
