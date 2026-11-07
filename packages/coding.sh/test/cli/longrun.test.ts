// A synthetic 12-hour Claude Code session (test/fixtures/longrun/generate.ts,
// no real user data) at a quarter of the full event rate: two `claude --resume`
// runs, auto compactions, subagents, a day boundary and one planted derail of
// each kind. Checks that ingest finds every planted derail at its onset and
// nothing else, that `show` summarises it by phase, that `sessions --flag`
// filters on derails, and that session building stays linear in the event
// count (the perf guard for very long sessions; the full-size bench is
// scripts/perf/longrun.mjs, see docs/perf.md). Then that the incremental
// session fold live ingest keeps (core/ingest.ts recomputeSession) builds
// exactly what a full rebuild builds, however the events are split.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { detectDerails } from "../../src/core/derail.ts";
import { childLinker, recomputeSession } from "../../src/core/ingest.ts";
import { sessionOutline } from "../../src/core/outline.ts";
import { buildSession, foldSession, isRealPrompt, sessionOf, sessionState, type SessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { generateLongSession, type GenManifest } from "../fixtures/longrun/generate.ts";
import { median, timeMs } from "../helpers-timing.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let m: GenManifest;
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r;
};
const cli = (...args: string[]) => run(...args).stdout;

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-longrun-"));
  m = generateLongSession({ out: join(root, "fixture"), scale: 0.25 });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: m.files.claudeConfigDir,
    CODEX_HOME: m.files.codexHome,
    T3CODE_HOME: join(root, "t3"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TZ: "UTC",
  };
  cli("ingest", "--backfill", "--agent", "claude-code", "--agent", "codex");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("a 12-hour session", () => {
  test("every planted derail is found at its onset, and nothing else", () => {
    const { sessions } = JSON.parse(cli("sessions", "--json", "--limit", "10")) as { sessions: Session[] };
    const main = sessions.find((s) => s.id === m.sessionId)!;
    assert.ok(main, "the long session is listed");
    const found = (main.stats.derails ?? []).map((d) => ({ flag: d.flag, ts: d.ts }));
    assert.deepEqual(found.map((d) => d.flag).sort(), m.derails.map((d) => d.flag).sort());
    for (const p of m.derails) {
      const d = found.find((x) => x.flag === p.flag)!;
      assert.ok(Math.abs(d.ts - p.ts) <= 60_000, `${p.flag} found ${Math.round((d.ts - p.ts) / 1000)} s from its planted onset (${p.note})`);
    }
    for (const p of m.derails) assert.ok(main.flags.includes(p.flag), `flag ${p.flag}`);
    const codex = sessions.find((s) => s.id === m.codexSessionId)!;
    assert.deepEqual(codex.stats.derails ?? [], [], "the resumed Codex thread runs clean");
  });

  test("sessions --flag filters on a derail", () => {
    const ids = (flag: string) => (JSON.parse(cli("sessions", "--json", "--flag", flag)) as { sessions: Session[] }).sessions.map((s) => s.id);
    assert.deepEqual(ids("looping"), [m.sessionId]);
    assert.deepEqual(ids("stalled"), [m.sessionId]);
  });

  // The transcript has no resume marker (only the hook's SessionStart says "resume"), so a
  // backfilled resume shows as an idle gap; test/core/outline.test.ts covers hook resumes.
  test("show summarises by phase: start, compactions, idle gaps and the day line", () => {
    const r = run("show", m.sessionId);
    const text = r.stdout;
    assert.match(r.stderr + r.stdout, /\d+ events in \d+ phases; --all lists every event/);
    assert.equal((text.match(/compacted \(auto\)/g) ?? []).length, m.compactions);
    assert.match(text, /back after \d+ min idle/);
    assert.match(text, /── \w{3}, Nov 4 ──/, "the UTC day boundary");
    for (const p of m.derails) assert.ok(text.includes(`⚠ ${p.flag}`), `derail ${p.flag} under its phase`);
    const json = JSON.parse(cli("show", m.sessionId, "--json")) as { phases: { kind: string }[]; days: unknown[]; events: unknown[] };
    assert.equal(json.phases.filter((p) => p.kind === "compaction").length, m.compactions);
    assert.equal(json.phases[0]!.kind, "start");
    assert.equal(json.days.length, 1);
    const all = cli("show", m.sessionId, "--all");
    assert.ok(all.split("\n").length > json.events.length * 0.5, "--all lists every event");
    assert.match(all, /── phase 2: /);
  });

  test("show --follow prints the tail and the derails, and stops once the session has ended", () => {
    const r = run("show", m.sessionId, "--follow");
    assert.match(r.stdout, /⚠ looping/);
    assert.match(r.stdout + r.stderr, /Session ended/);
    assert.ok(r.stdout.split("\n").length < 200, "a tail, not the whole session");
  });

  test("building the session stays linear in its event count", async () => {
    const store = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"), { readOnly: true });
    let events: AgentEvent[];
    try {
      events = await store.listEvents(m.sessionId);
    } finally {
      await store.close();
    }
    const quarter = events.slice(0, Math.floor(events.length / 4));
    const work = (evs: AgentEvent[]) => () => {
      const s = buildSession(evs);
      sessionOutline(evs, s.stats.derails ?? []);
    };
    work(events)();
    // Interleaved, so load on the box stretches both sides alike. Linear work is about 4x; quadratic would be about 16x.
    const ratios: number[] = [];
    for (let i = 0; i < 5; i++) ratios.push(timeMs(work(events)) / timeMs(work(quarter)));
    assert.ok(median(ratios) < 9, `4x the events took ${median(ratios).toFixed(1)}x as long (${ratios.map((r) => r.toFixed(1)).join(", ")})`);
    // Against a same-moment baseline: one pass that touches every event's payload.
    const base = timeMs(() => JSON.stringify(events));
    const derail = median([0, 1, 2].map(() => timeMs(() => detectDerails(events))));
    assert.ok(derail < Math.max(base * 6, 30), `detectDerails ${derail.toFixed(0)} ms over ${events.length} events; JSON.stringify ${base.toFixed(0)} ms`);
  });
});

