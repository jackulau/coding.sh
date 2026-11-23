// A model of capture, checked with test/_model.ts. Hooks append end events to spool files and kick a
// background ingest. Ingest processes take the lock, clear the wake-up marker, list the files, read
// each one from its cursors, commit the events with the cursors past them, send them to a sink,
// release the lock, and run again while the marker is back. A process whose last pass ends with the
// marker back starts another ingest. Any ingest process can crash between two steps, or stall past
// the lock's stale limit, so that another process takes the lock over while the first one keeps
// running.
//
// Each step is one in the code (paths under packages/coding.sh/src):
// - Hook: spool/hook.ts appends the line, then kicks. spool/write.ts spoolFile picks the first file
//   under the size cap, and append writes the line with O_APPEND. spool/kick.ts kickIngest touches the
//   marker, then asks isLocked, and starts `ingest --background` when the lock is not held.
// - Lock: core/lock.ts acquireLock with waitMs 0 (the background run in cli/commands/ingest.ts). A
//   free or stale lock becomes ours; a held one ends the process ("busy"). That is one step here;
//   lock-model.test.ts checks how acquireLock and breakStale get there.
// - Passes: core/ingest.ts ingestSpool takes the lock, clears the marker, ingests, releases, and runs
//   another pass while the marker is back, at most MAX_PASSES. When the last pass ends with the marker
//   back, it calls onPassesExhausted, and core/context.ts starts `ingest --background` there
//   (spawnBackgroundIngest). Here that new ingest takes the slot of the process that started it,
//   which is done.
// - Read: the file loop in ingestLocked. It reads the local and sink cursors, skips the file when the
//   start is at its listed size, and reads from the start to the end of the file as it is then.
// - Commit: checkpoint in ingestLocked. A store with transactions (SQLite) puts the events and sets
//   each advanced file's cursor after a fence, all in one transaction. A store without them (the
//   memory store, Postgres, ClickHouse) makes the same writes one at a time (inTransaction).
// - Send: sendToSink reads the sink cursor and sends the window's lines from it. It leaves out a copy
//   of an event that an earlier checkpoint of the same pass stored (repeats), so none here, where a
//   pass has one checkpoint. sinkSend fences and writes, then sendToSink fences and sets the sink
//   cursor.
// - Fence: lock.assertHeld passes while the lock file is ours. A fence that passes while our lock is
//   stale is followed by its write as a separate step, because another process can take the lock in
//   between.
//
// Offsets are line numbers: a spool file only grows by whole lines, and the scrub pads lines in place
// (core/spool-scrub.ts), so a line keeps its offset. Left out: a hook that dies before its kick (its
// line waits for the next ingest, like a line a crash left), partial writes and torn lines
// (spool-read.ts and its tests), the heartbeat (here a stalled lock stays stale, which allows more
// takeovers, not fewer), a second sink, sink failures and backoff, checkpoints inside a pass (the
// window is larger than the events here, so each pass has one), and an event carried by two lines
// (Claude Code hands a helper's events over twice), with the per-pass dedupe by id that sendToSink
// does for it. Gc is left out too: a cursor past the end of a file it recreated, and the moment
// between its last stat of a spool file and the unlink, where a hook's append is lost.
//
// docs/design/state-machines.md ("Capture pipeline") describes an older order in places: there the kick
// (M5) skips when a lock file exists, live or stale, and touches no marker, the holder makes one pass,
// and a stale lock (M3) is removed without the guard and the compare of lock.ts breakStale and
// removeIfSame. The model follows the code.
//
// Bounds: two end events, two spool files of one line each and two ingest processes, with one crash
// and one stall. Two end events give two kicks, so two processes can run at once, and the second
// event can land during the first process's pass, which is what the marker is for. One line per file
// makes the second line start a new file that a listing can miss. CODING_SH_MODEL_BOUND=n allows n
// more crashes and n more stalls. Three end events with no fault pass too, in 273,428 states (about
// 6 s), and stay out of the default run to keep it short. The hand-off after the last pass takes four
// end events, one for the process and one during each of its three passes, so it gets its own run:
// four end events one after another, with no fault, in 167,785 states (about 5 s).
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsOf, check, formatTrace, type Action, type CheckResult, type Model } from "../_model.ts";

