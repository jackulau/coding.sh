// A model of the refold and the reprice after an upgrade, checked with test/_model.ts. A build with a
// new SESSION_FOLD_VERSION (core/sessions.ts:590) folds every stored session again, and one with new
// prices (core/pricing.ts) prices the stored events again. Background ingests do both, two at once,
// and any of them can crash part way.
//
// A process is a background ingest of the home's index (cli/commands/ingest.ts:82-96), and each step
// is one in the code (paths under packages/coding.sh/src):
// - Opening the index leaves a due reprice to the run (store/factory.ts:186-198; repriceDeferred
//   :214-220 holds for the home's own index while background ingests are on), and the run takes it up
//   while REPRICE_CURSOR is not the price stamp (core/reprice.ts:178-184). So in the model a reprice
//   is due while the cursor is stale.
// - The ingest takes the ingest lock with waitMs 0 (core/ingest.ts:286); when another process holds
//   it, the run ends (cli/commands/ingest.ts:95). It stores the spool's lines, priced at the new
//   prices, and folds their session in one transaction (core/ingest.ts:564-590).
// - A run is due while a reprice is or REFOLD_CURSOR is not this build's foldStamp() (reparseDue,
//   core/reparse.ts:258-264). reparse takes reparse.lock with waitMs 0 (:395-401); when it is held,
//   the run ends (cli/commands/ingest.ts:92). It reads once whether it reprices (:424).
// - With REFOLD_CURSOR stale (:764), refold (:702-730) reads its saved progress, REFOLD_AFTER, used
//   only when its stamp is this build's (:703-709), and handles each session after it under the
//   ingest lock (underLock :613-630), saving its progress after every 100th (:727). A session in the
//   model stands for those 100, so it saves after each one. Waiting for the ingest lock can run out
//   (30 s), which ends the run. A run that reprices sets a session's new costs right before its fold
//   (:718; repriceEvents, core/reprice.ts:120-152). That is one setEventCosts, which is one
//   transaction that also drops the session's saved fold (store/sqlite.ts:1271-1290). A session whose
//   costs changed is owed its totals until its fold is written (:721). Then the refold sets the
//   cursor and clears its progress (:766-767).
// - The fold of one session (recomputeSession, core/ingest.ts:1308-1358) reads the saved fold, used
//   only when its stamp is this build's (readFold :1571-1579), and the events after it; saves the fold
//   again when it folded anything new (foldStoredSession :1594-1630, :1622); and writes the row.
// - A run that reprices ends with repriceRest (core/reparse.ts:738-758, called at :776). It refreshes
//   the totals of each owed session under the ingest lock (:739-746; refreshTotals,
//   core/reprice.ts:159-163, reads the row and the events and writes the row with only its usage
//   replaced). Unless a session's reprice threw (:747), the pass follows (repriceStored :72-102,
//   called at :749-754). It stops if REPRICE_CURSOR holds the price stamp (:77). Otherwise it lists
//   the sessions the refold did not reprice (:87), and for each, under the ingest lock, sets the new
//   costs on its events and refreshes its totals (repriceSession :125-152). Then it sets the cursor
//   (:97). An error ends the pass without the cursor (:755-757). The run releases reparse.lock (:405).
// The store is SQLite: a statement or a transaction is one step (BEGIN IMMEDIATE, store/sqlite.ts
// :969-985). The hook appends lines for one session at any time. The run after the last line (the one
// that line kicks) runs alone at the end, and neither crashes nor fails.
//
// Checked: a current REFOLD_CURSOR means every row has this build's fold; a current REPRICE_CURSOR
// means every event has the new prices; a saved fold stamped by this build was made by this build's
// fold and holds its events' current prices; and after the last run every row has the current fold,
// counts every event and sums the new prices. Seven mutants show that each of these is needed: the
// two stamp checks, the fold drop, the progress save after the fold, the reprice before the fold, the
// check for a failed reprice before the cursor, and the due check for a reprice the open left.
//
// Left out: stores without transactions or saved folds (the memory store, the Postgres and ClickHouse
// plugins); the re-parse from transcripts that comes before the refold, and the transcript read after
// the spool (cli/commands/ingest.ts:88); the check before a fold writes a row that no event was stored
// since its read (core/ingest.ts:1348-1352), which never fires here, since only the ingest stores
// events and it cannot take the ingest lock while the refold holds it (so the refold's fold always
// pays what its session was owed); a fold or a totals refresh that throws (each is reported and the
// run goes on, core/reparse.ts:723-725 and :740-744); a session refolded for totals that predate the
// estimated part (`unmarked`, core/reprice.ts:147); several sessions per lock hold (one per hold lets
// other processes in more often); a crashed process's locks, which the model frees at once
// (test/verify/lock-model.test.ts checks how a stale lock is broken); spans, which keep no saved fold;
// FOLD_LAG_MS (the model saves every event in the fold); and two builds running at once. Two more cases
// are left out of the runs: a reprice pass on open, which runs where no background ingest will reprice
// (store/factory.ts:199-206) and holds reparse.lock but not the ingest lock; and a crash or throw
// between a session's new costs and its totals in the pass. The invariants do not hold there yet, and
// the cases went to the code's owners.
//
// Bounds: two sessions, two processes and the run after them, one hook line, one crash and one
// reprice that throws. Two sessions are the fewest where saved progress skips a session and where the
// pass leaves out a session the refold repriced, two processes the fewest for a race, and one crash
// is enough to stop a refold or a pass part way. CODING_SH_MODEL_BOUND=n adds n processes to each run,
// and n hook lines and n crashes to the runs with a new fold version, which checks a refold stopped
// more than once and three or more runs racing for the locks. The three runs explore 1,464, 1,993
// and 1,822 states at the default bound, 26,306, 17,678 and 8,146 at 1 (about 2 s), and 336,808,
// 133,437 and 21,438 at 2 (about 22 s). At 3 the first run passes check's cap of a million states,
// and the test fails on `complete` rather than pass a search it cut short.
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

