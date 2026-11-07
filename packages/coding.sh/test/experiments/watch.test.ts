// X-12 `exp run --watch`: debounced reruns, a change aborts the run in flight
// (and nothing partial is kept), a grader-only change regrades the stored
// outputs with no task calls, and a broken spec is reported while watching goes
// on. Fake watcher and timers; no file system events or clock.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { ExperimentResult, Grader } from "../../src/datasets/types.ts";
import { regradeExperiment, runExperiment } from "../../src/experiments/run.ts";
import { decideMode, specFingerprint, startWatchLoop, type Fingerprint, type Timers, type WatchLoad, type WatchMode, type Watcher } from "../../src/experiments/watch.ts";
import { exactGrader } from "../../src/graders/builtin.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A watcher whose events the test fires: emit(file) reaches every open watch. */
function fakeWatcher() {
  const open = new Set<{ dir: string; cb: (f: string | null) => void }>();
  const watcher: Watcher = (dir, _o, cb) => {
    const h = { dir, cb };
    open.add(h);
    return { close: () => void open.delete(h) };
  };
  return { watcher, emit: (f: string | null) => [...open].forEach((h) => h.cb(f)), open };
}

/** Timers fired by hand: fire() runs the pending callback (only the last one survives a clear). */
function fakeTimers() {
  let next: (() => void) | undefined;
  let sets = 0;
  const timers: Timers = {
    set: (fn) => {
      sets++;
      next = fn;
      return fn;
    },
    clear: (h) => {
      if (h === next) next = undefined;
    },
  };
  return { timers, fire: () => { const f = next; next = undefined; f?.(); }, get sets() { return sets; }, get pending() { return !!next; } };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};
const fp = (task: string, graders: string): Fingerprint => ({ task, graders, files: {} });
const target = { dir: "/w", recursive: false, match: (rel: string) => rel === "spec.json" || rel === "agent.mjs" };

describe("decideMode", () => {
  it("runs first, skips no change, regrades a grader-only change, runs otherwise", () => {
    assert.equal(decideMode(undefined, fp("t", "g")), "run");
    assert.equal(decideMode(fp("t", "g"), fp("t", "g")), undefined);
    assert.equal(decideMode(fp("t", "g"), fp("t", "g"), true), "run");
    assert.equal(decideMode(fp("t", "g"), fp("t", "g2")), "regrade");
    assert.equal(decideMode(fp("t", "g"), fp("t2", "g")), "run");
    assert.equal(decideMode(fp("t", "g"), fp("t2", "g2")), "run");
  });
});