/** Lines a spool file holds before the writer moves on to the next file (SPOOL_FILE_CAP in spool/write.ts). */
const CAP_LINES = 1;
/** MAX_PASSES in core/ingest.ts. */
const MAX_PASSES = 3;

type Store = "transaction" | "no transaction";
/**
 * A change to the code that the model must catch: a step moved, or a rule as it was before a fix
 * ("skip what an earlier run stored": every event the put found stored is a repeat; "no hand-off":
 * the last pass ends with the marker back and starts no ingest).
 */
type Mutant = "look before mark" | "check before release" | "clear after list" | "cursor before events" | "skip what an earlier run stored" | "no hand-off";

interface Config {
  store: Store;
  hooks: number;
  files: number;
  crashes: number;
  stalls: number;
  /** Each hook starts once the one before it is done, as one session's turns end one after another. */
  serial?: boolean;
  mutant?: Mutant;
}

type HookPc = "pick" | "append" | "mark" | "look" | "done";
interface Hook {
  pc: HookPc;
  /** The file spoolFile picked. */
  file: number;
}

type Pc =
  | "idle"
  | "acquire"
  | "clear"
  | "list"
  | "read"
  | "commit"
  | "late commit"
  | "put"
  | "set"
  | "late set"
  | "send"
  | "late send"
  | "ack"
  | "late ack"
  | "release"
  | "check"
  | "done"
  | "dead";

/** One ingest process: the one hook i started is process i, and so is each ingest it hands off to. */
interface Proc {
  pc: Pc;
  /** The file the step at pc is about. */
  f: number;
  pass: number;
  /** Lines per file at the listing: 0 for a file that was not there yet. */
  listed: number[];
  /** The local cursor and the start, read at the file's turn. */
  local: number[];
  start: number[];
  /** Where the read stopped (readPos), or -1 for a file not read in this pass. */
  read: number[];
  /**
   * Events the commit's put found stored by an earlier checkpoint of this pass (repeats in
   * ingestLocked): none, with one checkpoint per pass. Under the mutant "skip what an earlier run
   * stored", every event the put found stored.
   */
  repeats: number[];
  /** Events a send whose fence passed will write. */
  out: number[];
  /** Mutant "check before release": what the marker check said. */
  again: boolean;
}

interface Cap {
  /** Each spool file's lines, by the event in them. Event i is hook i's. */
  files: number[][];
  marker: boolean;
  /** The process whose lock file is there, or -1. */
  lock: number;
  /** The lock file is past the stale limit: its owner stalled. */
  old: boolean;
  /** The process inside a SQLite write transaction across steps, or -1. */
  db: number;
  /** Per event: 1 once the index has it. The index keeps one copy per event id. */
  stored: number[];
  /** Per event: puts that carried it, counted up to 2. */
  puts: number[];
  /** Per file: the local cursor and the sink cursor, in lines. */
  cursor: number[];
  sink: number[];
  /** Per event: deliveries to the sink, counted up to 2. */
  sent: number[];
  hooks: Hook[];
  procs: Proc[];
  crashes: number;
  stalls: number;
}

const SECTION: ReadonlySet<Pc> = new Set<Pc>(["clear", "list", "read", "commit", "late commit", "put", "set", "late set", "send", "late send", "ack", "late ack", "release"]);
const STOPPED: ReadonlySet<Pc> = new Set<Pc>(["idle", "done", "dead"]);

function newProc(pc: Pc, nf: number, pass = 0): Proc {
  const zeros = () => Array.from({ length: nf }, () => 0);
  return { pc, f: 0, pass, listed: zeros(), local: zeros(), start: zeros(), read: Array.from({ length: nf }, () => -1), repeats: [], out: [], again: false };
}

function clone(s: Cap): Cap {
  return {
    files: s.files.map((f) => f.slice()),
    marker: s.marker,
    lock: s.lock,
    old: s.old,
    db: s.db,
    stored: s.stored.slice(),
    puts: s.puts.slice(),
    cursor: s.cursor.slice(),
    sink: s.sink.slice(),
    sent: s.sent.slice(),
    hooks: s.hooks.map((h) => ({ pc: h.pc, file: h.file })),
    procs: s.procs.map((p) => ({ ...p, listed: p.listed.slice(), local: p.local.slice(), start: p.start.slice(), read: p.read.slice(), repeats: p.repeats.slice(), out: p.out.slice() })),
    crashes: s.crashes,
    stalls: s.stalls,
  };
}