/** What refreshTotals read: the row, and the prices of the events it folds for the new usage. */
interface Totals {
  cur: Row;
  built: Ver[];
}

type Pc =
  | "ingest lock"
  | "ingest store"
  | "ingest release"
  | "due"
  | "run lock"
  | "run start"
  | "refold start"
  | "chunk lock"
  | "refold reprice"
  | "refold read"
  | "refold put"
  | "refold write"
  | "progress"
  | "chunk release"
  | "refold cursor"
  | "refold clear"
  | "owed lock"
  | "owed read"
  | "owed write"
  | "pass start"
  | "pass lock"
  | "pass set"
  | "pass read"
  | "pass write"
  | "reprice cursor"
  | "run release"
  | "done";

/** Changes to the code that the invariants must catch. */
type Mutant =
  | "progress read whatever its stamp"
  | "a saved fold read whatever its stamp"
  | "costs set without dropping the fold"
  | "progress saved before the fold"
  | "the refold reprices after its fold"
  | "the cursor set after a failed reprice"
  | "a reprice the open left not counted as due";

interface Config {
  procs: number;
  /** SESSION_FOLD_VERSION changed: rows, saved folds and REFOLD_CURSOR start at the old version. */
  foldBump: boolean;
  /** The prices changed: stored events and REPRICE_CURSOR start at the old prices. */
  priceBump: boolean;
  /** Lines the hook appends for session 0 while the processes run. */
  lines: number;
  crashes: number;
  /** Reprices that throw: a session's before its fold, or the pass's. */
  failures: number;
  /** The processes run one after another instead of at once. */
  sequential?: boolean;
  /** REFOLD_AFTER left by an older build's refold that stopped after session 0. */
  staleAfter?: boolean;
  mutant?: Mutant;
}