describe("startWatchLoop", () => {
  it("runs once at start, gives one rerun for three rapid saves, and ignores other files", async () => {
    const w = fakeWatcher();
    const t = fakeTimers();
    let version = 0;
    const modes: WatchMode[] = [];
    const loop = startWatchLoop<WatchLoad>({
      initial: { fp: fp("t0", "g"), targets: [target] },
      load: async () => ({ fp: fp(`t${version}`, "g"), targets: [target] }),
      execute: async (m) => (modes.push(m), true),
      onError: (e) => assert.fail(String(e)),
      watcher: w.watcher,
      timers: t.timers,
    });
    await settle();
    assert.deepEqual(modes, ["run"]);
    w.emit("node_modules/x.js");
    w.emit("other.txt");
    w.emit(".git/index");
    assert.equal(t.pending, false, "ignored paths schedule nothing");
    version = 1;
    w.emit("agent.mjs");
    w.emit("agent.mjs");
    w.emit("spec.json");
    t.fire();
    await settle();
    assert.deepEqual(modes, ["run", "run"]);
    // A save that changes nothing (same fingerprint) is skipped.
    w.emit("agent.mjs");
    t.fire();
    await settle();
    assert.deepEqual(modes, ["run", "run"]);
    loop.quit();
    await loop.done;
    assert.equal(w.open.size, 0, "watchers closed");
  });

  it("aborts the run in flight on a change and keeps nothing from it", async () => {
    const w = fakeWatcher();
    const t = fakeTimers();
    let version = 0;
    const finished: string[] = [];
    let release!: () => void;
    const loop = startWatchLoop<WatchLoad>({
      initial: { fp: fp("t0", "g"), targets: [target] },
      load: async () => ({ fp: fp(`t${version}`, "g"), targets: [target] }),
      execute: async (_m, l, signal) => {
        if (l.fp.task === "t0") {
          // The first run hangs until the change aborts it.
          await new Promise<void>((r) => {
            release = r;
            signal.addEventListener("abort", () => r(), { once: true });
          });
          if (signal.aborted) return false;
        }
        finished.push(l.fp.task);
        return true;
      },
      onError: (e) => assert.fail(String(e)),
      watcher: w.watcher,
      timers: t.timers,
    });
    await settle();
    version = 1;
    w.emit("agent.mjs"); // aborts t0
    await settle();
    t.fire();
    await settle();
    assert.deepEqual(finished, ["t1"], "the aborted run is not kept");
    release?.();
    loop.quit();
    await loop.done;
  });

  it("reports a broken spec and keeps watching", async () => {
    const w = fakeWatcher();
    const t = fakeTimers();
    const errors: string[] = [];
    let broken = false;
    let version = 0;
    const runs: string[] = [];
    const loop = startWatchLoop<WatchLoad>({
      initial: { fp: fp("t0", "g"), targets: [target] },
      load: async () => {
        if (broken) throw new Error("spec.json: Unexpected token");
        return { fp: fp(`t${version}`, "g"), targets: [target] };
      },
      execute: async (_m, l) => (runs.push(l.fp.task), true),
      onError: (e) => errors.push((e as Error).message),
      watcher: w.watcher,
      timers: t.timers,
    });
    await settle();
    broken = true;
    w.emit("spec.json");
    t.fire();
    await settle();
    assert.deepEqual(errors, ["spec.json: Unexpected token"]);
    broken = false;
    version = 1;
    w.emit("spec.json");
    t.fire();
    await settle();
    assert.deepEqual(runs, ["t0", "t1"]);
    loop.trigger(); // Enter: reruns with nothing changed
    await settle();
    assert.deepEqual(runs, ["t0", "t1", "t1"]);
    loop.quit();
    await loop.done;
  });

  it("goes run → regrade → run, and a regrade makes no task calls", async () => {
    const ds = createDataset({ name: "upper", createdAt: 1, cases: ["a", "b", "c", "d"].map((q) => ({ id: q, input: { q }, expected: q.toUpperCase() })) });
    const calls = { n: 0 };
    const task = (wrong: string[]) => ({ kind: "function" as const, fn: (i: unknown) => (calls.n++, wrong.includes((i as { q: string }).q) ? "x" : (i as { q: string }).q.toUpperCase()) });
    const strictOnA: Grader = { id: "exact", version: "v2", kind: "exact", grade: async (c) => ({ pass: c.caseId !== "a" && c.output === c.expected, score: 0 }) };
    const state = { task: "t1", graders: "g1", wrong: ["d"], grader: exactGrader() as Grader };
    const w = fakeWatcher();
    const t = fakeTimers();
    const log: { mode: WatchMode; calls: number; passed: number }[] = [];
    let last: ExperimentResult | undefined;
    const loop = startWatchLoop<WatchLoad>({
      initial: { fp: fp(state.task, state.graders), targets: [target] },
      load: async () => ({ fp: fp(state.task, state.graders), targets: [target] }),
      execute: async (mode, _l, signal) => {
        const before = calls.n;
        const r =
          mode === "regrade"
            ? await regradeExperiment({ result: last!, dataset: ds, graders: [state.grader], signal })
            : await runExperiment({ name: "w", dataset: ds, task: task(state.wrong), graders: [state.grader], signal });
        last = r;
        log.push({ mode, calls: calls.n - before, passed: r.summary.passed });
        return true;
      },
      onError: (e) => assert.fail(String(e)),
      watcher: w.watcher,
      timers: t.timers,
    });
    await settle(30);
    state.graders = "g2";
    state.grader = strictOnA;
    w.emit("spec.json");
    t.fire();
    await settle(30);
    state.task = "t2";
    state.wrong = [];
    w.emit("agent.mjs");
    t.fire();
    await settle(30);
    loop.quit();
    await loop.done;
    assert.deepEqual(log, [
      { mode: "run", calls: 4, passed: 3 },
      { mode: "regrade", calls: 0, passed: 2 },
      { mode: "run", calls: 4, passed: 3 },
    ]);
  });
});

describe("specFingerprint", () => {
  it("puts the task's script on the task side and grader files on the grader side", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-watchfp-")));
    dirs.push(dir);
    writeFileSync(join(dir, "agent.mjs"), "v1");
    writeFileSync(join(dir, "grade.mjs"), "export default () => true");
    writeFileSync(join(dir, "prompt.md"), "p1");
    writeFileSync(join(dir, "spec.json"), "{}");
    const input = {
      task: { kind: "command", command: "node", args: ["agent.mjs"] },
      graders: [{ kind: "module", module: "./grade.mjs" }],
      dataset: "ds@v1",
      specFile: join(dir, "spec.json"),
      cwd: dir,
      baseDir: dir,
      watch: ["*.md"],
    };
    const a = await specFingerprint(input);
    assert.deepEqual(Object.keys(a.files).sort(), ["agent.mjs", "grade.mjs", "prompt.md", "spec.json"]);
    writeFileSync(join(dir, "grade.mjs"), "export default () => false");
    const b = await specFingerprint(input);
    assert.equal(b.task, a.task);
    assert.notEqual(b.graders, a.graders);
    writeFileSync(join(dir, "prompt.md"), "p2");
    const c = await specFingerprint(input);
    assert.notEqual(c.task, b.task);
    assert.equal(c.graders, b.graders);
    assert.ok(a.targets.some((x) => x.dir === dir && !x.recursive && x.match("agent.mjs") && x.match("grade.mjs") && !x.match("other.js")));
    assert.ok(a.targets.some((x) => x.recursive && x.match("notes.md")));
    // A literal entry is watched through its folder (editors replace the file), with the rest.
    const lit = await specFingerprint({ ...input, watch: ["prompt.md"] });
    assert.deepEqual(lit.targets.map((x) => [x.dir, x.recursive, x.match("prompt.md"), x.match("other.md")]), [[dir, false, true, false]]);
  });
});
