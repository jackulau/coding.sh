// A model of the ingest lock, checked with test/_model.ts. Contenders run acquireLock with waitMs 0, as a
// background ingest does (cli/commands/ingest.ts), hold the lock through a fenced write, and release it.
// Any of them can crash between two steps, or stall past the stale limit.
//
// Each step is one in core/lock.ts (paths under packages/coding.sh/src):
// - acquireLock: tryCreate the lock with O_EXCL, or else inspect it. A missing file is free (try again);
//   a dead holder on this host, or an mtime past staleMs, is stale (break it); anything else is held,
//   which with waitMs 0 ends the attempt as busy.
// - breakStale: take the guard `<lock>.break` with O_EXCL. When another process has it, judge the
//   guard: stale (a dead holder, or older than 10 s) is removed with removeIfSame and the attempt starts
//   over; held is busy. Under the guard, judge the lock again and remove it with removeIfSame when it is
//   still stale. Then remove the guard if it still carries our nonce: a read, then a remove.
// - removeIfSame: rename the file aside. When it is the file judged (inode, mtime and content), remove
//   it. Otherwise link it back, which fails when a new file took the name, and remove the aside name.
//   Renaming and comparing are one step here, and so are linking and removing: no other process uses
//   the aside name.
// - Holding: assertHeld passes while the lock file carries our nonce, and the write it guards is a
//   separate step. The heartbeat reads the lock, then touches whatever file is there. release reads the
//   lock, then removes it.
// A crash leaves the process's files behind with a dead pid, which a contender on the same host judges
// stale at once. A stall ages the file the process holds past its limit (10 s for the guard, staleMs
// for the lock); a process holds one of the two at a time. A file no live process refreshes can age
// too. A process exits after its last attempt, and its pid is then dead.
//
// Checked: without a stall, one process holds the lock, one breaker works under the guard, no holder
// loses its lock, only a dead process's lock file is removed, and a run leaves only a crashed process's
// files. With stalls, each stall lets in at most one more holder, and the windows the header of
// core/lock.ts names are reached: a release that stalls between its read and its remove removes the
// lock a peer took, a holder that never stalled loses its lock, and a breaker that stalls under the
// guard lets a second one work beside it. Two mutants show the guard and the second judgment are both
// needed.
//
// Left out: hosts that share the folder (the mtime decides there, as after a stall); a torn lock file
// from a crash between create and write (judged by its mtime alone, so stale only after staleMs); a
// file replaced between the stat and the read of one inspect, which are one step here (that judgment
// matches no file, so removeIfSame renames the new file aside and links it back, the same moment as
// after a stalled release: the new file's owner can fail a fence meanwhile); file systems without hard
// links, where the link back always fails; the exit handler (releaseAllOnExit, the same read and remove
// as release); and waiting with waitMs above 0, which gives more attempts, like more rounds here.
//
// Bounds: three contenders with one attempt each, one crash, and no stall or one: 1,433 and 37,635
// states. Three is the fewest where one holder dies and two contenders race to break its lock, and one
// stall is the fewest that lets in a second holder. CODING_SH_MODEL_BOUND=n gives each contender n more
// attempts, so a process that lost its lock can contend again, and allows n more crashes. It also adds a
// run with n more stalls and one attempt each. With three processes every invariant holds trivially
// after two stalls, so that run checks that no state gets stuck and that the shortest way to three
// holders takes two stalls. At 1 the run with one stall has 617,586 states (about 8 s) and the one with
// two stalls 236,077; at 2 they have 2,342,064 (about 45 s) and 711,165. A holder beats once per hold,
// where the code beats every interval: each later beat repeats the first one's race, a read and then a
// touch of whatever file is there, so it can refresh a successor's lock again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsOf, check, formatTrace, type Action, type CheckResult, type Model } from "../_model.ts";

/** A file at the lock or guard path: who made it, its mtime as a count of touches, and whether that mtime is past the limit. */
interface LockFile {
  id: number;
  owner: number;
  mt: number;
  old: boolean;
}

type Pc =
  | "create"
  | "inspect"
  | "remove"
  | "guard"
  | "guard look"
  | "judge"
  | "rename"
  | "link"
  | "unguard"
  | "unguard rm"
  | "fence"
  | "write"
  | "touch"
  | "release"
  | "release rm"
  | "done";

