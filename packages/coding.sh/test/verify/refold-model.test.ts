// A model of the refold and the reprice after an upgrade, checked with test/_model.ts. A build with a
// new SESSION_FOLD_VERSION (core/sessions.ts:590) folds every stored session again, and one with new
// prices (core/pricing.ts) prices the stored events again. Background ingests do both, two at once,
// and any of them can crash part way.
//
// A process is a background ingest (cli/commands/ingest.ts:82-95), and each step is one in the code
// (paths under packages/coding.sh/src):
// - Opening the store runs the reprice pass (store/factory.ts:152), and an error in it is swallowed.
//   repriceStored (core/reprice.ts:38-76) does nothing while REPRICE_CURSOR holds the price stamp
//   (:43). Otherwise it lists the session rows (:46), and for each session reads its events (:47),
//   sets new costs on those priced under the old table (:70; store/sqlite.ts setEventCosts
//   :1271-1290, one transaction that also drops the session's saved fold), reads the events again and
//   folds them (:71), and writes the row it listed with only the usage totals replaced (:71, withUsage
//   :91-95). Then it sets the cursor (:74).
// - The ingest takes the ingest lock with waitMs 0 (core/ingest.ts:286); when another process holds
//   it, the run ends (cli/commands/ingest.ts:94-95). It stores the spool's lines and folds their
//   session in one transaction (core/ingest.ts:564-590).
// - A refold is due while REFOLD_CURSOR is not this build's foldStamp() (core/reparse.ts:246-249).
//   reparse takes reparse.lock with waitMs 0 (:385); when it is held, the run ends
//   (cli/commands/ingest.ts:91-92). With the cursor still stale (:694), refold (:664-688) reads its
//   saved progress, REFOLD_AFTER, used only when its stamp is this build's (:666-671), and folds each
//   session after it (:672-675) under the ingest lock (underLock :575-592), saving its progress after
//   every 100th (:684-685). A session in the model stands for those 100, so it saves after each one.
//   Waiting for the ingest lock can run out (30 s), which ends the run. At the end it sets the cursor,
//   clears its progress (:696-697) and releases reparse.lock (:390).
// - The fold of one session (recomputeSession, core/ingest.ts:1308-1358) reads the saved fold, used
//   only when its stamp is this build's (readFold :1571-1579), and the events after it; saves the fold
//   again when it folded anything new (foldStoredSession :1594-1630, :1622); and writes the row.
// The store is SQLite: a statement or a transaction is one step (BEGIN IMMEDIATE, store/sqlite.ts
// :970-985). The hook appends lines for one session at any time. The run after the last line (the one
// that line kicks) runs alone at the end, and neither crashes nor fails.
//
// Checked: a current REFOLD_CURSOR means every row has this build's fold; a current REPRICE_CURSOR
// means every event has the new prices; a saved fold stamped by this build was made by this build's
// fold and holds its events' current prices; and after the last run every row has the current fold,
// counts every event and sums the new prices. Four mutants show that the two stamp checks, the fold
// drop and the order of the progress save are each needed.
//
// Left out: stores without transactions or saved folds (the memory store, the Postgres and ClickHouse
// plugins); the re-parse from transcripts that comes before the refold, and the transcript read after
// the spool (cli/commands/ingest.ts:88); the check before a refold writes a row that no event was
// stored since its read (:1348-1352), which never fires here, since only the ingest stores events and
// it cannot take the ingest lock while the refold holds it; several sessions per lock hold (one per
// hold lets other processes in more often); a crashed process's locks, which the model frees at once
// (test/verify/lock-model.test.ts checks how a stale lock is broken); spans, which keep no saved fold;
// FOLD_LAG_MS (the model saves every event in the fold); and two builds running at once. Two more
// cases are left out of the runs: a reprice pass at once with an ingest or a refold, and a crash or
// throw between a session's new costs and its row. The invariants do not hold there yet, and the
// cases went to the code's owners.
//
// Bounds: two sessions, two processes and the run after them, one hook line, one crash and one reprice
// pass that throws. Two sessions are the fewest where saved progress skips a session, two processes
// the fewest for a race, and one crash is enough to stop a refold part way. CODING_SH_MODEL_BOUND=n
// adds n processes to each run, and n hook lines and n crashes to the runs with a new fold version,
// which checks a refold stopped more than once. Bound 1 checks about 76,000 states in 2 s, bound 2
// about 1.5 million in a minute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsOf, check, formatTrace, type Action, type CheckResult, type Model } from "../_model.ts";

