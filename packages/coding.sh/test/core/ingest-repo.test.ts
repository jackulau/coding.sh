// Ingest/backfill regressions that need real git repos: repo state for hook and
// transcript sessions, end snapshots, and incremental backfill.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import type { Adapter, BackfillOpts, Config } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, backfillCursorKey, END_SNAPSHOT_MAX_AGE_MS, ingest } from "../../src/core/ingest.ts";
import { diffSnapshots } from "../../src/core/snapshot.ts";
import { draftTaskFromSession } from "../../src/eval/task.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { gitc, isolate, makeRepo, removeTmp, tmp, write } from "../capture/_helpers.ts";

before(() => isolate());
after(() => removeTmp());

const stub = {
  displayName: "Fake",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
};

/** Hook-style adapter: raw = { session, kind, text? } → one event at the line's ts and cwd. */
const hookAdapter: Adapter = {
  ...stub,
  id: "fake",
  tier: "A",
  async normalize(line, ctx) {
    const { session, kind, ...payload } = line.raw as Record<string, unknown>;
    return [{ id: ctx.id(line.agent, String(session), line.ts, String(kind)), v: 0, sessionId: String(session), ts: line.ts, agent: line.agent, kind: kind as EventKind, cwd: line.cwd, payload }];
  },
};

/** The isolated CODING_SH_HOME (shadow repos live there: eval drafting reads them via process.env) and a fresh spool. */
function env(): { env: NodeJS.ProcessEnv; config: Config; spool: string; spoolDir: string } {
  const spoolDir = tmp("csh-spool-");
  const e = { ...process.env, HOME: join(spoolDir, "user"), CODING_SH_NO_AUTO_INGEST: "1" };
  const spool = join(spoolDir, "fake");
  mkdirSync(spool, { recursive: true });
  return { env: e, config: defaultConfig(e), spool, spoolDir };
}

const spoolLine = (ts: number, cwd: string, raw: Record<string, unknown>) =>
  JSON.stringify({ v: 0, agent: "fake", event: String(raw.kind), ts, pid: 1, cwd, raw }) + "\n";

describe("hook-captured sessions get repo state (QA P0: eval new on hook sessions)", () => {
  it("records a HEAD-only start state and snapshots the tree at a fresh end of turn", async () => {
    const root = makeRepo({ "sum.js": "module.exports = (a, b) => a - b;\n", "package.json": "{}\n" });
    const headSha = gitc(root, "rev-parse", "HEAD");
    const { env: e, config, spool, spoolDir } = env();
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const t0 = Date.now() + 2000; // after the commit's reflog entry
    const file = join(spool, "s.jsonl");
    writeFileSync(file, spoolLine(t0, root, { session: "s1", kind: "session.start" }) + spoolLine(t0 + 10, root, { session: "s1", kind: "user.message", text: "fix sum" }));
    const adapters = new Map([["fake", hookAdapter]]);
    let now = t0 + 100;
    const run = () => ingest({ config, index, blobs, adapters, env: e, spoolDir, lock: false, now: () => now });

    await run();
    let s = (await index.getSession("s1"))!;
    assert.deepEqual(s.repo, { root, head: headSha, branch: "main" });
    assert.equal(s.endSnapshot, undefined, "no end of turn yet");

    // The agent edits the file, then the turn ends (Stop) and the hook kicks an ingest.
    write(root, { "sum.js": "module.exports = (a, b) => a + b;\n" });
    appendFileSync(file, spoolLine(t0 + 5000, root, { session: "s1", kind: "turn.end" }));
    now = t0 + 6000;
    const r = await run();
    assert.deepEqual(r.errors, []);
    s = (await index.getSession("s1"))!;
    assert.deepEqual(s.repo, { root, head: headSha, branch: "main" }, "start state is kept");
    assert.ok(s.endSnapshot, "fresh turn.end gets an end snapshot");
    const d = await diffSnapshots(root, headSha, s.endSnapshot, e);
    assert.deepEqual(d.files.map((f) => f.path), ["sum.js"]);
    assert.match(d.patch, /\+module\.exports = \(a, b\) => a \+ b;/);

    // The main loop: session → eval task.
    const task = await draftTaskFromSession({ index, blobs, sessionId: "s1", verifierCommand: "node -e 1" });
    assert.equal(task.start.repoRoot, root);
    assert.equal(task.start.snapshot, headSha);
    assert.ok(task.referencePatch, "reference patch from start HEAD to the end snapshot");
  });

  it("takes no end snapshot for an end event ingested long after it happened", async () => {
    const root = makeRepo({ "a.txt": "a\n" });
    const { env: e, config, spool, spoolDir } = env();
    const index = new MemoryIndexStore();
    const t0 = Date.now() + 2000;
    writeFileSync(join(spool, "s.jsonl"), spoolLine(t0, root, { session: "s2", kind: "session.start" }) + spoolLine(t0 + 1000, root, { session: "s2", kind: "turn.end" }));
    await ingest({ config, index, blobs: new MemoryBlobStore(), adapters: new Map([["fake", hookAdapter]]), env: e, spoolDir, lock: false, now: () => t0 + 1000 + END_SNAPSHOT_MAX_AGE_MS + 1 });
    const s = (await index.getSession("s2"))!;
    assert.equal(s.repo?.root, root);
    assert.equal(s.endSnapshot, undefined, "the tree has moved on; a later state must not pass as the agent's work");
  });
});