const next = (s: Cap, f: (d: Cap) => void): Cap => {
  const d = clone(s);
  f(d);
  return d;
};

/** One key per state, leaving out what no later step reads: a stopped process's fields, and a hook's file outside its append. */
function keyOf(s: Cap): string {
  const procs = s.procs.map((p) => (STOPPED.has(p.pc) ? p.pc : `${p.pc}${p.f}:${p.pass}:${p.listed}:${p.local}:${p.start}:${p.read}:${p.repeats}:${p.out}:${+p.again}`));
  const hooks = s.hooks.map((h) => (h.pc === "append" ? `a${h.file}` : h.pc));
  return `${s.files.map((f) => f.join(".")).join("|")};${+s.marker};${s.lock};${+s.old};${s.db};${s.stored};${s.puts};${s.cursor};${s.sink};${s.sent};${hooks};${procs.join("/")};${s.crashes};${s.stalls}`;
}

const proc = (s: Cap, p: number): Proc => {
  const x = s.procs[p];
  if (!x) throw new Error(`no process ${p}`);
  return x;
};
const at = (a: readonly number[], i: number): number => {
  const x = a[i];
  if (x === undefined) throw new Error(`index ${i} out of range`);
  return x;
};
/** inspect() says stale: the owner is dead or its lock file is old (lock.ts inspect). */
const stale = (s: Cap): boolean => s.lock >= 0 && (s.old || proc(s, s.lock).pc === "dead");
/** isLocked (lock.ts): a live holder whose lock is not stale. */
const held = (s: Cap): boolean => s.lock >= 0 && !stale(s);
const quiescent = (s: Cap): boolean => s.hooks.every((h) => h.pc === "done") && s.procs.every((p) => STOPPED.has(p.pc));
const faults = (s: Cap): number => s.crashes + s.stalls;
/** Files with lines past the local cursor this pass read. */
const advanced = (p: Proc): number[] => p.read.flatMap((r, f) => (r > at(p.local, f) ? [f] : []));

/** Adds one to a count kept up to 2: the invariants tell one from more than one. */
const bump = (a: number[], i: number): void => {
  a[i] = Math.min(at(a, i) + 1, 2);
};

/**
 * The checkpoint's put: what the index lacked is stored. Each event is in one line and a pass puts
 * once, so no event is a repeat (a copy of one this pass stored), except with `skipStored`, the rule
 * before the fix, where an event stored by anyone before is one.
 */
function putEvents(d: Cap, p: Proc, skipStored: boolean): void {
  for (const f of advanced(p)) {
    const lines = d.files[f] ?? [];
    for (let j = at(p.local, f); j < at(p.read, f); j++) {
      const e = at(lines, j);
      bump(d.puts, e);
      if (!d.stored[e]) d.stored[e] = 1;
      else if (skipStored) p.repeats.push(e);
    }
  }
  p.repeats.sort((a, b) => a - b);
}

/** What sendToSink writes for file f: the window's lines from the sink cursor, less repeats on lines read for the index. */
function outFor(d: Cap, p: Proc, f: number): number[] {
  const lines = d.files[f] ?? [];
  const out: number[] = [];
  for (let j = Math.max(at(p.start, f), at(d.sink, f)); j < at(p.read, f); j++) {
    const e = at(lines, j);
    if (j >= at(p.local, f) && p.repeats.includes(e)) continue;
    out.push(e);
  }
  return out;
}