interface Proc {
  pc: Pc;
  /** The sessions the run works through (the refold's, the owed ones, then the pass's), and the position in them. */
  ids: number[];
  i: number;
  read: Read | null;
  totals: Totals | null;
  /** Whether the run reprices, read once under reparse.lock. */
  repricing: boolean;
  /** Sessions as bits: the ones the refold repriced, and of those the ones owed their totals. */
  repriced: number;
  owed: number;
  /** A session's reprice threw. */
  failed: boolean;
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

/** The pass can throw at these steps: its list, a session's new costs, or the cursor. */
const THROWS: readonly Pc[] = ["pass start", "pass set", "reprice cursor"];
/** Between a session's new costs and its totals in the pass: no crash or throw here (see "Left out"). */
const WINDOW: ReadonlySet<Pc> = new Set(["pass read", "pass write"]);
/** The steps of the pass, where a run reprices the sessions its refold did not. */
const PASS: ReadonlySet<Pc> = new Set(["pass start", "pass lock", "pass set", "pass read", "pass write", "reprice cursor"]);
const SESSIONS: readonly number[] = Array.from({ length: N }, (_, i) => i);
const ALL = (1 << N) - 1;
const bit = (id: number): number => 1 << id;

const copyRow = (r: Row): Row => ({ fold: r.fold, seen: r.seen, usage: [...r.usage] });
const clone = (s: St): St => ({
  ...s,
  ev: s.ev.map((e) => [...e]),
  rows: s.rows.map(copyRow),
  folds: s.folds.map((f) => (f ? { v: f.v, made: f.made, prices: [...f.prices] } : null)),
  after: s.after ? { ...s.after } : null,
  procs: s.procs.map((p) => ({
    ...p,
    ids: [...p.ids],
    read: p.read ? { ...p.read, prices: [...p.read.prices] } : null,
    totals: p.totals ? { cur: copyRow(p.totals.cur), built: [...p.totals.built] } : null,
  })),
});

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`no ${what}`);
  return v;
}