/** Changes to the code's order that the invariants must catch. */
type Mutant = "remove without the guard" | "no second judgment";

interface Config {
  procs: number;
  rounds: number;
  crashes: number;
  stalls: number;
  mutant?: Mutant;
}

interface Proc {
  pc: Pc;
  round: number;
  /** The lock file this attempt made, 0 before it has one. */
  nonce: number;
  /** The guard file this attempt made, 0 when it has none. */
  guard: number;
  /** What removeIfSame works on, the file it judged, and the file it renamed aside. */
  target: "lock" | "guard";
  seen: { id: number; mt: number } | null;
  moved: LockFile | null;
  /** A fence or the heartbeat found the lock was not ours. */
  lost: boolean;
  /** Stalled during this attempt. */
  stalled: boolean;
  beat: boolean;
  dead: boolean;
  crashed: boolean;
}

interface Lk {
  lock: LockFile | null;
  guard: LockFile | null;
  procs: Proc[];
  next: number;
  crashes: number;
  stalls: number;
  /** A file was removed while its owner held the lock with it and had not stalled. */
  brokeLive: boolean;
  /** A dead process's lock file was removed by another. */
  brokeDead: boolean;
}

/** Holding the lock: between acquiring it and starting to release it. */
const HOLD: ReadonlySet<Pc> = new Set(["fence", "write", "touch"]);
/** The heartbeat keeps the lock file fresh until release clears it; the guard is held for microseconds. */
const REFRESH: ReadonlySet<Pc> = new Set(["fence", "write", "touch", "release", "release rm"]);
const GUARDED: ReadonlySet<Pc> = new Set(["judge", "rename", "link", "unguard", "unguard rm"]);

const copy = (f: LockFile | null): LockFile | null => (f ? { ...f } : null);
const clone = (s: Lk): Lk => ({
  ...s,
  lock: copy(s.lock),
  guard: copy(s.guard),
  procs: s.procs.map((p) => ({ ...p, seen: p.seen ? { ...p.seen } : null, moved: copy(p.moved) })),
});

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`no ${what}`);
  return v;
}

const proc = (s: Lk, p: number): Proc => must(s.procs[p], `process ${p}`);
const holders = (s: Lk): number => s.procs.filter((x) => !x.dead && HOLD.has(x.pc)).length;
/** Between taking the guard and acting on its judgment of the lock. */
const breakers = (s: Lk): number => s.procs.filter((x) => !x.dead && x.target === "lock" && (x.pc === "judge" || x.pc === "rename" || x.pc === "link")).length;
/** Contenders that judged the lock stale and have not acted on it yet. */
const judging = (s: Lk): number => s.procs.filter((x) => !x.dead && x.target === "lock" && x.seen !== null).length;
const quiescent = (s: Lk): boolean => s.procs.every((x) => x.pc === "done");

/** One key per state. File ids are numbered in order of appearance, since only their equality matters. */
function keyOf(s: Lk): string {
  const ids = new Map<number, number>();
  const id = (x: number): number => {
    if (x === 0) return 0;
    let v = ids.get(x);
    if (v === undefined) ids.set(x, (v = ids.size + 1));
    return v;
  };
  const file = (f: LockFile | null): string => (f ? `${id(f.id)}.${f.owner}.${f.mt}${f.old ? "o" : ""}` : "-");
  const parts: string[] = [file(s.lock), file(s.guard), `${s.crashes}${s.stalls}${+s.brokeLive}${+s.brokeDead}`];
  for (const p of s.procs) {
    if (p.pc === "done") parts.push(p.crashed ? "crashed" : "done");
    else parts.push([p.pc, p.round, id(p.nonce), id(p.guard), p.target, p.seen ? `${id(p.seen.id)}.${p.seen.mt}` : "-", file(p.moved), `${+p.lost}${+p.stalled}${+p.beat}`].join("|"));
  }
  return parts.join(" ");
}

