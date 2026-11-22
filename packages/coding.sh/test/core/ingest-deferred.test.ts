// A budgeted or stopped ingest leaves its git work (end snapshots, start repo states) for a later
// ingest without a deadline (core/ingest-deferred.ts), a backfill with a deadline commits each
// file as it ends, and a stop signal ends either part way with what was read committed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import type { Adapter, BackfillFile, BackfillOpts, Config, Session } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, backfillCursorKey, ingest } from "../../src/core/ingest.ts";
import { readDeferred } from "../../src/core/ingest-deferred.ts";
import { isLocked } from "../../src/core/lock.ts";
import { repoResolver, type RepoFacts } from "../../src/core/repo-state.ts";
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

/** Hook-style adapter: raw = { session, kind } → one event at the line's ts and cwd. */
const hookAdapter: Adapter = {
  ...stub,
  id: "fake",
  tier: "A",
  async normalize(line, ctx) {
    const { session, kind, ...payload } = line.raw as Record<string, unknown>;
    return [{ id: ctx.id(line.agent, String(session), line.ts, String(kind)), v: 0, sessionId: String(session), ts: line.ts, agent: line.agent, kind: kind as EventKind, cwd: line.cwd, payload }];
  },
};
const adapters = new Map([["fake", hookAdapter]]);

function env(): { env: NodeJS.ProcessEnv; config: Config; spool: string; spoolDir: string } {
  const spoolDir = tmp("csh-spool-");
  const e = { ...process.env, HOME: join(spoolDir, "user"), CODING_SH_NO_AUTO_INGEST: "1" };
  const spool = join(spoolDir, "fake");
  mkdirSync(spool, { recursive: true });
  return { env: e, config: defaultConfig(e), spool, spoolDir };
}

const spoolLine = (ts: number, cwd: string, raw: Record<string, unknown>) => JSON.stringify({ v: 0, agent: "fake", event: String(raw.kind), ts, pid: 1, cwd, raw }) + "\n";