function captureModel(cfg: Config): Model<Cap> {
  const nf = cfg.files;
  const n = cfg.hooks;
  const skipStored = cfg.mutant === "skip what an earlier run stored";
  const actions: Action<Cap>[] = [];

  // Stage changes inside a pass, skipping stages with nothing to do.
  const toSends = (p: Proc, from: number): void => {
    for (let f = from; f < nf; f++) {
      if (at(p.read, f) >= 0) {
        p.pc = "send";
        p.f = f;
        return;
      }
    }
    p.pc = cfg.mutant === "check before release" ? "check" : "release";
  };
  const toSets = (p: Proc, after: number): void => {
    const f = advanced(p).find((x) => x > after);
    if (f !== undefined) {
      p.pc = "set";
      p.f = f;
    } else if (cfg.mutant === "cursor before events") p.pc = "put";
    else toSends(p, 0);
  };
  const toCommit = (p: Proc): void => {
    p.listed = p.listed.map(() => 0);
    if (!advanced(p).length) toSends(p, 0);
    else if (cfg.store === "transaction") p.pc = "commit";
    else if (cfg.mutant === "cursor before events") toSets(p, -1);
    else p.pc = "put";
  };
  const toRead = (p: Proc, from: number): void => {
    for (let f = from; f < nf; f++) {
      if (at(p.listed, f) > 0) {
        p.pc = "read";
        p.f = f;
        return;
      }
    }
    toCommit(p);
  };

  for (let i = 0; i < n; i++) {
    const hook = (s: Cap): Hook => {
      const h = s.hooks[i];
      if (!h) throw new Error(`no hook ${i}`);
      return h;
    };
    actions.push({
      name: `h${i} picks a file`,
      guard: (s) => hook(s).pc === "pick" && (!cfg.serial || i === 0 || s.hooks[i - 1]?.pc === "done"),
      effect: (s) =>
        next(s, (d) => {
          const f = d.files.findIndex((x) => x.length < CAP_LINES);
          d.hooks[i] = { pc: "append", file: f < 0 ? nf - 1 : f };
        }),
    });
    actions.push({
      name: `h${i} appends`,
      guard: (s) => hook(s).pc === "append",
      effect: (s) =>
        next(s, (d) => {
          d.files[hook(d).file]?.push(i);
          hook(d).pc = cfg.mutant === "look before mark" ? "look" : "mark";
        }),
    });
    actions.push({
      name: `h${i} touches the marker`,
      guard: (s) => hook(s).pc === "mark",
      effect: (s) =>
        next(s, (d) => {
          d.marker = true;
          hook(d).pc = cfg.mutant === "look before mark" ? "done" : "look";
        }),
    });
    actions.push({
      name: `h${i} sees the lock held`,
      guard: (s) => hook(s).pc === "look" && held(s),
      effect: (s) =>
        next(s, (d) => {
          hook(d).pc = cfg.mutant === "look before mark" ? "mark" : "done";
        }),
    });
    actions.push({
      name: `h${i} starts p${i}`,
      guard: (s) => hook(s).pc === "look" && !held(s),
      effect: (s) =>
        next(s, (d) => {
          d.procs[i] = newProc("acquire", nf);
          hook(d).pc = cfg.mutant === "look before mark" ? "mark" : "done";
        }),
    });
  }

  for (let p = 0; p < n; p++) {
    const is = (s: Cap, pc: Pc, f?: number): boolean => proc(s, p).pc === pc && (f === undefined || proc(s, p).f === f);
    const lost = (d: Cap): void => {
      // LockLostError: the transaction rolls back, release() sees the lock is not ours, the process ends.
      proc(d, p).pc = "done";
    };

    actions.push({
      name: `p${p} takes the lock`,
      guard: (s) => is(s, "acquire") && s.lock < 0,
      effect: (s) =>
        next(s, (d) => {
          d.lock = p;
          d.old = false;
          proc(d, p).pc = cfg.mutant === "clear after list" ? "list" : "clear";
        }),
    });
    actions.push({
      name: `p${p} takes over the stale lock`,
      guard: (s) => is(s, "acquire") && stale(s),
      effect: (s) =>
        next(s, (d) => {
          d.lock = p;
          d.old = false;
          proc(d, p).pc = cfg.mutant === "clear after list" ? "list" : "clear";
        }),
    });
    actions.push({
      name: `p${p} finds the lock held`,
      guard: (s) => is(s, "acquire") && held(s),
      effect: (s) => next(s, (d) => void (proc(d, p).pc = "done")),
    });
    actions.push({
      name: `p${p} clears the marker`,
      guard: (s) => is(s, "clear"),
      effect: (s) =>
        next(s, (d) => {
          d.marker = false;
          const me = proc(d, p);
          if (cfg.mutant === "clear after list") toRead(me, 0);
          else me.pc = "list";
        }),
    });
    actions.push({
      name: `p${p} lists the files`,
      guard: (s) => is(s, "list"),
      effect: (s) =>
        next(s, (d) => {
          const me = proc(d, p);
          me.listed = d.files.map((f) => f.length);
          if (cfg.mutant === "clear after list") me.pc = "clear";
          else toRead(me, 0);
        }),
    });
    for (let f = 0; f < nf; f++) {
      actions.push({
        name: `p${p} reads F${f}`,
        guard: (s) => is(s, "read", f),
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            const local = at(d.cursor, f);
            const start = Math.min(local, at(d.sink, f));
            if (start < at(me.listed, f)) {
              me.local[f] = local;
              me.start[f] = start;
              me.read[f] = d.files[f]?.length ?? 0;
            }
            toRead(me, f + 1);
          }),
      });
    }

    // Checkpoint, with a transaction.
    actions.push({
      name: `p${p} commits`,
      guard: (s) => is(s, "commit") && s.db < 0 && s.lock === p && !s.old,
      effect: (s) =>
        next(s, (d) => {
          const me = proc(d, p);
          putEvents(d, me, skipStored);
          for (const f of advanced(me)) d.cursor[f] = at(me.read, f);
          toSends(me, 0);
        }),
    });
    actions.push({
      name: `p${p} passes the commit's fence on a stale lock`,
      guard: (s) => is(s, "commit") && s.db < 0 && s.lock === p && s.old,
      effect: (s) =>
        next(s, (d) => {
          d.db = p;
          proc(d, p).pc = "late commit";
        }),
    });
    actions.push({
      name: `p${p} fails the commit's fence`,
      guard: (s) => is(s, "commit") && s.db < 0 && s.lock !== p,
      effect: (s) => next(s, lost),
    });
    actions.push({
      name: `p${p} commits late`,
      guard: (s) => is(s, "late commit"),
      effect: (s) =>
        next(s, (d) => {
          const me = proc(d, p);
          putEvents(d, me, skipStored);
          for (const f of advanced(me)) d.cursor[f] = at(me.read, f);
          d.db = -1;
          toSends(me, 0);
        }),
    });

    // Checkpoint, without a transaction: the put, then each cursor after its fence.
    actions.push({
      name: `p${p} puts the events`,
      guard: (s) => is(s, "put"),
      effect: (s) =>
        next(s, (d) => {
          const me = proc(d, p);
          putEvents(d, me, skipStored);
          if (cfg.mutant === "cursor before events") toSends(me, 0);
          else toSets(me, -1);
        }),
    });
    for (let f = 0; f < nf; f++) {
      actions.push({
        name: `p${p} sets the F${f} cursor`,
        guard: (s) => is(s, "set", f) && s.lock === p && !s.old,
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            d.cursor[f] = at(me.read, f);
            toSets(me, f);
          }),
      });
      actions.push({
        name: `p${p} passes the F${f} cursor's fence on a stale lock`,
        guard: (s) => is(s, "set", f) && s.lock === p && s.old,
        effect: (s) => next(s, (d) => void (proc(d, p).pc = "late set")),
      });
      actions.push({
        name: `p${p} fails the F${f} cursor's fence`,
        guard: (s) => is(s, "set", f) && s.lock !== p,
        effect: (s) => next(s, lost),
      });
      actions.push({
        name: `p${p} sets the F${f} cursor late`,
        guard: (s) => is(s, "late set", f),
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            d.cursor[f] = at(me.read, f);
            toSets(me, f);
          }),
      });

      // The sink: write the window from the sink cursor, then set the sink cursor.
      actions.push({
        name: `p${p} sends F${f}`,
        guard: (s) => is(s, "send", f),
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            if (at(d.sink, f) >= at(me.read, f)) return toSends(me, f + 1);
            const out = outFor(d, me, f);
            if (!out.length) {
              me.pc = "ack";
              return;
            }
            if (d.lock !== p) return lost(d);
            if (d.old) {
              me.out = out;
              me.pc = "late send";
              return;
            }
            for (const e of out) bump(d.sent, e);
            me.pc = "ack";
          }),
      });
      actions.push({
        name: `p${p} sends F${f} late`,
        guard: (s) => is(s, "late send", f),
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            for (const e of me.out) bump(d.sent, e);
            me.out = [];
            me.pc = "ack";
          }),
      });
      actions.push({
        name: `p${p} sets the F${f} sink cursor`,
        guard: (s) => is(s, "ack", f),
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            if (d.lock !== p) return lost(d);
            if (d.old) {
              me.pc = "late ack";
              return;
            }
            d.sink[f] = at(me.read, f);
            toSends(me, f + 1);
          }),
      });
      actions.push({
        name: `p${p} sets the F${f} sink cursor late`,
        guard: (s) => is(s, "late ack", f),
        effect: (s) =>
          next(s, (d) => {
            const me = proc(d, p);
            d.sink[f] = at(me.read, f);
            toSends(me, f + 1);
          }),
      });
    }

    actions.push({
      name: `p${p} releases the lock`,
      guard: (s) => is(s, "release"),
      effect: (s) =>
        next(s, (d) => {
          // The lock's release() removes the lock file when it is ours (core/lock.ts). One step here:
          // lock-model.test.ts has its read and its remove apart.
          if (d.lock === p) {
            d.lock = -1;
            d.old = false;
          }
          const me = proc(d, p);
          if (cfg.mutant !== "check before release") me.pc = "check";
          else if (me.again) d.procs[p] = newProc("acquire", nf, me.pass + 1);
          else me.pc = "done";
        }),
    });
    actions.push({
      name: `p${p} checks the marker`,
      guard: (s) => is(s, "check"),
      effect: (s) =>
        next(s, (d) => {
          const me = proc(d, p);
          if (cfg.mutant === "check before release") {
            me.again = d.marker && me.pass + 1 < MAX_PASSES;
            me.pc = "release";
          } else if (!d.marker) me.pc = "done";
          else if (me.pass + 1 < MAX_PASSES) d.procs[p] = newProc("acquire", nf, me.pass + 1);
          // The last pass, and the marker is back: onPassesExhausted starts an ingest, which starts at its first pass.
          else if (cfg.mutant !== "no hand-off") d.procs[p] = newProc("acquire", nf);
          else me.pc = "done";
        }),
    });

    actions.push({
      name: `p${p} crashes`,
      guard: (s) => s.crashes < cfg.crashes && SECTION.has(proc(s, p).pc),
      effect: (s) =>
        next(s, (d) => {
          proc(d, p).pc = "dead";
          d.crashes++;
          // A transaction the process had open rolls back.
          if (d.db === p) d.db = -1;
        }),
    });
    actions.push({
      name: `p${p} stalls past the stale limit`,
      guard: (s) => s.stalls < cfg.stalls && s.lock === p && !s.old && SECTION.has(proc(s, p).pc),
      effect: (s) =>
        next(s, (d) => {
          d.old = true;
          d.stalls++;
        }),
    });
  }

  const linesOf = (s: Cap, f: number): number[] => s.files[f] ?? [];
  const invariants: Record<string, (s: Cap) => boolean | string> = {
    "a cursor covers only stored lines": (s) => {
      for (let f = 0; f < nf; f++) {
        const lines = linesOf(s, f);
        const c = at(s.cursor, f);
        if (c > lines.length) return `F${f}'s cursor ${c} is past its ${lines.length} lines`;
        for (let j = 0; j < c; j++) if (!s.stored[at(lines, j)]) return `F${f}'s cursor ${c} is past line ${j}, whose event ${at(lines, j)} is not stored`;
      }
      return true;
    },
    "one put without a fault": (s) => faults(s) > 0 || s.puts.every((x) => x <= 1) || `puts ${s.puts} with no crash or stall`,
    "one holder without a stall": (s) => s.stalls > 0 || s.procs.filter((p) => SECTION.has(p.pc)).length <= 1 || "two processes hold the lock",
    "every event stored when all stop without a fault": (s) => {
      if (!quiescent(s) || faults(s) > 0) return true;
      for (let f = 0; f < nf; f++) if (at(s.cursor, f) !== linesOf(s, f).length) return `all stopped, and F${f} has ${linesOf(s, f).length} lines and cursor ${at(s.cursor, f)}`;
      return s.stored.every((x) => x === 1) || `all stopped, with stored ${s.stored}`;
    },
    "a final ingest stores every event": (s) => (quiescent(s) ? drained(s, "index", skipStored) : true),
    "a sink cursor covers only sent lines": (s) => {
      for (let f = 0; f < nf; f++) {
        const lines = linesOf(s, f);
        const c = at(s.sink, f);
        if (c > lines.length) return `F${f}'s sink cursor ${c} is past its ${lines.length} lines`;
        for (let j = 0; j < c; j++) if (!s.sent[at(lines, j)]) return `F${f}'s sink cursor ${c} is past line ${j}, whose event ${at(lines, j)} was never sent`;
      }
      return true;
    },
    "one delivery without a fault": (s) => faults(s) > 0 || s.sent.every((x) => x <= 1) || `deliveries ${s.sent} with no crash or stall`,
    "every event sent once when all stop without a fault": (s) => {
      if (!quiescent(s) || faults(s) > 0) return true;
      for (let f = 0; f < nf; f++) if (at(s.sink, f) !== linesOf(s, f).length) return `all stopped, and F${f} has ${linesOf(s, f).length} lines and sink cursor ${at(s.sink, f)}`;
      return s.sent.every((x) => x === 1) || `all stopped, with deliveries ${s.sent}`;
    },
    "a final ingest sends every event": (s) => (quiescent(s) ? drained(s, "sink", skipStored) : true),
  };
  return {
    init: {
      files: Array.from({ length: nf }, () => []),
      marker: false,
      lock: -1,
      old: false,
      db: -1,
      stored: Array.from({ length: n }, () => 0),
      puts: Array.from({ length: n }, () => 0),
      cursor: Array.from({ length: nf }, () => 0),
      sink: Array.from({ length: nf }, () => 0),
      sent: Array.from({ length: n }, () => 0),
      hooks: Array.from({ length: n }, () => ({ pc: "pick", file: 0 })),
      procs: Array.from({ length: n }, () => newProc("idle", nf)),
      crashes: 0,
      stalls: 0,
    },
    actions,
    key: keyOf,
    invariants,
    final: quiescent,
  };
}