function lockModel(cfg: Config): Model<Lk> {
  const actions: Action<Lk>[] = [];
  const stale = (s: Lk, f: LockFile): boolean => proc(s, f.owner).dead || f.old;
  const make = (d: Lk, owner: number): LockFile => ({ id: ++d.next, owner, mt: 0, old: false });
  /** Notes the removal of `f` by a process other than its owner. */
  const removed = (d: Lk, f: LockFile): void => {
    const o = proc(d, f.owner);
    if (o.dead) d.brokeDead = true;
    else if (HOLD.has(o.pc) && o.nonce === f.id && !o.stalled) d.brokeLive = true;
  };
  /** Ends an attempt: busy, or after release. A process exits after its last one. */
  const finish = (me: Proc): void => {
    Object.assign(me, { round: me.round + 1, nonce: 0, guard: 0, seen: null, moved: null, lost: false, stalled: false, beat: false });
    if (me.round < cfg.rounds) me.pc = "create";
    else Object.assign(me, { pc: "done", dead: true });
  };

  for (let p = 0; p < cfg.procs; p++) {
    const step = (name: string, pc: Pc, when: (s: Lk, me: Proc) => boolean, effect: (d: Lk, me: Proc) => void): void => {
      actions.push({
        name: `p${p} ${name}`,
        guard: (s) => {
          const me = proc(s, p);
          return !me.dead && me.pc === pc && when(s, me);
        },
        effect: (s) => {
          const d = clone(s);
          effect(d, proc(d, p));
          return d;
        },
      });
    };
    const slot = (s: Lk, me: Proc): LockFile | null => (me.target === "lock" ? s.lock : s.guard);
    const put = (d: Lk, me: Proc, f: LockFile | null): void => {
      if (me.target === "lock") d.lock = f;
      else d.guard = f;
    };
    const same = (f: LockFile, me: Proc): boolean => f.id === me.seen?.id && f.mt === me.seen.mt;
    /** removeIfSame returns: to the guard's release after the lock, to a new try after the guard. */
    const after = (me: Proc): void => {
      me.seen = null;
      me.pc = me.target === "lock" ? "unguard" : "create";
    };

    // acquireLock: tryCreate, then inspect.
    step("creates the lock", "create", (s) => !s.lock, (d, me) => {
      d.lock = make(d, p);
      me.nonce = d.lock.id;
      me.pc = "fence";
    });
    step("finds a lock file", "create", (s) => !!s.lock, (_d, me) => void (me.pc = "inspect"));
    step("finds the lock gone", "inspect", (s) => !s.lock, (_d, me) => void (me.pc = "create"));
    step("finds the lock held", "inspect", (s) => !!s.lock && !stale(s, s.lock), (_d, me) => finish(me));
    step("judges the lock stale", "inspect", (s) => !!s.lock && stale(s, s.lock), (d, me) => {
      const l = must(d.lock, "lock");
      me.seen = { id: l.id, mt: l.mt };
      me.pc = cfg.mutant === "remove without the guard" ? "remove" : "guard";
    });
    // The mutant: the lock before the guard, which removed the file with rmSync once isStale said so.
    step("removes the lock", "remove", () => true, (d, me) => {
      if (d.lock) removed(d, d.lock);
      d.lock = null;
      me.seen = null;
      me.pc = "create";
    });

    // breakStale: the guard, the judgment under it, and the guard's release.
    step("takes the guard", "guard", (s) => !s.guard, (d, me) => {
      d.guard = make(d, p);
      me.guard = d.guard.id;
      me.target = "lock";
      me.pc = cfg.mutant === "no second judgment" ? "rename" : "judge";
    });
    step("finds the guard taken", "guard", (s) => !!s.guard, (_d, me) => void (me.pc = "guard look"));
    step("finds the guard gone", "guard look", (s) => !s.guard, (_d, me) => {
      me.seen = null;
      me.pc = "create";
    });
    step("finds the guard held", "guard look", (s) => !!s.guard && !stale(s, s.guard), (_d, me) => finish(me));
    step("judges the guard stale", "guard look", (s) => !!s.guard && stale(s, s.guard), (d, me) => {
      const g = must(d.guard, "guard");
      me.seen = { id: g.id, mt: g.mt };
      me.target = "guard";
      me.pc = "rename";
    });
    step("finds the lock gone under the guard", "judge", (s) => !s.lock, (_d, me) => {
      me.seen = null;
      me.pc = "unguard";
    });
    step("finds the lock held under the guard", "judge", (s) => !!s.lock && !stale(s, s.lock), (_d, me) => {
      me.seen = null;
      me.pc = "unguard";
    });
    step("judges the lock stale under the guard", "judge", (s) => !!s.lock && stale(s, s.lock), (d, me) => {
      const l = must(d.lock, "lock");
      me.seen = { id: l.id, mt: l.mt };
      me.pc = "rename";
    });
    step("finds nothing to rename", "rename", (s, me) => !slot(s, me), (_d, me) => after(me));
    step("renames the judged file aside and removes it", "rename", (s, me) => {
      const f = slot(s, me);
      return !!f && same(f, me);
    }, (d, me) => {
      const f = must(slot(d, me), me.target);
      if (me.target === "lock") removed(d, f);
      put(d, me, null);
      after(me);
    });
    step("renames another file aside", "rename", (s, me) => {
      const f = slot(s, me);
      return !!f && !same(f, me);
    }, (d, me) => {
      me.moved = slot(d, me);
      put(d, me, null);
      me.pc = "link";
    });
    step("links it back", "link", (s, me) => !slot(s, me), (d, me) => {
      put(d, me, me.moved);
      me.moved = null;
      after(me);
    });
    step("cannot link it back, and removes it", "link", (s, me) => !!slot(s, me), (d, me) => {
      if (me.target === "lock") removed(d, must(me.moved, "aside file"));
      me.moved = null;
      after(me);
    });
    step("sees the guard is its own", "unguard", (s, me) => s.guard?.id === me.guard, (_d, me) => void (me.pc = "unguard rm"));
    step("sees the guard is not its own", "unguard", (s, me) => s.guard?.id !== me.guard, (_d, me) => {
      me.guard = 0;
      me.pc = "create";
    });
    step("removes the guard", "unguard rm", () => true, (d, me) => {
      d.guard = null;
      me.guard = 0;
      me.pc = "create";
    });

    // Holding: one fenced write, the heartbeat, and release.
    step("passes a fence", "fence", (s, me) => !me.lost && s.lock?.id === me.nonce, (_d, me) => void (me.pc = "write"));
    step("fails a fence", "fence", (s, me) => me.lost || s.lock?.id !== me.nonce, (_d, me) => {
      me.lost = true;
      me.pc = "release";
    });
    step("writes", "write", () => true, (_d, me) => void (me.pc = "release"));
    step("beats and finds its lock", "fence", (s, me) => !me.beat && s.lock?.id === me.nonce, (_d, me) => {
      me.beat = true;
      me.pc = "touch";
    });
    step("beats and finds the lock is not its own", "fence", (s, me) => !me.beat && s.lock?.id !== me.nonce, (_d, me) => {
      me.beat = true;
      me.lost = true;
    });
    step("touches the lock", "touch", (s) => !!s.lock, (d, me) => {
      const l = must(d.lock, "lock");
      l.mt++;
      l.old = false;
      me.pc = "fence";
    });
    step("finds no lock to touch", "touch", (s) => !s.lock, (_d, me) => {
      me.lost = true;
      me.pc = "fence";
    });
    step("releases and finds its lock", "release", (s, me) => s.lock?.id === me.nonce, (_d, me) => void (me.pc = "release rm"));
    step("releases and finds the lock is not its own", "release", (s, me) => s.lock?.id !== me.nonce, (_d, me) => finish(me));
    step("removes the lock it released", "release rm", () => true, (d, me) => {
      if (d.lock && d.lock.id !== me.nonce) removed(d, d.lock);
      d.lock = null;
      finish(me);
    });

    actions.push({
      name: `p${p} crashes`,
      guard: (s) => !proc(s, p).dead && s.crashes < cfg.crashes,
      effect: (s) => {
        const d = clone(s);
        Object.assign(proc(d, p), { pc: "done", dead: true, crashed: true });
        d.crashes++;
        return d;
      },
    });
    actions.push({
      name: `p${p} stalls past the stale limit`,
      guard: (s) => !proc(s, p).dead && s.stalls < cfg.stalls,
      effect: (s) => {
        const d = clone(s);
        for (const f of [d.lock, d.guard]) if (f?.owner === p) f.old = true;
        proc(d, p).stalled = true;
        d.stalls++;
        return d;
      },
    });
  }
  // Time passes for a file that no live process refreshes. A dead holder's file is stale already.
  const ages = (s: Lk, f: LockFile | null, busy: ReadonlySet<Pc>, mine: (o: Proc) => number): boolean => {
    if (!f || f.old) return false;
    const o = proc(s, f.owner);
    return !o.dead && !(busy.has(o.pc) && mine(o) === f.id);
  };
  actions.push({
    name: "the lock file ages unrefreshed",
    guard: (s) => ages(s, s.lock, REFRESH, (o) => o.nonce),
    effect: (s) => {
      const d = clone(s);
      must(d.lock, "lock").old = true;
      return d;
    },
  });
  actions.push({
    name: "the guard file ages",
    guard: (s) => ages(s, s.guard, GUARDED, (o) => o.guard),
    effect: (s) => {
      const d = clone(s);
      must(d.guard, "guard").old = true;
      return d;
    },
  });

  const fresh = (): Proc => ({ pc: "create", round: 0, nonce: 0, guard: 0, target: "lock", seen: null, moved: null, lost: false, stalled: false, beat: false, dead: false, crashed: false });
  return {
    init: { lock: null, guard: null, procs: Array.from({ length: cfg.procs }, fresh), next: 0, crashes: 0, stalls: 0, brokeLive: false, brokeDead: false },
    actions,
    key: keyOf,
    invariants: {
      "one holder without a stall": (s) => s.stalls > 0 || holders(s) <= 1 || `${holders(s)} processes hold the lock`,
      "one breaker under the guard without a stall": (s) => s.stalls > 0 || breakers(s) <= 1 || `${breakers(s)} processes judge the lock under the guard`,
      "one more holder at most per stall": (s) => holders(s) <= 1 + s.stalls || `${holders(s)} processes hold the lock after ${s.stalls} stall(s)`,
      "no lost lock without a stall": (s) => s.stalls > 0 || s.procs.every((x) => !x.lost) || "a holder lost its lock with no stall",
      "only a dead or stalled holder's file is removed": (s) => s.stalls > 0 || !s.brokeLive || "a live holder's lock file was removed with no stall",
      "a run with no stall leaves only a crashed process's files": (s) => {
        if (!quiescent(s) || s.stalls > 0) return true;
        for (const f of [s.lock, s.guard]) if (f && !proc(s, f.owner).crashed) return `p${f.owner} ended and left its file behind`;
        return true;
      },
    },
    final: quiescent,
  };
}

function boundFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.CODING_SH_MODEL_BOUND ?? "0";
  const extra = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${raw}`);
  return extra;
}

const extra = boundFrom(process.env);

function run(t: { diagnostic: (m: string) => void }, cfg: Config, model = lockModel(cfg)): CheckResult<Lk> {
  const t0 = performance.now();
  const r = check(model);
  const label = `${cfg.procs} contenders, ${cfg.rounds} attempt(s) each, ${cfg.crashes} crash(es), ${cfg.stalls} stall(s)${cfg.mutant ? `, mutant "${cfg.mutant}"` : ""}`;
  t.diagnostic(`${label}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(performance.now() - t0)} ms`);
  const bad = r.violation ?? r.deadlock;
  if (bad && !cfg.mutant) t.diagnostic(`${r.violation ? `${r.violation.invariant}: ${r.violation.message ?? ""}` : "deadlock"}\n${formatTrace(bad.trace, keyOf)}`);
  return r;
}

/** The model with one more invariant that names a state it must reach, so a pass is not vacuous. */
function reaches(cfg: Config, name: string, at: (s: Lk) => boolean): CheckResult<Lk> {
  const m = lockModel(cfg);
  return check({ ...m, invariants: { [name]: (s) => !at(s) } });
}

test("without a stall one process holds the lock, and a crashed holder's lock is broken once", (t) => {
  const cfg: Config = { procs: 3, rounds: 1 + extra, crashes: 1 + extra, stalls: 0 };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 1_000, `${r.states} states`);
  // The race the guard is for happens: two contenders judge a dead holder's lock stale at once.
  const race = reaches(cfg, "two judge one stale lock", (s) => judging(s) === 2).violation?.trace;
  assert.ok(race, "two contenders judge the lock stale at once");
  assert.ok(actionsOf(race).some((a) => a.endsWith("crashes")));
  // And one of them breaks it and takes the lock.
  const taken = reaches(cfg, "taken after a crash", (s) => s.brokeDead && holders(s) === 1).violation?.trace;
  assert.ok(taken, "a contender takes the crashed holder's lock");
  const names = actionsOf(taken);
  assert.ok(names.some((a) => a.endsWith("renames the judged file aside and removes it")));
  assert.match(names.at(-1) ?? "", /creates the lock$/);
});

test("with one stall two processes can hold the lock, and never three", (t) => {
  const cfg: Config = { procs: 3, rounds: 1 + extra, crashes: 1 + extra, stalls: 1 };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.ok(r.states >= 1_000, `${r.states} states`);
  const two = reaches(cfg, "two holders", (s) => holders(s) === 2).violation?.trace;
  assert.ok(two, "a stall lets a second process take the lock");
  assert.ok(actionsOf(two).some((a) => a.endsWith("stalls past the stale limit")));
});

test("a stall opens the windows core/lock.ts names", () => {
  // One attempt each, whatever the bound: a second attempt gives the same windows by other shortest traces.
  const cfg: Config = { procs: 3, rounds: 1, crashes: 1, stalls: 1 };
  // A release that stalls between its read and its remove removes the lock a peer took meanwhile.
  const removed = reaches(cfg, "a holder's lock removed", (s) => s.brokeLive).violation?.trace;
  assert.ok(removed, "a holder's lock is removed after a stall");
  const names = actionsOf(removed);
  const remover = /^(p\d) removes the lock it released$/.exec(names.at(-1) ?? "")?.[1];
  assert.ok(remover, names.at(-1));
  const read = names.indexOf(`${remover} releases and finds its lock`);
  assert.ok(read >= 0 && names.indexOf(`${remover} stalls past the stale limit`) > read, "it stalled inside release");
  // A breaker that judged the stalled holder's file renames a peer's fresh lock aside, and the peer loses it.
  const lost = reaches(cfg, "a holder that never stalled loses its lock", (s) => s.procs.some((x) => !x.dead && x.lost && !x.stalled)).violation?.trace;
  assert.ok(lost, "a holder that never stalled loses its lock");
  assert.ok(actionsOf(lost).some((a) => a.endsWith("renames another file aside")));
  // A breaker that stalls under the guard has its guard judged stale and taken over.
  const breaking = reaches(cfg, "two breakers", (s) => breakers(s) === 2).violation?.trace;
  assert.ok(breaking, "two processes work under the guard after a stall");
  assert.ok(actionsOf(breaking).some((a) => a.endsWith("judges the guard stale")));
});

test("each check the code makes on purpose breaks an invariant when left out", (t) => {
  for (const [mutant, invariant] of [
    ["remove without the guard", "only a dead or stalled holder's file is removed"],
    ["no second judgment", "no lost lock without a stall"],
  ] as const) {
    const v = run(t, { procs: 3, rounds: 1, crashes: 1, stalls: 0, mutant }).violation;
    assert.ok(v, mutant);
    assert.equal(v.invariant, invariant, mutant);
    assert.ok(actionsOf(v.trace).some((a) => a.endsWith("crashes")), mutant);
  }
});

// One attempt each: more attempts and more stalls together pass ten million states. With three
// processes every invariant holds trivially after two stalls, so this run checks for stuck states and
// for how a third holder gets in.
test("with more stalls no state gets stuck, and the shortest way to three holders takes two stalls", { skip: extra === 0 && "the bound adds the stalls" }, (t) => {
  const cfg: Config = { procs: 3, rounds: 1, crashes: 1, stalls: 1 + extra };
  const r = run(t, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  const three = reaches(cfg, "three holders", (s) => holders(s) === 3).violation?.trace;
  assert.ok(three, "two stalls let in two more holders");
  assert.equal(actionsOf(three).filter((a) => a.endsWith("stalls past the stale limit")).length, 2);
});