/** A version: 0 before the upgrade, 1 the running build's. */
type Ver = 0 | 1;
const CUR: Ver = 1;
/** Sessions in the store. */
const N = 2;

/** A session row: the fold version its stats came from, how many events they count, and the price version of each event its usage sums. */
interface Row {
  fold: Ver;
  seen: number;
  usage: Ver[];
}

/** A saved fold (kv `fold:<session>`): the stamp it was saved with, the fold version that made its state, and the price of each event in it. */
interface Saved {
  v: Ver;
  made: Ver;
  prices: Ver[];
}

/** What one fold of a session read, and whether it saves the fold again. */
interface Read {
  made: Ver;
  prices: Ver[];
  save: boolean;
}

type Pc =
  | "reprice list"
  | "reprice read"
  | "reprice set"
  | "reprice rebuild"
  | "reprice upsert"
  | "reprice cursor"
  | "ingest lock"
  | "ingest store"
  | "ingest release"
  | "refold due"
  | "run lock"
  | "refold start"
  | "chunk lock"
  | "refold read"
  | "refold put"
  | "refold write"
  | "progress"
  | "chunk release"
  | "refold cursor"
  | "refold clear"
  | "run release"
  | "done";

/** Changes to the code that the invariants must catch. */
type Mutant = "progress read whatever its stamp" | "a saved fold read whatever its stamp" | "costs set without dropping the fold" | "progress saved before the fold";

interface Config {
  procs: number;
  /** SESSION_FOLD_VERSION changed: rows, saved folds and REFOLD_CURSOR start at the old version. */
  foldBump: boolean;
  /** The prices changed: stored events and REPRICE_CURSOR start at the old prices. */
  priceBump: boolean;
  /** Lines the hook appends for session 0 while the processes run. */
  lines: number;
  crashes: number;
  /** Reprice passes that throw. */
  failures: number;
  /** The processes run one after another instead of at once. */
  sequential?: boolean;
  /** REFOLD_AFTER left by an older build's refold that stopped after session 0. */
  staleAfter?: boolean;
  mutant?: Mutant;
}

interface Proc {
  pc: Pc;
  /** The session the reprice works on, or the position in the refold's list. */
  i: number;
  /** The rows the reprice listed at the start of its pass. */
  snap: Row[] | null;
  /** The events of the session the reprice read that need a new cost. */
  costs: number[];
  /** The prices the reprice folded for the session's new usage. */
  built: Ver[] | null;
  /** The sessions the refold folds, in order. */
  ids: number[];
  read: Read | null;
  /** The run after the others end. */
  next: boolean;
}

interface St {
  /** Each session's stored events: the price version of each one's cost. */
  ev: Ver[][];
  rows: Row[];
  folds: (Saved | null)[];
  /** REFOLD_CURSOR and REPRICE_CURSOR: current or not. */
  refold: Ver;
  reprice: Ver;
  /** REFOLD_AFTER: the stamp it was saved with and the last session done. */
  after: { v: Ver; id: number } | null;
  /** Who holds the ingest lock and reparse.lock: 0 for nobody, else the process number plus one. */
  ingest: number;
  run: number;
  /** Lines the hook has still to append, and lines appended and not stored. */
  lines: number;
  spool: number;
  procs: Proc[];
  crashes: number;
  failures: number;
}