const proc = (s: St, p: number): Proc => must(s.procs[p], `process ${p}`);
const events = (s: St, id: number): Ver[] => must(s.ev[id], `session ${id}`);
const rowAt = (s: St, id: number): Row => must(s.rows[id], `row ${id}`);
const allDone = (s: St): boolean => s.procs.every((x) => x.pc === "done");
/** The session a step works on. */
const target = (me: Proc): number => must(me.ids[me.i], "session");
const rowOf = (r: Read): Row => ({ fold: r.made, seen: r.prices.length, usage: [...r.prices] });
const oldCosts = (s: St, id: number): boolean => events(s, id).some((v) => v !== CUR);
const fresh = (next: boolean): Proc => ({ pc: "ingest lock", ids: [], i: 0, read: null, totals: null, repricing: false, repriced: 0, owed: 0, failed: false, next });

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
    else {
      const read = p.read ? `${p.read.made}.${vs(p.read.prices)}.${+p.read.save}` : "-";
      const totals = p.totals ? `${row(p.totals.cur)}>${vs(p.totals.built)}` : "-";
      parts.push([p.pc, p.ids.join(""), p.i, read, totals, +p.repricing, p.repriced, p.owed, +p.failed].join("|"));
    }
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
  /** setEventCosts: the new cost on each of the session's events at the old prices, in one transaction that drops its saved fold. True when a cost changed. */
  const setCosts = (d: St, id: number): boolean => {
    if (!oldCosts(d, id)) return false;
    events(d, id).fill(CUR);
    if (cfg.mutant !== "costs set without dropping the fold") d.folds[id] = null;
    return true;
  };
  /** refreshTotals' write: the row it read, with only its usage replaced (withUsage). */
  const writeTotals = (d: St, me: Proc): void => {
    const t = must(me.totals, "totals");
    d.rows[target(me)] = { fold: t.cur.fold, seen: t.cur.seen, usage: [...t.built] };
    me.totals = null;
  };
  /** Whether process p may take a step: the next run waits for the others and the hook's last line; in sequence, each waits for those before it. */
  const mayRun = (s: St, p: number, me: Proc): boolean => {
    if (me.next) return s.lines === 0 && s.procs.every((x, j) => j === p || x.pc === "done");
    return !cfg.sequential || s.procs.every((x, j) => j >= p || x.pc === "done");
  };
  /** A run is due while a refold is, or a reprice the open left to it (repricePending: the cursor is stale). */
  const due = (s: St): boolean => s.refold !== CUR || (s.reprice !== CUR && cfg.mutant !== "a reprice the open left not counted as due");
  /** One session's steps in the refold, in the code's order. */
  const order: readonly Pc[] =
    cfg.mutant === "the refold reprices after its fold"
      ? ["refold read", "refold put", "refold write", "refold reprice", "progress"]
      : cfg.mutant === "progress saved before the fold"
        ? ["refold reprice", "progress", "refold read", "refold put", "refold write"]
        : ["refold reprice", "refold read", "refold put", "refold write", "progress"];
  /** The step after `from` in a session's refold (the reprice only in a run that reprices, the fold's save only when it folded something new), and after the last the lock's release. */
  const stepAfter = (me: Proc, from: Pc | null): Pc => {
    for (let k = from === null ? 0 : order.indexOf(from) + 1; k < order.length; k++) {
      const pc = order[k];
      if (pc === undefined) break;
      if (pc === "refold reprice" && !me.repricing) continue;
      if (pc === "refold put" && !me.read?.save) continue;
      return pc;
    }
    return "chunk release";
  };
  /** The run goes on to release reparse.lock, leaving the rest of its work. */
  const quit = (me: Proc): void => {
    me.ids = [];
    me.i = 0;
    me.totals = null;
    me.pc = "run release";
  };
  /** After the owed sessions: the pass, unless a session's reprice threw. */
  const toPass = (me: Proc): void => {
    me.owed = 0;
    quit(me);
    if (!me.failed || cfg.mutant === "the cursor set after a failed reprice") me.pc = "pass start";
  };
  /** repriceRest: the owed sessions' totals, then the pass. */
  const rest = (me: Proc): void => {
    const owed = SESSIONS.filter((id) => (me.owed & bit(id)) !== 0);
    if (!owed.length) return toPass(me);
    me.ids = owed;
    me.i = 0;
    me.pc = "owed lock";
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
    /** The next session of the pass, after the ingest lock is released. */
    const nextInPass = (d: St, me: Proc): void => {
      d.ingest = 0;
      me.i++;
      me.pc = me.i < me.ids.length ? "pass lock" : "reprice cursor";
    };

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
      me.pc = "due";
    });

    // reparseDue and reparse.
    step("finds nothing due", "due", (s) => !due(s), (_d, me) => void (me.pc = "done"));
    step("finds a refold or a reprice due", "due", due, (_d, me) => void (me.pc = "run lock"));
    step("finds reparse.lock held", "run lock", (s) => s.run !== 0, (_d, me) => void (me.pc = "done"));
    step("takes reparse.lock", "run lock", (s) => s.run === 0, (d, me) => {
      d.run = p + 1;
      me.pc = "run start";
    });
    step("reads the cursors under reparse.lock", "run start", () => true, (d, me) => {
      me.repricing = d.reprice !== CUR;
      if (d.refold !== CUR) me.pc = "refold start";
      else if (me.repricing) rest(me);
      else quit(me);
    });

    // The refold.
    step("lists the sessions after its saved progress", "refold start", () => true, (d, me) => {
      const a = d.after && (d.after.v === CUR || cfg.mutant === "progress read whatever its stamp") ? d.after.id : -1;
      me.ids = SESSIONS.filter((id) => id > a);
      me.i = 0;
      me.pc = me.ids.length ? "chunk lock" : "refold cursor";
    });
    step("takes the ingest lock for a session", "chunk lock", (s) => s.ingest === 0, (d, me) => {
      d.ingest = p + 1;
      me.pc = stepAfter(me, null);
    });
    step("sets the session's new costs", "refold reprice", () => true, (d, me) => {
      const id = target(me);
      me.repriced |= bit(id);
      if (setCosts(d, id)) me.owed |= bit(id);
      me.pc = stepAfter(me, "refold reprice");
    });
    step("reads the session's saved fold and events", "refold read", () => true, (d, me) => {
      me.read = foldRead(d, target(me));
      me.pc = stepAfter(me, "refold read");
    });
    step("saves the fold", "refold put", () => true, (d, me) => {
      putFold(d, target(me), must(me.read, "fold"));
      me.pc = stepAfter(me, "refold put");
    });
    step("writes the folded row", "refold write", () => true, (d, me) => {
      const id = target(me);
      d.rows[id] = rowOf(must(me.read, "fold"));
      me.owed &= ~bit(id);
      me.read = null;
      me.pc = stepAfter(me, "refold write");
    });
    step("saves its progress", "progress", () => true, (d, me) => {
      d.after = { v: CUR, id: target(me) };
      me.pc = stepAfter(me, "progress");
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
      if (me.repricing) rest(me);
      else quit(me);
    });

    // repriceRest: the owed sessions' totals.
    step("takes the ingest lock for an owed session", "owed lock", (s) => s.ingest === 0, (d, me) => {
      d.ingest = p + 1;
      me.pc = "owed read";
    });
    step("reads an owed session's row and events", "owed read", () => true, (d, me) => {
      const id = target(me);
      me.totals = { cur: copyRow(rowAt(d, id)), built: [...events(d, id)] };
      me.pc = "owed write";
    });
    step("writes the owed session's totals", "owed write", () => true, (d, me) => {
      writeTotals(d, me);
      d.ingest = 0;
      me.i++;
      if (me.i < me.ids.length) me.pc = "owed lock";
      else toPass(me);
    });

    // repriceRest: the pass over the sessions the refold did not reprice.
    step("finds the prices current", "pass start", (s) => s.reprice === CUR, (_d, me) => quit(me));
    step("lists the sessions the refold did not reprice", "pass start", (s) => s.reprice !== CUR, (_d, me) => {
      me.ids = SESSIONS.filter((id) => (me.repriced & bit(id)) === 0);
      me.i = 0;
      me.pc = me.ids.length ? "pass lock" : "reprice cursor";
    });
    step("takes the ingest lock for a session to reprice", "pass lock", (s) => s.ingest === 0, (d, me) => {
      d.ingest = p + 1;
      me.pc = "pass set";
    });
    step("finds a session priced", "pass set", (s, me) => !oldCosts(s, target(me)), (d, me) => nextInPass(d, me));
    step("sets a session's new costs", "pass set", (s, me) => oldCosts(s, target(me)), (d, me) => {
      setCosts(d, target(me));
      me.pc = "pass read";
    });
    step("reads the session's row and events", "pass read", () => true, (d, me) => {
      const id = target(me);
      me.totals = { cur: copyRow(rowAt(d, id)), built: [...events(d, id)] };
      me.pc = "pass write";
    });
    step("writes the session's totals", "pass write", () => true, (d, me) => {
      writeTotals(d, me);
      nextInPass(d, me);
    });
    step("sets the reprice cursor", "reprice cursor", () => true, (d, me) => {
      d.reprice = CUR;
      quit(me);
    });
    step("releases reparse.lock", "run release", () => true, (d, me) => {
      d.run = 0;
      Object.assign(me, fresh(next), { pc: "done" });
    });

    if (next) continue;
    // Waiting 30 s for the ingest lock runs out: in the refold or the owed sessions the run throws,
    // and in the pass the pass does; either way the run releases reparse.lock without the cursor.
    for (const pc of ["chunk lock", "owed lock", "pass lock"] as const) {
      step("stops waiting for the ingest lock", pc, (s) => s.ingest !== 0, (_d, me) => quit(me));
    }
    step("has the session's reprice throw", "refold reprice", (s) => s.failures > 0, (d, me) => {
      d.failures--;
      me.repriced |= bit(target(me));
      me.failed = true;
      me.pc = stepAfter(me, "refold reprice");
    });
    for (const pc of THROWS) {
      step("has its reprice pass throw", pc, (s) => s.failures > 0, (d, me) => {
        d.failures--;
        if (d.ingest === p + 1) d.ingest = 0;
        quit(me);
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
  assert.ok(r.states >= 1_000, `${r.states} states`);
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

test("after new prices, runs at once reprice every event and row once, through a crash and a pass that throws", (t) => {
  const cfg: Config = { procs: 2 + extra, foldBump: false, priceBump: true, lines: 1, crashes: 1, failures: 1 };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 1_400, `${r.states} states`);
  // The ingest stores and folds a session between two sessions of the pass.
  const between = reaches(cfg, "an ingest between two sessions of the pass", (s) => s.procs.some((x) => x.pc === "ingest release") && s.procs.some((x) => x.pc === "pass lock" && x.i === 1)).violation;
  assert.ok(between, "an ingest runs between two sessions of the pass");
  // A second run comes while a pass runs, and finds reparse.lock held: two passes never overlap.
  const arrives = reaches(cfg, "a run comes during a pass", (s) => s.procs.some((x) => x.pc === "run lock") && s.procs.some((x) => PASS.has(x.pc))).violation;
  assert.ok(arrives, "a second run comes while a pass runs");
  const both = reaches(cfg, "two passes at once", (s) => s.procs.filter((x) => PASS.has(x.pc)).length > 1);
  assert.equal(both.ok, true, "two passes run at once");
  assert.equal(both.complete, true);
});

test("after both, processes one at a time leave every row current through a crash and a reprice that throws", (t) => {
  const cfg: Config = { procs: 2 + extra, foldBump: true, priceBump: true, lines: 1 + extra, crashes: 1 + extra, failures: 1, sequential: true };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 1_250, `${r.states} states`);
  // The refold reprices a session right before its fold, which then folds every event at the new prices.
  const before = reaches(cfg, "a fold right after its session's reprice", (s) => s.procs.some((x) => x.pc === "refold read" && s.folds[target(x)] === null)).violation;
  assert.ok(before, "the refold folds a session it just repriced");
  // The pass leaves out the sessions the refold repriced.
  const skipped = reaches(cfg, "a pass with nothing left", (s) => s.procs.some((x) => x.pc === "reprice cursor" && x.repriced === ALL)).violation;
  assert.ok(skipped, "the pass leaves out what the refold repriced");
  // A reprice that throws leaves the cursor to a later run.
  const left = reaches(cfg, "a failed reprice leaves the cursor", (s) => s.refold === CUR && s.reprice !== CUR && s.procs.some((x) => x.failed && x.pc === "run release")).violation;
  assert.ok(left, "a run whose reprice threw ends without the reprice cursor");
});

test("each check the code makes on purpose breaks an invariant when left out", (t) => {
  const base = { procs: 1, lines: 0, crashes: 0, failures: 0 };
  for (const [mutant, cfg, invariant] of [
    ["progress read whatever its stamp", { ...base, foldBump: true, priceBump: false, staleAfter: true }, "a current refold cursor means every row has the current fold"],
    ["a saved fold read whatever its stamp", { ...base, foldBump: true, priceBump: false }, "a current refold cursor means every row has the current fold"],
    ["costs set without dropping the fold", { ...base, foldBump: false, priceBump: true }, "a saved fold of this build holds its events' prices"],
    ["progress saved before the fold", { ...base, foldBump: true, priceBump: false, crashes: 1 }, "a current refold cursor means every row has the current fold"],
    ["the refold reprices after its fold", { ...base, foldBump: true, priceBump: true, crashes: 1 }, "after the last run every row is current"],
    ["the cursor set after a failed reprice", { ...base, foldBump: true, priceBump: true, failures: 1 }, "a current reprice cursor means every event has the new prices"],
    ["a reprice the open left not counted as due", { ...base, foldBump: false, priceBump: true }, "after the last run every row is current"],
  ] as const) {
    const v = run(t, { ...cfg, mutant }).violation;
    assert.ok(v, mutant);
    assert.equal(v.invariant, invariant, mutant);
  }
});
