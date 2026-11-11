// A secret in a hook payload does not stay in the spool once ingest has stored
// its line: a long payload goes to a raw/ side file that ingest rewrites redacted,
// and a short inline one is redacted in place once its day has passed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { Adapter, SpoolLine } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { scrubSpoolFile } from "../../src/core/spool-scrub.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { PKG_ROOT, removeTmp, tmp, tsNodeArgs } from "./_helpers.ts";

const CANARY = ["gh", "p_", "R4nd0mT0k3nV4lu3xQ9zLm2Wp8Ks5Yt7Hc1D"].join("");

/** raw = { session, text } → one user.message. */
const fake: Adapter = {
  id: "fake",
  displayName: "Fake",
  tier: "A",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    const raw = line.raw as { session: string; text: string };
    const e: AgentEvent = { id: ctx.id(line.agent, raw.session, line.ts, line.event), v: 0, sessionId: raw.session, ts: line.ts, agent: line.agent, kind: "user.message", cwd: line.cwd, payload: { text: raw.text } };
    return [e];
  },
};
const adapters = new Map([["fake", fake]]);

/** Every file under `dir` whose bytes hold `needle`. */
function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    if (readFileSync(p).includes(needle)) out.push(p);
  }
  return out;
}

let HOOK_SH = "";
before(() => {
  HOOK_SH = join(tmp("csh-secretsbin-"), "hook.sh");
  copyFileSync(join(PKG_ROOT, "src", "spool", "hook.sh"), HOOK_SH);
});
after(() => removeTmp());