describe("incremental session folds over the 12-hour session", () => {
  let events: AgentEvent[] = [];
  let stored: Session;
  before(async () => {
    const store = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"), { readOnly: true });
    try {
      events = await store.listEvents(m.sessionId);
      stored = (await store.getSession(m.sessionId))!;
    } finally {
      await store.close();
    }
  });

  // Seeded, so a failure reproduces.
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  test("folding in random chunks, saved and loaded in between, builds what folding everything at once builds", () => {
    const cuts = [...new Set(Array.from({ length: 24 }, (_, i) => Math.round(((i + 1) / 25) * events.length)))];
    const expected = new Map(cuts.map((c) => [c, buildSession(events.slice(0, c), stored)]));
    expected.set(events.length, buildSession(events, stored));
    const rand = rng(7);
    for (let run = 0; run < 10; run++) {
      // A random subset of the cut points: chunks of every size, from a few events to most of the session.
      const stops = [...cuts.filter(() => rand() < 0.3), events.length];
      let state = sessionState();
      let at = 0;
      for (const stop of stops) {
        for (; at < stop; at++) foldSession(state, events[at]!);
        state = deserialize(serialize(state)) as SessionState;
        assert.deepEqual(sessionOf(state, stored), expected.get(stop), `run ${run}: the first ${stop} of ${events.length} events`);
      }
    }
  });

  test("live recomputes fold only the new events, even when they arrive out of time order", async () => {
    const dir = mkdtempSync(join(root, "fold-"));
    const store = await SqliteIndexStore.open(join(dir, "index.db"));
    const built: Session[] = [];
    const upsert = store.upsertSession.bind(store);
    store.upsertSession = async (s) => {
      built.push(structuredClone(s));
      await upsert(s);
    };
    let fullReads = 0;
    const since = store.listEventsSince.bind(store);
    store.listEventsSince = async (id, from) => {
      if (from.seq === 0) fullReads++;
      return since(id, from);
    };
    const o = { linker: childLinker(store), repo: { start: async () => undefined } };
    const rand = rng(11);
    try {
      // Appends of 20 to 400 events. Like a Stop's transcript window, some of the turn's model calls
      // (after its prompt, in the last minutes) come in the next append, stamped before what is already
      // stored. Once, a tool.end comes an hour late: that one means reading everything again.
      let held: AgentEvent[] = [];
      let late: AgentEvent | undefined;
      let lateDone = false;
      let steps = 0;
      for (let at = 0; at < events.length; ) {
        const n = 20 + Math.floor(rand() * 380);
        const chunk = events.slice(at, at + n);
        at += n;
        const now = [...held];
        held = [];
        const prompt = chunk.findLast(isRealPrompt)?.ts ?? -Infinity;
        const recent = chunk.at(-1)!.ts - 10 * 60_000;
        for (const e of chunk) {
          if (e.kind === "llm.call" && e.ts > prompt && e.ts > recent && rand() < 0.5) held.push(e);
          else if (!late && !lateDone && at > events.length / 2 && e.kind === "tool.end") late = e;
          else now.push(e);
        }
        if (late && chunk.at(-1)!.ts - late.ts > 60 * 60_000) {
          now.push(late);
          late = undefined;
          lateDone = true;
        }
        if (at >= events.length) now.push(...held, ...(late ? [late] : []));
        await store.putEvents(now);
        const prev = await store.getSession(m.sessionId);
        assert.ok(await recomputeSession(store, m.sessionId, o));
        steps++;
        const all = await store.listEvents(m.sessionId);
        assert.deepEqual(built.at(-1), buildSession(all, prev), `append ${steps}, ${all.length} events stored`);
        assert.ok(await store.getSessionFold(m.sessionId), "a fold is kept");
      }
      assert.equal(built.at(-1)!.stats.events, events.length);
      assert.deepEqual(built.at(-1)!.stats.derails, stored.stats.derails);
      // The first recompute and the hour-late event read everything; the other appends only the new events and the fold's lag window.
      assert.ok(fullReads <= 3, `${fullReads} full reads in ${steps} recomputes`);
    } finally {
      await store.close();
    }
  });
});
