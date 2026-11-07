// `exp run --watch` (X-12): rerun an experiment when its spec, the task's
// script, the graders' files or `watch` globs change. A change aborts the run
// in flight (an aborted run is never stored); when only the graders changed
// since the last finished run, the stored outputs are graded again instead of
// calling the task (run.ts regradeExperiment). The watcher and the timers are
// injectable so the loop is tested without a file system or a clock.
import { statSync, watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../core/ids.ts";
import { canonicalJson } from "../datasets/hash.ts";
import { commandFiles } from "../jobs/config.ts";
import { collect } from "../runner/bundle.ts";
import { matchGlob, staticPrefix } from "../runner/glob.ts";

/** Saves closer together than this give one rerun. */
export const DEBOUNCE_MS = 300;
const IGNORED = new Set([".git", "node_modules", ".coding-sh"]);

/** A directory to watch and which paths under it (relative, POSIX) count. */
export interface WatchTarget {
  dir: string;
  recursive: boolean;
  match: (rel: string) => boolean;
}

/** What a run measures, split by side: a grader-only change can be a regrade. */
export interface Fingerprint {
  task: string;
  graders: string;
  /** Watched file (relative to the spec's folder when under it) → content hash. */
  files: Record<string, string>;
}

export interface FingerprintInput {
  task: unknown;
  graders: readonly unknown[];
  /** `<dataset id>@<version>`. */
  dataset: string;
  split?: string;
  trials?: number;
  specFile?: string;
  /** Where the task and command graders run (relative paths in them resolve here). */
  cwd: string;
  /** The spec's folder: module graders and `watch` globs resolve here. */
  baseDir: string;
  /** Extra files whose change reruns the task (spec `watch` plus `--watch-path`). */
  watch?: readonly string[];
}

const hash = (v: unknown) => sha256Hex(canonicalJson(v)).slice(0, 16);

/** A grader spec's own files: a command grader's program and file arguments, a module grader's module. */
function graderFiles(g: unknown, cwd: string, baseDir: string): string[] {
  if (!g || typeof g !== "object") return [];
  const s = g as { kind?: unknown; module?: unknown };
  if (s.kind === "command") return commandFiles(g, cwd).map((f) => f.path);
  if (s.kind === "module" && typeof s.module === "string") {
    if (s.module.startsWith("file:")) return [fileURLToPath(s.module)];
    return [isAbsolute(s.module) ? s.module : resolve(baseDir, s.module)];
  }
  return [];
}

async function fileHash(path: string): Promise<string> {
  try {
    return sha256Hex(await readFile(path)).slice(0, 16);
  } catch {
    return "missing";
  }
}

const posix = (p: string) => p.split(sep).join("/");

/** The run's fingerprint and what to watch for it. */
export async function specFingerprint(i: FingerprintInput): Promise<Fingerprint & { targets: WatchTarget[] }> {
  const taskFiles = commandFiles(i.task, i.cwd).map((f) => f.path);
  const globs = i.watch ?? [];
  const globbed = (await Promise.all(globs.map((g) => collect(i.baseDir, g)))).flat().map((p) => resolve(i.baseDir, p));
  const gFiles = i.graders.flatMap((g) => graderFiles(g, i.cwd, i.baseDir));
  const label = (p: string) => {
    const rel = relative(i.baseDir, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? posix(rel) : posix(p);
  };
  const files: Record<string, string> = {};
  const hashes = async (ps: string[]) => {
    const out: Record<string, string> = {};
    for (const p of [...new Set(ps)].sort()) out[label(p)] = files[label(p)] = await fileHash(p);
    return out;
  };
  const taskSide = await hashes([...taskFiles, ...globbed]);
  const graderSide = await hashes(gFiles);
  if (i.specFile) files[label(i.specFile)] = await fileHash(i.specFile);
  const task = hash({ task: i.task, dataset: i.dataset, split: i.split ?? null, trials: i.trials ?? 1, files: taskSide });
  const graders = hash({ graders: i.graders, files: graderSide });
  // Each single file through its folder (editors replace files, so watch the folder), plus each glob's fixed prefix.
  // A literal `watch` entry is a single file (or a whole folder); the rest are globs.
  const pats = globs.map((g) => g.replace(/^\.\//, ""));
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const literal = pats.filter((p) => staticPrefix(p) === p).map((p) => resolve(i.baseDir, p));
  const singles = [...new Set([...(i.specFile ? [i.specFile] : []), ...taskFiles, ...gFiles, ...literal.filter((p) => !isDir(p))])];
  const byDir = new Map<string, Set<string>>();
  for (const f of singles) byDir.set(dirname(f), (byDir.get(dirname(f)) ?? new Set()).add(posix(relative(dirname(f), f))));
  const targets: WatchTarget[] = [...byDir].map(([dir, names]) => ({ dir, recursive: false, match: (rel: string) => names.has(rel) }));
  for (const dir of literal.filter(isDir)) targets.push({ dir, recursive: true, match: () => true });
  for (const pat of pats.filter((p) => staticPrefix(p) !== p)) {
    const prefix = staticPrefix(pat);
    targets.push({ dir: resolve(i.baseDir, prefix), recursive: true, match: (rel: string) => matchGlob(prefix ? `${prefix}/${rel}` : rel, pat) });
  }
  return { task, graders, files, targets };
}

export type WatchMode = "run" | "regrade";

/**
 * What a change calls for, against the last finished iteration: nothing when
 * neither side changed (a forced rerun still runs), a regrade when only the
 * graders changed, else a run.
 */
export function decideMode(last: Pick<Fingerprint, "task" | "graders"> | undefined, next: Pick<Fingerprint, "task" | "graders">, force = false): WatchMode | undefined {
  if (!last) return "run";
  const sameTask = last.task === next.task;
  if (sameTask && last.graders === next.graders) return force ? "run" : undefined;
  return sameTask ? "regrade" : "run";
}

export type Watcher = (dir: string, opts: { recursive: boolean }, onEvent: (file: string | null) => void) => { close(): void };
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** fs.watch, falling back to a non-recursive watch where recursive is unsupported. */
export const fsWatcher: Watcher = (dir, opts, onEvent) => {
  const cb = (_e: string, f: string | Buffer | null) => onEvent(f === null ? null : String(f));
  try {
    return fsWatch(dir, { recursive: opts.recursive }, cb);
  } catch {
    return fsWatch(dir, cb);
  }
};

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface WatchLoad {
  fp: Fingerprint;
  targets: WatchTarget[];
}

export interface WatchLoopOpts<L extends WatchLoad> {
  /** The first load, done by the caller (so a broken spec fails before watching starts). */
  initial: L;
  /** Read the spec again; a throw (a parse error) is reported and watching goes on. */
  load(): Promise<L>;
  /** Run or regrade; true when it finished and was stored. Aborted through `signal` by the next change. */
  execute(mode: WatchMode, loaded: L, signal: AbortSignal): Promise<boolean>;
  onError(e: unknown): void;
  /** A change that touched neither side. */
  onSkip?(): void;
  watcher?: Watcher;
  timers?: Timers;
  debounceMs?: number;
}

export interface WatchLoop {
  /** Rerun now (Enter): runs even when nothing changed. */
  trigger(): void;
  /** Stop: aborts a run in flight and closes the watchers. */
  quit(): void;
  /** Settles once quit and the run in flight (if any) returned. */
  done: Promise<void>;
}

/** Start watching: the first iteration runs at once. */
export function startWatchLoop<L extends WatchLoad>(o: WatchLoopOpts<L>): WatchLoop {
  const watcher = o.watcher ?? fsWatcher;
  const timers = o.timers ?? realTimers;
  const debounce = o.debounceMs ?? DEBOUNCE_MS;
  let last: Fingerprint | undefined; // the last iteration that finished
  let timer: unknown;
  let running = false;
  let pending: { force: boolean } | undefined;
  let inflight: AbortController | undefined;
  let quitting = false;
  let watched = "";
  let handles: { close(): void }[] = [];
  let current: WatchTarget[] = [];
  let first: L | undefined = o.initial;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const closeWatchers = () => {
    for (const h of handles) h.close();
    handles = [];
  };
  const onEvent = (t: WatchTarget, file: string | null) => {
    if (quitting) return;
    const rel = file === null ? null : posix(file);
    if (rel !== null && (rel.split("/").some((s) => IGNORED.has(s)) || !t.match(rel))) return;
    inflight?.abort(); // a change makes the run in flight stale
    if (timer !== undefined) timers.clear(timer);
    timer = timers.set(() => {
      timer = undefined;
      void tick(false);
    }, debounce);
  };
  const rewatch = (targets: WatchTarget[]) => {
    const key = targets.map((t) => `${t.dir}\0${t.recursive}`).sort().join("\n");
    if (key === watched) {
      // Same folders: keep the handles, but take the new match functions.
      current = targets;
      return;
    }
    closeWatchers();
    watched = key;
    current = targets;
    for (const [i, t] of targets.entries()) {
      try {
        handles.push(watcher(t.dir, { recursive: t.recursive }, (f) => onEvent(current[i] ?? t, f)));
      } catch (e) {
        o.onError(new Error(`can't watch ${t.dir}: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  };

  const tick = async (force: boolean): Promise<void> => {
    if (quitting) return;
    if (running) {
      pending = { force: force || !!pending?.force };
      return;
    }
    running = true;
    try {
      const loaded = first ?? (await o.load());
      first = undefined;
      rewatch(loaded.targets);
      const mode = decideMode(last, loaded.fp, force);
      if (!mode) o.onSkip?.();
      else if (!quitting) {
        const ac = new AbortController();
        inflight = ac;
        const ok = await o.execute(mode, loaded, ac.signal).catch((e: unknown) => {
          if (!ac.signal.aborted) o.onError(e);
          return false;
        });
        inflight = undefined;
        if (ok && !ac.signal.aborted) last = loaded.fp;
      }
    } catch (e) {
      o.onError(e);
    } finally {
      running = false;
    }
    if (quitting) return finish();
    if (pending) {
      const p = pending;
      pending = undefined;
      return tick(p.force);
    }
  };
  const finish = () => {
    closeWatchers();
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    resolveDone();
  };
  void tick(true);
  return {
    trigger: () => {
      if (quitting) return;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      inflight?.abort();
      void tick(true);
    },
    quit: () => {
      if (quitting) return;
      quitting = true;
      inflight?.abort();
      if (!running) finish();
    },
    done,
  };
}