/** File-based backfill adapter over <dir>/*.jsonl; each line { session, kind, ts, cwd?, ...payload }. */
function fileAdapter(dir: string, reads: string[], opts: { gate?: boolean } = {}): Adapter {
  return {
    ...stub,
    id: "fb",
    tier: "B",
    normalize: async () => [],
    async *backfill(ctx, o: BackfillOpts = {}) {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const st = statSync(path);
        if (opts.gate !== false && o.changed && !(await o.changed({ path, size: st.size, mtimeMs: st.mtimeMs }))) continue;
        reads.push(name);
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        for (const [i, l] of lines.entries()) {
          const { session, kind, ts, cwd, ...payload } = JSON.parse(l) as Record<string, unknown>;
          const e: AgentEvent = { id: ctx.id("fb", String(session), i), v: 0, sessionId: String(session), ts: Number(ts), agent: "fb", kind: kind as EventKind, payload };
          if (typeof cwd === "string") e.cwd = cwd;
          if (o.since === undefined || e.ts >= o.since) yield e;
        }
      }
    },
  };
}

const jl = (...recs: Record<string, unknown>[]) => recs.map((r) => JSON.stringify(r) + "\n").join("");

describe("backfill (QA real-traces)", () => {
  it("resolves repo root from cwd and takes the branch from the transcript (P1: sessions --repo)", async () => {
    const root = makeRepo({ "a.txt": "a\n" });
    mkdirSync(join(root, "sub"));
    const headSha = gitc(root, "rev-parse", "HEAD");
    const plain = tmp("csh-plain-");
    const dir = tmp("csh-transcripts-");
    const t = Date.now() + 2000;
    writeFileSync(join(dir, "a.jsonl"), jl(
      { session: "in-repo", kind: "session.start", ts: t, cwd: join(root, "sub"), gitBranch: "feature/x" },
      { session: "in-repo", kind: "user.message", ts: t + 1, cwd: join(root, "sub"), text: "hi" },
    ));
    writeFileSync(join(dir, "b.jsonl"), jl({ session: "no-repo", kind: "user.message", ts: t, cwd: plain, text: "hi" }));
    // Older than the reflog: HEAD at that time is unknown, so none is guessed.
    writeFileSync(join(dir, "c.jsonl"), jl({ session: "old", kind: "user.message", ts: 1_600_000_000_000, cwd: root, text: "hi" }));
    const { env: e, config } = env();
    const index = new MemoryIndexStore();
    const r = await backfill({ config, index, blobs: new MemoryBlobStore(), adapters: [fileAdapter(dir, [])], env: e });
    assert.deepEqual(r.errors, []);
    assert.deepEqual((await index.getSession("in-repo"))!.repo, { root, head: headSha, branch: "feature/x" });
    assert.equal((await index.getSession("no-repo"))!.repo, undefined);
    assert.deepEqual((await index.getSession("old"))!.repo, { root, head: "" });
    assert.deepEqual((await index.listSessions({ repoRoot: root })).map((s) => s.id).sort(), ["in-repo", "old"]);
  });

  it("is incremental: skips unchanged files and recomputes only sessions with new events (P2)", async () => {
    const dir = tmp("csh-transcripts-");
    const a = join(dir, "a.jsonl");
    writeFileSync(a, jl({ session: "A", kind: "user.message", ts: 1000, text: "one" }, { session: "A", kind: "turn.end", ts: 2000 }));
    writeFileSync(join(dir, "b.jsonl"), jl({ session: "B", kind: "user.message", ts: 1000, text: "two" }));
    const { env: e, config } = env();
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const reads: string[] = [];
    const run = (since?: number) => backfill({ config, index, blobs, adapters: [fileAdapter(dir, reads)], env: e, ...(since !== undefined ? { since } : {}) });

    let r = await run(500);
    assert.deepEqual([r.events, r.sessions, reads.splice(0)], [3, 2, ["a.jsonl", "b.jsonl"]]);
    assert.equal(await index.getCursor(backfillCursorKey("fb", a, "size")), statSync(a).size);

    r = await run(600);
    assert.deepEqual([r.events, r.sessions, reads.splice(0)], [0, 0, []], "nothing changed: nothing read, nothing recomputed");

    appendFileSync(a, jl({ session: "A", kind: "user.message", ts: 3000, text: "three" }));
    r = await run(600);
    assert.deepEqual([r.events, r.sessions, reads.splice(0)], [1, 1, ["a.jsonl"]]);
    assert.equal((await index.getSession("A"))!.stats.events, 3);

    r = await run();
    assert.deepEqual(reads.splice(0), ["a.jsonl", "b.jsonl"], "a wider window than the last read re-reads");
    assert.equal(r.sessions, 0, "no new events: no session recomputed");
  });

  it("recomputes sessions of files read for the first time even when their events exist (upgrade path)", async () => {
    const root = makeRepo({ "a.txt": "a\n" });
    const dir = tmp("csh-transcripts-");
    writeFileSync(join(dir, "a.jsonl"), jl({ session: "A", kind: "user.message", ts: Date.now() + 2000, cwd: root, text: "one" }));
    const { env: e, config } = env();
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    // Imported by an earlier version: events stored, session row without repo state.
    await backfill({ config, index, blobs, adapters: [fileAdapter(dir, [], { gate: false })], env: e });
    const prev = (await index.getSession("A"))!;
    const { repo: _drop, ...noRepo } = prev;
    await index.upsertSession(noRepo);
    const r = await backfill({ config, index, blobs, adapters: [fileAdapter(dir, [])], env: e });
    assert.equal(r.events, 0);
    assert.equal(r.sessions, 1);
    assert.equal((await index.getSession("A"))!.repo?.root, root);
  });
});