function home() {
  const h = join(tmp("csh-secrets-"), "home");
  return { h, env: { CODING_SH_HOME: h, HOME: join(h, "..", "user"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv };
}

describe("secrets in the spool", () => {
  test("the canary is a secret the default rules redact", () => {
    assert.equal(createRedactor().string(CANARY), "[redacted:github-token]");
  });

  test("a 20 KB payload through hook.mjs goes to a side file, and no file holds the secret after ingest", () => {
    const { h, env } = home();
    const payload = JSON.stringify({ session: "long", cwd: "/w", text: `token ${CANARY} ${"x".repeat(20_000)}` });
    const r = spawnSync(process.execPath, [...tsNodeArgs(), join(PKG_ROOT, "src", "spool", "hook.ts"), "fake", "UserPromptSubmit"], { input: payload, env: { ...env, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    const dir = join(h, "spool", "fake");
    const [line] = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SpoolLine);
    assert.ok(line?.rawFile, "the payload is in a side file");
    return ingest({ config: defaultConfig(env), index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), adapters, env, lock: false }).then((res) => {
      assert.deepEqual(res.errors, []);
      assert.equal(res.events, 1);
      assert.deepEqual(holding(h, CANARY), []);
    });
  });

  test("a 300-byte payload through hook.sh is redacted in place once its day has passed; cursors and offsets still hold", { skip: process.platform === "win32" && "no hook.sh on Windows" }, async () => {
    const { h, env } = home();
    const payload = JSON.stringify({ session: "short", cwd: "/w", text: `token ${CANARY} ${"y".repeat(200)}` });
    assert.ok(payload.length > 250 && payload.length < 320);
    const r = spawnSync("/bin/sh", [HOOK_SH, "fake", "UserPromptSubmit"], { input: payload, env: { PATH: "/usr/bin:/bin", CODING_SH_HOME: h }, encoding: "utf8" });
    assert.equal(r.status, 0);
    const dir = join(h, "spool", "fake");
    const [name] = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    // A second line after it, so the rewrite must keep the first line's length.
    const r2 = spawnSync("/bin/sh", [HOOK_SH, "fake", "Stop"], { input: JSON.stringify({ session: "short", cwd: "/w", text: "done" }), env: { PATH: "/usr/bin:/bin", CODING_SH_HOME: h, CODING_SH_NO_AUTO_INGEST: "1" }, encoding: "utf8" });
    assert.equal(r2.status, 0);
    // The day has passed: the file is as the hook left it, under a past day's name.
    const past = join(dir, "2026-01-01.jsonl");
    renameSync(join(dir, name!), past);
    const old = new Date("2026-01-01T12:00:00Z");
    utimesSync(past, old, old);
    const size = statSync(past).size;
    assert.equal(holding(h, CANARY).length, 1, "the hook wrote it inline");

    const index = new MemoryIndexStore();
    const res = await ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters, env, lock: false });
    assert.deepEqual(res.errors, []);
    assert.equal(res.events, 2);
    assert.deepEqual(holding(h, CANARY), []);
    // Same size and mtime, every line still parses, the cursor is at the end, a second run reads nothing.
    assert.equal(statSync(past).size, size);
    assert.equal(statSync(past).mtimeMs, old.getTime());
    const lines = readFileSync(past, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SpoolLine);
    assert.deepEqual(lines.map((l) => l.event), ["UserPromptSubmit", "Stop"]);
    assert.match((lines[0]!.raw as { text: string }).text, /^token \[redacted:github-token\] y+$/);
    assert.equal(await index.getCursor("fake/2026-01-01.jsonl"), size);
    const again = await ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters, env, lock: false });
    assert.deepEqual([again.lines, again.events, again.errors], [0, 0, []]);
  });

  test("today's file is left as written until its day has passed", { skip: process.platform === "win32" && "no hook.sh on Windows" }, async () => {
    const { h, env } = home();
    const r = spawnSync("/bin/sh", [HOOK_SH, "fake", "UserPromptSubmit"], { input: JSON.stringify({ session: "today", cwd: "/w", text: `token ${CANARY}` }), env: { PATH: "/usr/bin:/bin", CODING_SH_HOME: h }, encoding: "utf8" });
    assert.equal(r.status, 0);
    await ingest({ config: defaultConfig(env), index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), adapters, env, lock: false });
    assert.equal(holding(h, CANARY).length, 1);
  });

  test("a redacted line that would grow moves its payload to a side file; a bad line holding a secret becomes spaces", async () => {
    const { h } = home();
    const dir = join(h, "spool", "fake");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-01-02.jsonl");
    // An address shorter than its marker: the redacted line cannot keep its length inline.
    const short = ["a", "@", "b.co"].join("");
    const grow: SpoolLine = { v: 0, agent: "fake", event: "a", ts: 1, pid: 1, cwd: "/w", raw: { t: short, pad: "z".repeat(60) } };
    const torn = `{"v":0,"agent":"fake","event":"b","raw":{"t":"${CANARY}`;
    const keep: SpoolLine = { v: 0, agent: "fake", event: "c", ts: 3, pid: 1, cwd: "/w", raw: { t: "fine" } };
    const text = `${JSON.stringify(grow)}\n${torn}\n${JSON.stringify(keep)}\n`;
    writeFileSync(file, text);
    const redactor = createRedactor({ redact: ["secrets", "email"] });
    assert.ok(Buffer.byteLength(JSON.stringify({ ...grow, raw: { ...grow.raw as object, t: redactor.string(short) } })) > Buffer.byteLength(JSON.stringify(grow)), "the marker is longer than the token");
    assert.equal(await scrubSpoolFile(join(h, "spool"), file, () => redactor), 2);
    const after = readFileSync(file, "utf8");
    assert.equal(after.length, text.length);
    const [a, b, c] = after.split("\n");
    const moved = JSON.parse(a!) as SpoolLine;
    assert.equal(moved.raw, undefined);
    assert.match(moved.rawFile!, /^raw\/1-scrub-[a-z0-9]+\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, moved.rawFile!), "utf8")), { t: "[redacted:email]", pad: "z".repeat(60) });
    assert.equal(b!.trim(), "");
    assert.equal(c, JSON.stringify(keep));
    assert.deepEqual(holding(h, short), []);
    assert.deepEqual(holding(h, CANARY), []);
  });
});