/** A crash-free ingest from a state where nothing runs, by the same repeat rule: after it, every event is stored, or sent at least once. */
function drained(s: Cap, part: "index" | "sink", skipStored: boolean): true | string {
  const d = clone(s);
  const nf = d.files.length;
  const me = newProc("read", nf);
  for (let f = 0; f < nf; f++) {
    const size = d.files[f]?.length ?? 0;
    const local = at(d.cursor, f);
    const start = Math.min(local, at(d.sink, f));
    if (start >= size) continue;
    me.local[f] = local;
    me.start[f] = start;
    me.read[f] = size;
  }
  putEvents(d, me, skipStored);
  if (part === "index") return d.stored.every((x) => x === 1) || `after a final ingest, stored ${d.stored}`;
  for (let f = 0; f < nf; f++) {
    if (at(me.read, f) < 0 || at(d.sink, f) >= at(me.read, f)) continue;
    for (const e of outFor(d, me, f)) bump(d.sent, e);
  }
  return d.sent.every((x) => x >= 1) || `after a final ingest, deliveries ${d.sent}`;
}

function boundsFrom(env: NodeJS.ProcessEnv): { crashes: number; stalls: number } {
  const raw = env.CODING_SH_MODEL_BOUND ?? "0";
  const extra = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${raw}`);
  return { crashes: 1 + extra, stalls: 1 + extra };
}

/** Checks one configuration, and prints its size and the trace of anything it found. */
function run(t: { diagnostic: (m: string) => void }, cfg: Config): CheckResult<Cap> {
  const t0 = performance.now();
  const r = check(captureModel(cfg));
  const label = `${cfg.hooks} end events${cfg.serial ? " one after another" : ""}, ${cfg.store}, ${cfg.crashes} crash(es), ${cfg.stalls} stall(s)${cfg.mutant ? `, mutant "${cfg.mutant}"` : ""}`;
  t.diagnostic(`${label}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(performance.now() - t0)} ms`);
  const bad = r.violation ?? r.deadlock;
  if (bad && !cfg.mutant) t.diagnostic(`${r.violation ? `${r.violation.invariant}: ${r.violation.message ?? ""}` : "deadlock"}\n${formatTrace(bad.trace, keyOf)}`);
  return r;
}

const bounds = boundsFrom(process.env);
const base = { hooks: 2, files: 2 };

test("the index and the sink get every event through a crash and a stale lock, on a store with transactions", (t) => {
  const r = run(t, { ...base, store: "transaction", ...bounds });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 13_000, `${r.states} states`);
});

test("the index and the sink get every event through a crash and a stale lock, on a store without transactions", (t) => {
  const r = run(t, { ...base, store: "no transaction", ...bounds });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 16_000, `${r.states} states`);
});

test("an end event during the last pass is ingested by the ingest that pass starts", (t) => {
  const r = run(t, { hooks: 4, files: 2, store: "transaction", crashes: 0, stalls: 0, serial: true });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 160_000, `${r.states} states`);
});

test("each step the code orders on purpose breaks an invariant when moved, and each fixed rule when undone", (t) => {
  const broken = (mutant: Mutant, cfg: Partial<Config> & { store: Store }): { invariant: string; actions: string[] } => {
    const r = run(t, { ...base, crashes: 0, stalls: 0, ...cfg, mutant });
    const v = r.violation;
    assert.ok(v, `the mutant "${mutant}" passed`);
    return { invariant: v.invariant, actions: actionsOf(v.trace) };
  };
  const before = (actions: string[], a: string, b: string): boolean => actions.indexOf(a) >= 0 && actions.indexOf(a) < actions.indexOf(b);
  const lost = "every event stored when all stop without a fault";

  // The hook looks at the lock before it touches the marker: the holder can check for the marker in between.
  const lookFirst = broken("look before mark", { store: "transaction" });
  assert.equal(lookFirst.invariant, lost);
  assert.ok(before(lookFirst.actions, "h1 sees the lock held", "p0 checks the marker") && before(lookFirst.actions, "p0 checks the marker", "h1 touches the marker"), lookFirst.actions.join(", "));

  // The holder checks for the marker before it releases: a hook that sees the lock held in between is missed.
  const checkFirst = broken("check before release", { store: "transaction" });
  assert.equal(checkFirst.invariant, lost);
  assert.ok(before(checkFirst.actions, "p0 checks the marker", "h1 sees the lock held") && before(checkFirst.actions, "h1 sees the lock held", "p0 releases the lock"), checkFirst.actions.join(", "));

  // The holder clears the marker after it lists the files: the marker of a line the listing missed is gone.
  const clearLate = broken("clear after list", { store: "transaction" });
  assert.equal(clearLate.invariant, lost);
  assert.ok(before(clearLate.actions, "p0 lists the files", "h1 appends") && before(clearLate.actions, "h1 touches the marker", "p0 clears the marker"), clearLate.actions.join(", "));

  // A store without transactions sets the cursor before the put: a crash between them loses the line.
  const cursorFirst = broken("cursor before events", { store: "no transaction" });
  assert.equal(cursorFirst.invariant, "a cursor covers only stored lines");
  assert.equal(cursorFirst.actions.at(-1), "p0 sets the F0 cursor");

  // An event the put finds stored is not sent: the process that stored it died before its send, so no one sends it.
  const crashed = broken("skip what an earlier run stored", { store: "no transaction", crashes: 1 });
  assert.equal(crashed.invariant, "a final ingest sends every event");
  assert.ok(before(crashed.actions, "p0 puts the events", "p0 crashes"), crashed.actions.join(", "));

  // The same with transactions and a stale lock: the process that takes over sets the sink cursor past an event no one sent.
  const stalled = broken("skip what an earlier run stored", { store: "transaction", stalls: 1 });
  assert.equal(stalled.invariant, "a sink cursor covers only sent lines");
  assert.ok(before(stalled.actions, "p0 commits late", "p1 commits") && before(stalled.actions, "p1 commits", "p1 sends F0"), stalled.actions.join(", "));

  // The last pass ends with the marker back and starts no ingest: the end event that set the marker waits.
  const noHandOff = broken("no hand-off", { hooks: 4, store: "transaction", serial: true });
  assert.equal(noHandOff.invariant, lost);
  assert.equal(noHandOff.actions.at(-1), "p0 checks the marker");
});