/** Runs fn with GIT_TRACE on (git appends a line per command it runs): the git commands it ran. */
async function gitTrace<T>(fn: () => Promise<T>): Promise<{ value: T; commands: string[] }> {
  const file = join(tmp("csh-trace-"), "git.trace");
  const saved = process.env.GIT_TRACE;
  process.env.GIT_TRACE = file;
  try {
    const value = await fn();
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return { value, commands: text.split("\n").filter((l) => /trace: (built-in|exec|run_command)/.test(l)) };
  } finally {
    if (saved === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = saved;
  }
}

describe("git work in a budgeted ingest (QA: a 1.5 s read ran for minutes)", () => {
  it("a read past its deadline runs no git, keeps the work, and the next ingest does it, one snapshot per repo", async () => {
    const root = makeRepo({ "sum.js": "module.exports = (a, b) => a - b;\n" });
    const headSha = gitc(root, "rev-parse", "HEAD");
    write(root, { "sum.js": "module.exports = (a, b) => a + b;\n" });
    const { env: e, config, spool, spoolDir } = env();
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const t0 = Date.now() + 2000; // after the commit's reflog entry
    // Three sessions in the repo that each ended a turn just now, in one spool file (the first file is always read).
    let lines = "";
    for (const id of ["s1", "s2", "s3"]) lines += spoolLine(t0, root, { session: id, kind: "session.start" }) + spoolLine(t0 + 10, root, { session: id, kind: "turn.end" });
    writeFileSync(join(spool, "s.jsonl"), lines);
    const now = () => t0 + 1000;

    const budgeted = await gitTrace(() => ingest({ config, index, blobs, adapters, env: e, spoolDir, lock: false, now, deadline: Date.now() - 1 }));
    assert.deepEqual(budgeted.commands, [], "no git at all once past the deadline");
    assert.equal(budgeted.value.lines, 6, "the lines are read and stored");
    assert.equal(budgeted.value.deferred, 3);
    for (const id of ["s1", "s2", "s3"]) {
      const s = (await index.getSession(id))!;
      assert.equal(s.repo, undefined, `${id}: repo state waits`);
      assert.equal(s.endSnapshot, undefined, `${id}: end snapshot waits`);
    }
    const kept = (await readDeferred(index))!;
    assert.deepEqual(Object.keys(kept.snapshots).sort(), ["s1", "s2", "s3"]);
    assert.deepEqual([...kept.repos].sort(), ["s1", "s2", "s3"]);

    // A later ingest without a deadline (the background one the read starts) does it.
    const full = await gitTrace(() => ingest({ config, index, blobs, adapters, env: e, spoolDir, lock: false, now }));
    assert.deepEqual(full.value.errors, []);
    assert.equal(full.value.deferred, undefined);
    const snaps = new Set<string | undefined>();
    for (const id of ["s1", "s2", "s3"]) {
      const s = (await index.getSession(id))!;
      assert.deepEqual(s.repo, { root, head: headSha, branch: "main" }, id);
      assert.ok(s.endSnapshot, `${id}: end snapshot taken`);
      snaps.add(s.endSnapshot);
    }
    assert.equal(snaps.size, 1, "sessions that ended in one repo share one snapshot");
    // One root lookup per cwd, one HEAD-at-time and branch per root, one snapshot: not one of each per session.
    const count = (re: RegExp) => full.commands.filter((l) => re.test(l)).length;
    assert.equal(count(/rev-parse --show-toplevel(?: --git-dir --git-common-dir)?(?: --show-prefix)?\s*$/), 1, full.commands.join("\n"));
    assert.equal(count(/rev-parse --verify 'HEAD@\{/), 1, full.commands.join("\n"));
    assert.equal(count(/commit-tree/), 1, full.commands.join("\n"));
    assert.deepEqual(await readDeferred(index), { snapshots: {}, repos: [] }, "the work is settled");
  });

  it("an end snapshot that ages out while deferred is dropped, not taken late", async () => {
    const root = makeRepo({ "a.txt": "a\n" });
    const { env: e, config, spool, spoolDir } = env();
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const t0 = Date.now() + 2000;
    writeFileSync(join(spool, "s.jsonl"), spoolLine(t0, root, { session: "old", kind: "session.start" }) + spoolLine(t0 + 10, root, { session: "old", kind: "turn.end" }));
    await ingest({ config, index, blobs, adapters, env: e, spoolDir, lock: false, now: () => t0 + 1000, deadline: Date.now() - 1 });
    assert.ok(Object.keys((await readDeferred(index))!.snapshots).includes("old"));
    await ingest({ config, index, blobs, adapters, env: e, spoolDir, lock: false, now: () => t0 + 60 * 60_000 });
    const s = (await index.getSession("old"))!;
    assert.ok(s.repo, "repo state is filled in");
    assert.equal(s.endSnapshot, undefined, "an hour later the tree is not the end of that turn");
    assert.deepEqual(await readDeferred(index), { snapshots: {}, repos: [] });
  });

  it("repoResolver asks git once per cwd and once per root and second, and nothing new once stopped", async () => {
    const root = makeRepo({ "a.txt": "a\n" });
    const t0 = Date.now() + 2000;
    let stop = false;
    const skipped: string[] = [];
    const repo = repoResolver({ stop: () => stop, skipped: (id) => skipped.push(id) });
    const session = (id: string, cwd = root) => ({ id, cwd, startedAt: t0 }) as Session; // slop-allow chained-as: a session row with only the fields repoResolver reads
    const facts: RepoFacts = { live: false };
    const { commands, value } = await gitTrace(async () => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push(await repo.start(session(`s${i}`), facts));
      return out;
    });
    assert.ok(value.every((s) => s?.root === root));
    assert.ok(commands.length <= 2, `ten sessions in one repo: ${commands.length} git commands\n${commands.join("\n")}`);
    stop = true;
    const late = await gitTrace(() => repo.start(session("other", join(root, "..")), facts));
    assert.equal(late.value, undefined);
    assert.deepEqual(late.commands, []);
    assert.deepEqual(skipped, ["other"]);
  });
});

describe("a stop signal (Ctrl-C on coding.sh ingest)", () => {
  it("stops the spool ingest at the next line, commits what was read and releases the lock", async () => {
    const { env: e, config, spool, spoolDir } = env();
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const file = join(spool, "big.jsonl");
    let lines = "";
    for (let i = 0; i < 200; i++) lines += spoolLine(1_700_000_000_000 + i, "/work/demo", { session: `s${i % 3}`, kind: "user.message", n: i });
    writeFileSync(file, lines);
    const ac = new AbortController();
    // Aborted while the 20th line is read, long before a checkpoint (5000 events).
    const counting: Adapter = {
      ...hookAdapter,
      async normalize(line, ctx) {
        if ((line.raw as { n: number }).n === 19) ac.abort();
        return hookAdapter.normalize(line, ctx);
      },
    };
    const lockPath = join(spoolDir, ".ingest.lock");
    const r = await ingest({ config, index, blobs, adapters: new Map([["fake", counting]]), env: e, spoolDir, signal: ac.signal, lock: { path: lockPath } });
    assert.equal(r.lines, 20, "stops after the line it was reading");
    assert.equal(r.pendingFiles, 1);
    const cursor = await index.getCursor("fake/big.jsonl");
    assert.ok(cursor > 0 && cursor < statSync(file).size, `cursor ${cursor} inside the file`);
    assert.equal(r.events, 20, "what was read is stored");
    assert.equal(isLocked(lockPath), false, "the lock is released");
    const rest = await ingest({ config, index, blobs, adapters, env: e, spoolDir, lock: { path: lockPath } });
    assert.equal(rest.lines, 180);
    assert.equal(await index.getCursor("fake/big.jsonl"), statSync(file).size);
  });
});

/** A transcript adapter over three files: it yields each file's events after changed(file) says to read it. */
function transcriptAdapter(dir: string, hooks: { afterFile?: (n: number) => Promise<void> | void; inFile?: (n: number, i: number) => void } = {}): { adapter: Adapter; files: BackfillFile[] } {
  const files: BackfillFile[] = [1, 2, 3].map((n) => {
    const path = join(dir, `t${n}.jsonl`);
    writeFileSync(path, "x".repeat(n * 10));
    const st = statSync(path);
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  });
  const adapter: Adapter = {
    ...stub,
    id: "tx",
    tier: "B",
    normalize: async () => [],
    async *backfill(_ctx, opts: BackfillOpts = {}) {
      for (const [k, f] of files.entries()) {
        const n = k + 1;
        if (opts.changed && !(await opts.changed(f))) continue;
        for (let i = 0; i < 5; i++) {
          hooks.inFile?.(n, i);
          yield { id: `tx-${n}-${i}`, v: 0, sessionId: `tx${n}`, ts: 1_700_000_000_000 + n * 1000 + i, agent: "tx", kind: "user.message", payload: { text: `m${i}` } } as AgentEvent;
        }
        await hooks.afterFile?.(n);
      }
    },
  };
  return { adapter, files };
}

describe("backfill with a deadline or a stop (QA: the tail child committed no cursors)", () => {
  const mtimeKey = (f: BackfillFile) => backfillCursorKey("tx", f.path, "mtime");

  it("commits each file's cursors as the next one starts, so a child killed at its deadline keeps them", async () => {
    const { env: e, config } = env();
    const index = new MemoryIndexStore();
    let release!: () => void;
    let hung!: () => void;
    const hanging = new Promise<void>((r) => (hung = r));
    const { adapter, files } = transcriptAdapter(tmp("csh-tx-"), {
      // After its last file the adapter does not return (a scan, a big database): the parent kills the child here.
      afterFile: (n) => (n === 3 ? (hung(), new Promise<void>((r) => (release = r))) : undefined),
    });
    const run = backfill({ config, index, blobs: new MemoryBlobStore(), adapters: [adapter], env: e, deadline: Date.now() + 60_000 });
    await hanging;
    assert.equal(await index.getCursor(mtimeKey(files[0]!)), Math.floor(files[0]!.mtimeMs), "file 1 committed");
    assert.equal(await index.getCursor(mtimeKey(files[1]!)), Math.floor(files[1]!.mtimeMs), "file 2 committed");
    assert.equal(await index.getCursor(mtimeKey(files[2]!)), 0, "file 3 waits until it is read through");
    assert.equal((await index.getSession("tx1"))?.stats.events, 5, "the sessions of committed files are folded");
    release();
    const r = await run;
    assert.equal(r.pendingFiles, 0);
    assert.equal(await index.getCursor(mtimeKey(files[2]!)), Math.floor(files[2]!.mtimeMs));
  });

  it("a stop part way through a file commits the files read through and leaves that one for the next run", async () => {
    const { env: e, config } = env();
    const index = new MemoryIndexStore();
    const ac = new AbortController();
    const { adapter, files } = transcriptAdapter(tmp("csh-tx-"), { inFile: (n, i) => (n === 2 && i === 2 ? ac.abort() : undefined) });
    // An adapter after the stopped one is not started, and adds no file of its own to the count.
    let laterRead = 0;
    const later: Adapter = { ...stub, id: "later", tier: "B", normalize: async () => [], async *backfill() { laterRead++; } };
    const r = await backfill({ config, index, blobs: new MemoryBlobStore(), adapters: [adapter, later], env: e, signal: ac.signal });
    assert.equal(r.pendingFiles, 1, "the file it was reading");
    assert.equal(laterRead, 0);
    assert.equal(await index.getCursor(mtimeKey(files[0]!)), Math.floor(files[0]!.mtimeMs), "file 1 committed");
    assert.equal(await index.getCursor(mtimeKey(files[1]!)), 0, "file 2 is read again next time");
    assert.equal(await index.getCursor(mtimeKey(files[2]!)), 0, "file 3 not reached");
    assert.equal((await index.getSession("tx1"))?.stats.events, 5);
    const next = await backfill({ config, index, blobs: new MemoryBlobStore(), adapters: [adapter], env: e });
    assert.equal(next.pendingFiles, 0);
    for (const f of files) assert.equal(await index.getCursor(mtimeKey(f)), Math.floor(f.mtimeMs));
    assert.equal((await index.getSession("tx2"))?.stats.events, 5, "no event of the stopped file lost or doubled");
    assert.equal((await index.getSession("tx3"))?.stats.events, 5);
  });
});