/** A reprice pass can throw here: before a session's costs are set, or at the cursor. */
const THROWS: readonly Pc[] = ["reprice read", "reprice set", "reprice cursor"];
/** Between a session's new costs and its row: no crash or throw here (see "Left out"). */
const WINDOW: ReadonlySet<Pc> = new Set(["reprice rebuild", "reprice upsert"]);
const SESSIONS: readonly number[] = Array.from({ length: N }, (_, i) => i);

const copyRow = (r: Row): Row => ({ fold: r.fold, seen: r.seen, usage: [...r.usage] });
const clone = (s: St): St => ({
  ...s,
  ev: s.ev.map((e) => [...e]),
  rows: s.rows.map(copyRow),
  folds: s.folds.map((f) => (f ? { v: f.v, made: f.made, prices: [...f.prices] } : null)),
  after: s.after ? { ...s.after } : null,
  procs: s.procs.map((p) => ({
    ...p,
    snap: p.snap ? p.snap.map(copyRow) : null,
    costs: [...p.costs],
    built: p.built ? [...p.built] : null,
    ids: [...p.ids],
    read: p.read ? { ...p.read, prices: [...p.read.prices] } : null,
  })),
});

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`no ${what}`);
  return v;
}

const proc = (s: St, p: number): Proc => must(s.procs[p], `process ${p}`);
const events = (s: St, id: number): Ver[] => must(s.ev[id], `session ${id}`);
const allDone = (s: St): boolean => s.procs.every((x) => x.pc === "done");
/** The session a refold step works on. */
const target = (me: Proc): number => must(me.ids[me.i], "session to fold");
const rowOf = (r: Read): Row => ({ fold: r.made, seen: r.prices.length, usage: [...r.prices] });
const fresh = (next: boolean): Proc => ({ pc: "reprice list", i: 0, snap: null, costs: [], built: null, ids: [], read: null, next });

/** One key per state. */
function keyOf(s: St): string {
  const vs = (a: readonly Ver[]): string => a.join("");
  const row = (r: Row): string => `${r.fold}.${r.seen}.${vs(r.usage)}`;
  const parts: string[] = [
    s.ev.map(vs).join(","),
    s.rows.map(row).join(","),
    s.folds.map((f) => (f ? `${f.v}${f.made}.${vs(f.prices)}` : "-")).join(","),
    [s.refold, s.reprice, s.after ? `${s.after.v}.${s.after.id}` : "-", s.ingest, s.run, s.lines, s.spool, s.crashes, s.failures].join("/"),
  ];
  for (const p of s.procs) {
    if (p.pc === "done") parts.push("done");
    else parts.push([p.pc, p.i, p.snap ? p.snap.map(row).join(",") : "-", p.costs.join(""), p.built ? vs(p.built) : "-", p.ids.join(""), p.read ? `${p.read.made}.${vs(p.read.prices)}.${+p.read.save}` : "-"].join("|"));
  }
  return parts.join(" ");
}

