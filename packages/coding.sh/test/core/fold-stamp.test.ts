// Saved session folds and the refold cursor are stamped with SESSION_FOLD_VERSION
// and a hash of the fold state's shape (core/sessions.ts foldStamp), so a fold
// another build saved under the same integer is dropped and rebuilt from the
// session's events instead of crashing `sessions`, `show` and the viewer. Two
// builds once shipped fold version 14 with different states: one build's saved
// folds had no FlagState.unapproved, and every `coding.sh sessions` of the
// other threw "Cannot read properties of undefined (reading 'briefs')".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { deserialize, serialize } from "node:v8";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import type { Adapter, Session } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { childLinker, foldSessionRow, ingest, recomputeSession } from "../../src/core/ingest.ts";
import { REFOLD_CURSOR, reparse, reparseDue } from "../../src/core/reparse.ts";
import { foldSession, foldStamp, isFoldState, SESSION_FOLD_VERSION, sessionState } from "../../src/core/sessions.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { FIXTURES } from "../adapters/_helpers.ts";

const roots: string[] = [];
const opened: SqliteIndexStore[] = [];
// Close every store before removing its dir: Windows can't delete an open database.
after(async () => {
  for (const i of opened) await i.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
const MIN = 60_000;
type Raw = { session: string; kind: EventKind; [k: string]: unknown };

/** One spool line is one event: `raw` is its session, kind and payload. */
const adapter: Adapter = {
  id: "ff",
  displayName: "Fold fake",
  tier: "A",
  parseVersion: 1,
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    const { session, kind, ...payload } = line.raw as Raw;
    return [{
      id: ctx.id(line.agent, session, line.ts, line.event, 0),
      v: 0 as const,
      sessionId: session,
      ts: line.ts,
      agent: line.agent,
      kind,
      model: kind === "llm.call" ? "m" : undefined,
      payload,
      ...(kind === "llm.call" ? { usage: { inputTokens: 100, outputTokens: 10 } } : {}),
    }];
  },
};
const adapters = new Map<string, Adapter>([["ff", adapter]]);

/** Session s's first batch: a fold is saved up to 15 minutes before its newest event. */
const batch1: [number, Raw][] = [
  [0, { session: "s", kind: "user.message", text: "look around the repo" }],
  [1_000, { session: "s", kind: "tool.start", tool: "Bash", toolUseId: "x1", input: { command: "ls" } }],
  [2_000, { session: "s", kind: "tool.end", tool: "Bash", toolUseId: "x1", ok: true, output: "src" }],
  [3_000, { session: "s", kind: "llm.call" }],
  [20 * MIN, { session: "s", kind: "user.message", text: "what is in src?" }],
  [20 * MIN + 1_000, { session: "s", kind: "tool.start", tool: "Bash", toolUseId: "x2", input: { command: "ls src" } }],
  [20 * MIN + 2_000, { session: "s", kind: "tool.end", tool: "Bash", toolUseId: "x2", ok: false, output: "no such file" }],
  [0, { session: "t", kind: "user.message", text: "hello" }],
  [1_000, { session: "t", kind: "llm.call" }],
];
/** Appended later: folded onto the saved fold. */
const batch2: [number, Raw][] = [
  [21 * MIN, { session: "s", kind: "tool.start", tool: "Bash", toolUseId: "x3", input: { command: "rm -rf src" } }],
  [21 * MIN + 1_000, { session: "s", kind: "tool.end", tool: "Bash", toolUseId: "x3", ok: true, output: "" }],
  [21 * MIN + 2_000, { session: "s", kind: "llm.call" }],
];

async function store() {
  const root = mkdtempSync(join(tmpdir(), "csh-fold-stamp-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const spool = join(env.CODING_SH_HOME, "spool", "ff");
  mkdirSync(spool, { recursive: true });
  const index = await SqliteIndexStore.open(join(root, "index.db"));
  opened.push(index);
  const base = { config: defaultConfig(env), index, blobs: new MemoryBlobStore(), env, adapters };
  let n = 0;
  const spoolLines = (lines: [number, Raw][]) => {
    for (const [at, raw] of lines) appendFileSync(join(spool, "d1.jsonl"), JSON.stringify({ v: 0, agent: "ff", event: `E${n++}`, ts: T0 + at, pid: 1, cwd: root, raw }) + "\n");
  };
  /** The `seq` of each listEventsSince call: a first call past 0 means a saved fold was read. */
  const reads: number[] = [];
  const since = index.listEventsSince.bind(index);
  index.listEventsSince = (id, o) => (reads.push(o.seq), since(id, o));
  return {
    index,
    reads,
    spool: spoolLines,
    ingest: () => ingest(base),
    reparse: () => reparse(base),
    due: () => reparseDue(index, adapters),
    recompute: (id: string) => recomputeSession(index, id, { linker: childLinker(index), repo: { start: async () => undefined } }),
  };
}

/** What a session row must hold whichever way it was folded. */
const view = (s: Session | undefined) => s && { stats: s.stats, flags: [...s.flags].sort(), title: s.title, endedAt: s.endedAt };

/** Every container (object, Map, Set, array) of a fresh fold, by path. */
function containers(o: Record<string, unknown> = sessionState() as unknown as Record<string, unknown>, at: string[] = []): string[][] {
  const out: string[][] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || typeof v !== "object") continue;
    out.push([...at, k]);
    if (!(v instanceof Map || v instanceof Set || Array.isArray(v))) out.push(...containers(v as Record<string, unknown>, [...at, k]));
  }
  return out;
}

/** A saved fold's bytes with fn applied to the decoded fold. */
function edit(bytes: Uint8Array, fn: (f: { v: number; state: Record<string, any> }) => void): Uint8Array {
  const f = deserialize(bytes);
  fn(f);
  return serialize(f);
}

/** A control store and one whose saved fold of s, after batch1, is replaced with edit(fold) before batch2. */
async function pair(fn: (f: { v: number; state: Record<string, any> }) => void) {
  const good = await store();
  const bad = await store();
  for (const t of [good, bad]) {
    t.spool(batch1);
    await t.ingest();
  }
  const saved = await bad.index.getSessionFold("s");
  assert.ok(saved, "batch1 leaves a saved fold");
  await bad.index.putSessionFold("s", edit(saved, fn));
  for (const t of [good, bad]) t.spool(batch2);
  await good.ingest();
  return { good, bad, saved };
}

describe("saved session folds from another build", () => {
  it("a fold another build saved under this fold version without FlagState.unapproved is rebuilt, and sessions and the fold read right", async () => {
    // What the other build wrote: the bare integer, and a state with no unapproved sub-state.
    const { good, bad } = await pair((f) => {
      f.v = SESSION_FOLD_VERSION;
      delete f.state.flags.unapproved;
    });
    bad.reads.length = 0;
    await bad.ingest();
    assert.equal(bad.reads[0], 0, "the foreign fold is not read: s is folded from all its events");
    const want = view(await good.index.getSession("s"));
    assert.ok(want!.flags.includes("unapproved-action"), "the control flags the rm -rf the user never asked for");
    assert.deepEqual(view(await bad.index.getSession("s")), want);
    assert.deepEqual((await bad.index.listSessions({})).map(view), (await good.index.listSessions({})).map(view), "sessions");
    const row = await foldSessionRow(bad.index, "s", await bad.index.getSession("s"));
    assert.deepEqual(view({ ...row!.session, flags: row!.session.flags }), want, "the fold");
    const fold = deserialize((await bad.index.getSessionFold("s"))!);
    assert.equal(fold.v, foldStamp(), "the fold saved in its place carries this build's stamp");
    assert.ok(fold.state.flags.unapproved, "and every sub-state");
  });

  it("a fold with this build's stamp missing any sub-state, or holding one of another kind, is rebuilt", async () => {
    const { good, bad, saved } = await pair(() => {});
    await bad.ingest();
    const want = view(await good.index.getSession("s"));
    bad.reads.length = 0;
    assert.ok(await bad.recompute("s"));
    assert.ok(bad.reads[0]! > 0, "this build's own fold is read back, not rebuilt");
    assert.deepEqual(view(await bad.index.getSession("s")), want);
    const paths = containers();
    assert.ok(paths.length > 40, `${paths.length} containers`);
    const cases: [string, (f: { state: Record<string, any> }) => void][] = [];
    for (const p of paths) {
      const parent = (f: { state: Record<string, any> }) => p.slice(0, -1).reduce((o, k) => o[k], f.state);
      cases.push([`no ${p.join(".")}`, (f) => void delete parent(f)[p.at(-1)!]]);
      cases.push([`${p.join(".")} = 1`, (f) => void (parent(f)[p.at(-1)!] = 1)]);
    }
    cases.push(["flags.unapproved = {}", (f) => void (f.state.flags.unapproved = {})]);
    cases.push(["a state that is not an object", (f) => void (f.state = null as never)]);
    for (const [name, fn] of cases) {
      await bad.index.putSessionFold("s", edit(saved, fn));
      bad.reads.length = 0;
      await assert.doesNotReject(bad.recompute("s"), name);
      assert.equal(bad.reads[0], 0, `${name}: folded from all its events`);
      assert.deepEqual(view(await bad.index.getSession("s")), want, name);
    }
  });

  it("a fold that passes the shape check but throws when newer events are folded onto it is rebuilt", async () => {
    // Another build's ModelUse: no tokens, so adding the next call's tokens throws.
    const { good, bad } = await pair((f) => {
      f.state.models.main = new Map([["m", { calls: 1, first: 0, last: 0 }]]);
    });
    await assert.doesNotReject(bad.ingest());
    assert.deepEqual(view(await bad.index.getSession("s")), view(await good.index.getSession("s")));
    assert.ok(isFoldState(deserialize((await bad.index.getSessionFold("s"))!).state), "a sound fold is saved in its place");
  });

  it("every adapter golden folds to a state the shape check keeps", () => {
    let sessions = 0;
    for (const agent of readdirSync(FIXTURES)) {
      let files: string[] = [];
      try {
        files = readdirSync(join(FIXTURES, agent, "golden")).filter((f) => f.endsWith(".golden.json"));
      } catch {
        continue;
      }
      for (const f of files) {
        const events = (JSON.parse(readFileSync(join(FIXTURES, agent, "golden", f), "utf8")) as AgentEvent[]).map((e) => ({ ...e, agent: e.agent ?? agent }));
        const by = new Map<string, AgentEvent[]>();
        for (const e of events) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
        for (const [sid, evs] of by) {
          const s = sessionState();
          for (const e of evs.sort((a, b) => a.ts - b.ts)) foldSession(s, e);
          sessions++;
          assert.ok(isFoldState(deserialize(serialize(s))), `${agent}/${f} ${sid}`);
        }
      }
    }
    assert.ok(sessions >= 20, `${sessions} sessions`);
  });
});

describe("the refold cursor", () => {
  it("a store another build folded under this fold version's integer is refolded once", async () => {
    const t = await store();
    t.spool(batch1);
    await t.ingest();
    for (const id of ["s", "t"]) {
      const s = (await t.index.getSession(id))!;
      await t.index.upsertSession({ ...s, flags: [...s.flags, "old-flag"] });
    }
    // The other build's refold left its cursor at the bare integer.
    await t.index.setCursor(REFOLD_CURSOR, SESSION_FOLD_VERSION);
    assert.equal(await t.due(), true);
    assert.equal((await t.reparse()).refolded, 2);
    for (const id of ["s", "t"]) assert.ok(!(await t.index.getSession(id))!.flags.includes("old-flag"), id);
    assert.equal(await t.index.getCursor(REFOLD_CURSOR), foldStamp());
    assert.equal(await t.due(), false);
    assert.equal((await t.reparse()).refolded, 0, "once");
  });

  it("the same build does not refold again, in this process or the next", async () => {
    const t = await store();
    t.spool(batch1);
    await t.ingest();
    const stamp = await t.index.getCursor(REFOLD_CURSOR);
    assert.equal(stamp, foldStamp(), "a fresh store is stamped current");
    assert.notEqual(stamp, SESSION_FOLD_VERSION, "with more than the integer another build may share");
    assert.ok(Number.isSafeInteger(stamp) && stamp > 0, "a cursor every store keeps exactly");
    // Import by file URL: on Windows a bare C:\ path is not a valid ESM specifier.
    const src = new URL("../../src/core/sessions.ts", import.meta.url).href;
    const next = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `import { foldStamp } from ${JSON.stringify(src)}; console.log(foldStamp());`], { encoding: "utf8" });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(Number(next.stdout.trim()), stamp, "the next process computes the same stamp");
    assert.equal(await t.due(), false);
    assert.equal((await t.reparse()).refolded, 0);
    // And each session's own fold is read back, not rebuilt.
    t.spool(batch2);
    t.reads.length = 0;
    await t.ingest();
    assert.ok(t.reads[0]! > 0);
  });
});