function refoldModel(cfg: Config): Model<St> {
  const actions: Action<St>[] = [];
  const total = cfg.procs + 1;
  /** foldStoredSession: the saved fold and the events after it when its stamp is this build's, else every event. */
  const foldRead = (s: St, id: number): Read => {
    const f = s.folds[id];
    const e = events(s, id);
    if (f && (f.v === CUR || cfg.mutant === "a saved fold read whatever its stamp")) {
      const tail = e.slice(f.prices.length);
      return { made: f.made, prices: [...f.prices, ...tail], save: tail.length > 0 };
    }
    return { made: CUR, prices: [...e], save: true };
  };
  const putFold = (d: St, id: number, r: Read): void => {
    if (r.save) d.folds[id] = { v: CUR, made: r.made, prices: [...r.prices] };
  };
  /** Whether process p may take a step: the next run waits for the others and the hook's last line; in sequence, each waits for those before it. */
  const mayRun = (s: St, p: number, me: Proc): boolean => {
    if (me.next) return s.lines === 0 && s.procs.every((x, j) => j === p || x.pc === "done");
    return !cfg.sequential || s.procs.every((x, j) => j >= p || x.pc === "done");
  };

  for (let p = 0; p < total; p++) {
    const next = p === cfg.procs;
    const who = next ? "next run" : `p${p}`;
    const step = (name: string, pc: Pc, when: (s: St, me: Proc) => boolean, effect: (d: St, me: Proc) => void): void => {
      actions.push({
        name: `${who} ${name}`,
        guard: (s) => {
          const me = proc(s, p);
          return me.pc === pc && mayRun(s, p, me) && when(s, me);
        },
        effect: (s) => {
          const d = clone(s);
          effect(d, proc(d, p));
          return d;
        },
      });
    };
    const endPass = (me: Proc): void => {
      Object.assign(me, { i: 0, snap: null, costs: [], built: null, pc: "ingest lock" });
    };
    const nextSession = (me: Proc): void => {
      Object.assign(me, { i: me.i + 1, costs: [], built: null, pc: me.i + 1 < N ? "reprice read" : "reprice cursor" });
    };
    const oldCosts = (s: St, me: Proc): number[] => events(s, me.i).flatMap((v, j) => (v === CUR ? [] : [j]));

    // repriceStored, once per process at store open.
    step("finds the prices current", "reprice list", (s) => s.reprice === CUR, (_d, me) => void (me.pc = "ingest lock"));
    step("lists the session rows to reprice", "reprice list", (s) => s.reprice !== CUR, (d, me) => {
      me.snap = d.rows.map(copyRow);
      me.pc = "reprice read";
    });
    step("finds a session priced", "reprice read", (s, me) => oldCosts(s, me).length === 0, (_d, me) => nextSession(me));
    step("reads a session's old costs", "reprice read", (s, me) => oldCosts(s, me).length > 0, (d, me) => {
      me.costs = oldCosts(d, me);
      me.pc = "reprice set";
    });
    step("sets the new costs", "reprice set", () => true, (d, me) => {
      const e = events(d, me.i);
      for (const j of me.costs) e[j] = CUR;
      if (cfg.mutant !== "costs set without dropping the fold") d.folds[me.i] = null;
      me.pc = "reprice rebuild";
    });
    step("folds the session's events for its usage", "reprice rebuild", () => true, (d, me) => {
      me.built = [...events(d, me.i)];
      me.pc = "reprice upsert";
    });
    step("writes the listed row with the new usage", "reprice upsert", () => true, (d, me) => {
      const prev = must(me.snap?.[me.i], "listed row");
      d.rows[me.i] = { fold: prev.fold, seen: prev.seen, usage: [...must(me.built, "usage")] };
      nextSession(me);
    });
    step("sets the reprice cursor", "reprice cursor", () => true, (d, me) => {
      d.reprice = CUR;
      endPass(me);
    });

    // The ingest, with waitMs 0.
    step("finds the ingest lock held", "ingest lock", (s) => s.ingest !== 0, (_d, me) => void (me.pc = "done"));
    step("takes the ingest lock", "ingest lock", (s) => s.ingest === 0, (d, me) => {
      d.ingest = p + 1;
      me.pc = "ingest store";
    });
    step("finds the spool empty", "ingest store", (s) => s.spool === 0, (_d, me) => void (me.pc = "ingest release"));
    step("stores the spool's lines and folds their session", "ingest store", (s) => s.spool > 0, (d, me) => {
      for (; d.spool > 0; d.spool--) events(d, 0).push(CUR);
      const r = foldRead(d, 0);
      putFold(d, 0, r);
      d.rows[0] = rowOf(r);
      me.pc = "ingest release";
    });
    step("releases the ingest lock", "ingest release", () => true, (d, me) => {
      d.ingest = 0;
      me.pc = "refold due";
    });

    // reparseDue and reparse: the refold.
    step("finds the fold current", "refold due", (s) => s.refold === CUR, (_d, me) => void (me.pc = "done"));
    step("finds a refold due", "refold due", (s) => s.refold !== CUR, (_d, me) => void (me.pc = "run lock"));
    step("finds reparse.lock held", "run lock", (s) => s.run !== 0, (_d, me) => void (me.pc = "done"));
    step("takes reparse.lock", "run lock", (s) => s.run === 0, (d, me) => {
      d.run = p + 1;
      me.pc = "refold start";
    });
    step("finds the fold current under reparse.lock", "refold start", (s) => s.refold === CUR, (_d, me) => void (me.pc = "run release"));
    step("lists the sessions after its saved progress", "refold start", (s) => s.refold !== CUR, (d, me) => {
      const a = d.after && (d.after.v === CUR || cfg.mutant === "progress read whatever its stamp") ? d.after.id : -1;
      me.ids = SESSIONS.filter((id) => id > a);
      me.i = 0;
      me.pc = me.ids.length ? "chunk lock" : "refold cursor";
    });
    step("takes the ingest lock for a session", "chunk lock", (s) => s.ingest === 0, (d, me) => {
      d.ingest = p + 1;
      me.pc = cfg.mutant === "progress saved before the fold" ? "progress" : "refold read";
    });
    if (!next) {
      step("stops waiting for the ingest lock", "chunk lock", (s) => s.ingest !== 0, (_d, me) => {
        Object.assign(me, { ids: [], i: 0, pc: "run release" });
      });
    }
    step("reads the session's saved fold and events", "refold read", () => true, (d, me) => {
      me.read = foldRead(d, target(me));
      me.pc = me.read.save ? "refold put" : "refold write";
    });
    step("saves the fold", "refold put", () => true, (d, me) => {
      putFold(d, target(me), must(me.read, "fold"));
      me.pc = "refold write";
    });
    step("writes the folded row", "refold write", () => true, (d, me) => {
      d.rows[target(me)] = rowOf(must(me.read, "fold"));
      me.read = null;
      me.pc = cfg.mutant === "progress saved before the fold" ? "chunk release" : "progress";
    });
    step("saves its progress", "progress", () => true, (d, me) => {
      d.after = { v: CUR, id: target(me) };
      me.pc = cfg.mutant === "progress saved before the fold" ? "refold read" : "chunk release";
    });
    step("releases the ingest lock after the session", "chunk release", () => true, (d, me) => {
      d.ingest = 0;
      me.i++;
      me.pc = me.i < me.ids.length ? "chunk lock" : "refold cursor";
    });
    step("sets the refold cursor", "refold cursor", () => true, (d, me) => {
      d.refold = CUR;
      me.pc = "refold clear";
    });
    step("clears its progress", "refold clear", () => true, (d, me) => {
      d.after = null;
      me.pc = "run release";
    });
    step("releases reparse.lock", "run release", () => true, (d, me) => {
      d.run = 0;
      Object.assign(me, { ids: [], i: 0, pc: "done" });
    });

    if (next) continue;
    for (const pc of THROWS) {
      step("has its reprice pass throw", pc, (s) => s.failures > 0, (d, me) => {
        d.failures--;
        endPass(me);
      });
    }
    actions.push({
      name: `${who} crashes`,
      guard: (s) => {
        const me = proc(s, p);
        return s.crashes > 0 && me.pc !== "done" && !WINDOW.has(me.pc) && mayRun(s, p, me);
      },
      effect: (s) => {
        const d = clone(s);
        d.crashes--;
        if (d.ingest === p + 1) d.ingest = 0;
        if (d.run === p + 1) d.run = 0;
        d.procs[p] = { ...fresh(false), pc: "done" };
        return d;
      },
    });
  }
  actions.push({
    name: "the hook appends a line",
    guard: (s) => s.lines > 0,
    effect: (s) => {
      const d = clone(s);
      d.lines--;
      d.spool++;
      return d;
    },
  });

  const price: Ver = cfg.priceBump ? 0 : CUR;
  const fold: Ver = cfg.foldBump ? 0 : CUR;
  return {
    init: {
      ev: SESSIONS.map(() => [price]),
      rows: SESSIONS.map(() => ({ fold, seen: 1, usage: [price] })),
      folds: SESSIONS.map(() => ({ v: fold, made: fold, prices: [price] })),
      refold: fold,
      reprice: price,
      after: cfg.staleAfter ? { v: 0, id: 0 } : null,
      ingest: 0,
      run: 0,
      lines: cfg.lines,
      spool: 0,
      procs: Array.from({ length: total }, (_, j) => fresh(j === cfg.procs)),
      crashes: cfg.crashes,
      failures: cfg.failures,
    },
    actions,
    key: keyOf,
    invariants: {
      "a current refold cursor means every row has the current fold": (s) => {
        const i = s.refold === CUR ? s.rows.findIndex((r) => r.fold !== CUR) : -1;
        return i < 0 || `REFOLD_CURSOR is current and session ${i}'s row has the old fold`;
      },
      "a current reprice cursor means every event has the new prices": (s) => {
        const i = s.reprice === CUR ? s.ev.findIndex((e) => e.some((v) => v !== CUR)) : -1;
        return i < 0 || `REPRICE_CURSOR is current and session ${i} has an event at the old prices`;
      },
      "a saved fold of this build holds its events' prices": (s) => {
        for (const [i, f] of s.folds.entries()) {
          if (!f || f.v !== CUR) continue;
          if (f.made !== CUR) return `session ${i}'s saved fold has this build's stamp and the old fold`;
          const e = events(s, i);
          if (f.prices.some((v, j) => v !== e[j])) return `session ${i}'s saved fold holds prices ${f.prices.join("")} and its events ${e.join("")}`;
        }
        return true;
      },
      "after the last run every row is current": (s) => {
        if (!allDone(s)) return true;
        if (s.refold !== CUR || s.reprice !== CUR) return `REFOLD_CURSOR ${s.refold}, REPRICE_CURSOR ${s.reprice}`;
        if (s.spool) return `${s.spool} line(s) left in the spool`;
        for (const [i, r] of s.rows.entries()) {
          const e = events(s, i);
          if (r.fold !== CUR) return `session ${i}'s row has the old fold`;
          if (r.seen !== e.length) return `session ${i}'s row counts ${r.seen} of its ${e.length} events`;
          if (e.some((v) => v !== CUR)) return `session ${i} has an event at the old prices`;
          if (r.usage.length !== e.length || r.usage.some((v) => v !== CUR)) return `session ${i}'s usage sums prices ${r.usage.join("")} for events ${e.join("")}`;
        }
        return true;
      },
    },
    final: allDone,
  };
}

function boundFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.CODING_SH_MODEL_BOUND ?? "0";
  const extra = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${raw}`);
  return extra;
}

const extra = boundFrom(process.env);

function labelOf(cfg: Config): string {
  const bumps = [cfg.foldBump ? "a new fold version" : "", cfg.priceBump ? "new prices" : ""].filter(Boolean).join(" and ");
  const how = cfg.sequential ? "one at a time" : "at once";
  const parts = [`${bumps}, ${cfg.procs} process(es) ${how}`, `${cfg.lines} hook line(s)`, `${cfg.crashes} crash(es)`, `${cfg.failures} reprice failure(s)`];
  if (cfg.staleAfter) parts.push("old progress");
  if (cfg.mutant) parts.push(`mutant "${cfg.mutant}"`);
  return parts.join(", ");
}

/** Checks one configuration, and prints its size and the trace of anything it found. */
function run(t: { diagnostic: (m: string) => void }, cfg: Config): CheckResult<St> {
  const t0 = performance.now();
  const r = check(refoldModel(cfg));
  t.diagnostic(`${labelOf(cfg)}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(performance.now() - t0)} ms`);
  const bad = r.violation ?? r.deadlock;
  if (bad && !cfg.mutant) t.diagnostic(`${r.violation ? `${r.violation.invariant}: ${r.violation.message ?? ""}` : "deadlock"}\n${formatTrace(bad.trace, keyOf)}`);
  return r;
}

/** The model with one invariant that names a state it must reach, so a pass is not vacuous. */
function reaches(cfg: Config, name: string, at: (s: St) => boolean): CheckResult<St> {
  return check({ ...refoldModel(cfg), invariants: { [name]: (s) => !at(s) } });
}

test("after a new fold version, refolds that race, crash and stop part way leave every row current", (t) => {
  const cfg: Config = { procs: 2 + extra, foldBump: true, priceBump: false, lines: 1 + extra, crashes: 1 + extra, failures: 0, staleAfter: true };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 1_500, `${r.states} states`);
  // A crash stops a refold after it saved progress, and the next run goes on from there (with one
  // process, nothing else holds the ingest lock, so only a crash stops it).
  const resumed = reaches({ ...cfg, procs: 1 }, "a refold resumes", (s) => s.procs.some((x) => x.pc === "chunk lock" && x.ids.length === 1)).violation?.trace;
  assert.ok(resumed, "a refold resumes after saved progress");
  assert.ok(actionsOf(resumed).some((a) => a.endsWith("crashes")));
  // A refold gives up waiting for the ingest lock part way and leaves its progress.
  const gaveUp = reaches(cfg, "a refold gives up", (s) => s.refold !== CUR && s.after?.v === CUR && s.procs.some((x) => x.pc === "run release")).violation;
  assert.ok(gaveUp, "a refold stops while another process holds the ingest lock");
  // The ingest folds a session while a refold is part way.
  const between = reaches(cfg, "an ingest between two sessions", (s) => s.procs.some((x) => x.pc === "ingest release") && s.procs.some((x) => x.pc === "chunk lock" && x.i === 1)).violation;
  assert.ok(between, "an ingest runs between two sessions of a refold");
});

test("after new prices, reprice passes at once leave every event and row at the new prices", (t) => {
  const cfg: Config = { procs: 2 + extra, foldBump: false, priceBump: true, lines: 0, crashes: 1, failures: 1 };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 1_000, `${r.states} states`);
  const both = reaches(cfg, "two passes at once", (s) => s.procs.filter((x) => x.snap !== null).length === 2).violation;
  assert.ok(both, "two reprice passes overlap");
});

test("after both, processes one at a time leave every row current through a crash and a reprice pass that throws", (t) => {
  const cfg: Config = { procs: 2 + extra, foldBump: true, priceBump: true, lines: 1 + extra, crashes: 1 + extra, failures: 1, sequential: true };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 2_000, `${r.states} states`);
  // A refold that runs before the reprice saves folds of the old prices, and the reprice drops them.
  const dropped = reaches(cfg, "a fold of old prices dropped", (s) => s.refold === CUR && s.folds.some((f) => f === null)).violation;
  assert.ok(dropped, "the reprice drops a fold the refold saved");
});

test("each check the code makes on purpose breaks an invariant when left out", (t) => {
  const base = { procs: 1, lines: 0, crashes: 0, failures: 0 };
  for (const [mutant, cfg, invariant] of [
    ["progress read whatever its stamp", { ...base, foldBump: true, priceBump: false, staleAfter: true }, "a current refold cursor means every row has the current fold"],
    ["a saved fold read whatever its stamp", { ...base, foldBump: true, priceBump: false }, "a current refold cursor means every row has the current fold"],
    ["costs set without dropping the fold", { ...base, foldBump: false, priceBump: true }, "a saved fold of this build holds its events' prices"],
    ["progress saved before the fold", { ...base, foldBump: true, priceBump: false, crashes: 1 }, "a current refold cursor means every row has the current fold"],
  ] as const) {
    const v = run(t, { ...cfg, mutant }).violation;
    assert.ok(v, mutant);
    assert.equal(v.invariant, invariant, mutant);
  }
});
