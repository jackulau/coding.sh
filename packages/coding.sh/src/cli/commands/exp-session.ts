// Experiment sessions and `exp run --watch` (X-12, src/experiments/session.ts and watch.ts).
//   exp session new [--name <topic>]   start a session in this folder (.coding-sh/session.json)
//   exp session note <text…>           add a note (hypothesis before a run, reading after it)
//   exp session summary                the timeline, oldest first
// `exp run` in a session appends the run and prints its delta against the
// previous run on the same dataset; `--no-session` skips both.
import { relative } from "node:path";
import { createInterface } from "node:readline";
import { sha256Hex } from "../../core/ids.ts";
import { createRedactor, redactArgv } from "../../core/redact.ts";
import type { FileEvalStore } from "../../datasets/store.ts";
import type { ExperimentResult } from "../../datasets/types.ts";
import { renderSessionDelta, renderSessionSummary } from "../../experiments/render.ts";
import { prepareGraders, regradeExperiment, runExperiment } from "../../experiments/run.ts";
import {
  appendBlock,
  experimentBlock,
  findSession,
  newSession,
  readTimeline,
  recordExperiment,
  sessionDelta,
  type ExperimentBlock,
  type ExpSession,
} from "../../experiments/session.ts";
import { specFingerprint, startWatchLoop, type Fingerprint, type WatchMode, type WatchTarget } from "../../experiments/watch.ts";
import { pct } from "../../experiments/text.ts";
import { UsageError } from "../args.ts";
import { list, str } from "../common.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { loadSpec, type LoadedSpec } from "./exp.ts";

/** Notes longer than this are refused (MCP takes the same limit). */
export const NOTE_MAX = 4000;

/** What `exp run --json` adds under `session`. */
export interface JoinedSession {
  id: string;
  name?: string;
  block: ExperimentBlock;
}

const noSession = () =>
  new CliError("No experiment session here", {
    reason: "not_found",
    next: ["Start one in this folder (runs here and below join it):", "coding.sh exp session new --name <topic>"],
  });

/** The session `exp run` joins, unless --no-session. */
function activeSession(c: CommandContext): ExpSession | undefined {
  return c.flags.session === false ? undefined : findSession({ cwd: c.cwd, env: c.env });
}

/** The run's watched-file hashes and spec hash, for the session block. */
async function fingerprintOf(c: CommandContext, loaded: LoadedSpec): Promise<Fingerprint & { targets: WatchTarget[] }> {
  const { spec, dataset } = loaded;
  return specFingerprint({
    task: spec.task,
    graders: spec.graders ?? [],
    dataset: `${dataset.id}@${dataset.version}`,
    ...(spec.split ? { split: spec.split } : {}),
    ...(spec.trials ? { trials: spec.trials } : {}),
    ...(loaded.file ? { specFile: loaded.file } : {}),
    cwd: c.cwd,
    baseDir: loaded.baseDir ?? c.cwd,
    watch: [...(Array.isArray(spec.watch) ? spec.watch : []), ...list(c.flags["watch-path"])],
  });
}

const specHash = (fp: Pick<Fingerprint, "task" | "graders">) => sha256Hex(`${fp.task}\n${fp.graders}`).slice(0, 16);
const commandLine = (c: CommandContext) => `coding.sh ${redactArgv(c.argv ?? ["exp", c.action ?? ""]).join(" ")}`;

/** `exp run` in a session: append the command and the run, with its delta against the previous run. */
export async function recordRun(c: CommandContext, store: FileEvalStore, result: ExperimentResult, loaded: LoadedSpec): Promise<JoinedSession | undefined> {
  const session = activeSession(c);
  if (!session) return undefined;
  const fp = await fingerprintOf(c, loaded);
  await appendBlock(store.root, session.id, { kind: "command", at: Date.now(), command: commandLine(c) });
  const block = await recordExperiment(store.root, session, result, { load: (id) => store.getExperiment(id), specHash: specHash(fp), files: fp.files });
  return { id: session.id, ...(session.name ? { name: session.name } : {}), block };
}

/** The delta block for a joined run, as printed after the experiment. */
export function deltaText(c: CommandContext, joined: JoinedSession): string {
  return renderSessionDelta(joined.block, { color: c.out.color, session: joined.name ?? joined.id }).join("\n");
}

export async function sessionCommand(c: CommandContext, store: FileEvalStore): Promise<number> {
  const { out } = c;
  const [verb, ...words] = c.positionals;
  switch (verb) {
    case "new": {
      const name = str(c.flags.name);
      const s = newSession({ cwd: c.cwd, ...(name ? { name } : {}) });
      if (out.json) out.data({ session: s });
      else {
        out.print(s.id);
        out.ok(`Started session ${name ? `${name} ` : ""}(${s.id}); runs in this folder and below join it`);
      }
      return 0;
    }
    case "note": {
      const session = findSession({ cwd: c.cwd, env: c.env });
      if (!session) throw noSession();
      const raw = words.join(" ").trim();
      if (!raw) throw new UsageError('Missing note text, e.g. coding.sh exp session note "hypothesis: a shorter prompt fixes c3"', { reason: "missing_argument" });
      if (raw.length > NOTE_MAX) throw new UsageError(`A note is at most ${NOTE_MAX} characters (got ${raw.length})`, { reason: "invalid_argument" });
      const block = { kind: "note" as const, at: Date.now(), text: createRedactor({ env: c.env }).string(raw) };
      await appendBlock(store.root, session.id, block);
      if (out.json) out.data({ session: { id: session.id, ...(session.name ? { name: session.name } : {}) }, block });
      else out.ok(`Noted in session ${session.name ?? session.id}`);
      return 0;
    }
    case "summary": {
      const session = findSession({ cwd: c.cwd, env: c.env });
      if (!session) throw noSession();
      const blocks = await readTimeline(store.root, session.id);
      if (out.json) out.data({ session: { id: session.id, ...(session.name ? { name: session.name } : {}), ...(session.createdAt ? { createdAt: new Date(session.createdAt).toISOString() } : {}) }, blocks });
      else out.print(renderSessionSummary(session, blocks, { color: out.color }));
      return 0;
    }
  }
  throw new UsageError(`exp session takes new, note or summary${verb ? ` (got ${JSON.stringify(verb)})` : ""}`, {
    reason: verb ? "invalid_argument" : "missing_argument",
    suggestion: "coding.sh exp session new --name <topic>",
  });
}

interface Loaded {
  loaded: LoadedSpec;
  fp: Fingerprint;
  targets: WatchTarget[];
}

/**
 * `exp run --watch`: run, then rerun on every change to what the run reads
 * (abort the run in flight; regrade when only the graders changed). Enter
 * reruns, q quits, Ctrl-C exits 0.
 */
export async function watchRun(c: CommandContext, store: FileEvalStore, specFile: string | undefined): Promise<number> {
  const { out } = c;
  if (out.json) throw new UsageError("--watch prints a block per run; it does not combine with --json", { reason: "invalid_argument" });
  if (c.flags.resume !== undefined) throw new UsageError("--watch starts a fresh run on every change; it does not combine with --resume", { reason: "invalid_argument" });
  const load = async (): Promise<Loaded> => {
    const loaded = await loadSpec(c, store, specFile);
    const fp = await fingerprintOf(c, loaded);
    return { loaded, fp, targets: fp.targets };
  };
  const initial = await load(); // a broken spec fails here, before watching
  if (!initial.targets.length) {
    throw new UsageError("--watch needs files to watch: give a spec file, a command task whose script is a file, or --watch-path <GLOB>", { reason: "invalid_argument" });
  }
  const session = activeSession(c);
  if (session) await appendBlock(store.root, session.id, { kind: "command", at: Date.now(), command: commandLine(c) });
  c.interruptExit?.(0);
  const stop = c.drain ?? c.signal;
  let prev: { result: ExperimentResult; block: ExperimentBlock } | undefined;
  const indent = (l: string) => `          ${l}`;

  const execute = async (mode: WatchMode, l: Loaded, signal: AbortSignal): Promise<boolean> => {
    const { spec, dataset, graders, name } = l.loaded;
    if (mode === "regrade" && !prev) return false;
    const label = mode === "regrade" ? `Regrading ${prev!.result.id}` : `Running ${dataset.name}`;
    const spin = out.spin(`${label}…`);
    let result: ExperimentResult;
    try {
      if (mode === "regrade") {
        result = await regradeExperiment({
          result: prev!.result,
          dataset,
          graders,
          store,
          signal,
          name,
          ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
          onWarn: (m) => out.warn(m),
          onProgress: (done, total) => spin.update(`${label}… ${done}/${total}`),
        });
      } else {
        result = await runExperiment({
          name,
          dataset,
          task: spec.task!,
          graders: await prepareGraders(graders, store),
          ...(spec.trials ? { trials: spec.trials } : {}),
          ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
          ...(spec.split ? { split: spec.split } : {}),
          signal,
          onProgress: (_r, done, total) => spin.update(`${label}… ${done}/${total}`),
        });
      }
    } finally {
      spin.stop();
    }
    // A change mid-run makes it stale: nothing is stored, the next run starts.
    if (signal.aborted || result.status !== "completed") return false;
    if (mode === "run") await store.putExperiment(result);
    const block = session
      ? await recordExperiment(store.root, session, result, { load: (id) => store.getExperiment(id), specHash: specHash(l.fp), files: l.fp.files })
      : experimentBlock(result, {
          specHash: specHash(l.fp),
          files: l.fp.files,
          ...(prev ? { previous: prev.block } : {}),
          ...(prev && prev.result.dataset.id === result.dataset.id ? { delta: sessionDelta(prev.result, result) } : {}),
        });
    const s = result.summary;
    const how = mode === "regrade" ? `regrade of ${prev!.result.id}, 0 task calls` : `${s.n} case run${s.n === 1 ? "" : "s"}`;
    out.print(`${new Date().toTimeString().slice(0, 8)}  ${mode.padEnd(7)} ${result.id}  pass ${pct(s.passRate.p)} (${s.passed}/${s.n - (s.ungraded ?? 0)})  ${how}`);
    for (const line of renderSessionDelta(block, { color: out.color, ...(session ? { session: session.name ?? session.id } : {}) })) out.print(indent(line));
    prev = { result, block };
    return true;
  };

  const what = [...new Set(initial.targets.map((t) => relative(c.cwd, t.dir) || "."))].join(", ");
  process.stderr.write(`Watching ${what}${session ? ` in session ${session.name ?? session.id}` : ""}; Enter reruns, q quits, Ctrl-C stops.\n`);
  const loop = startWatchLoop<Loaded>({
    initial,
    load,
    execute,
    onError: (e) => out.warn(e instanceof Error ? e.message : String(e)),
  });
  const onStop = () => loop.quit();
  if (stop.aborted) loop.quit();
  else stop.addEventListener("abort", onStop, { once: true });
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined;
  rl?.on("line", (line) => {
    const t = line.trim().toLowerCase();
    if (t === "q" || t === "quit") loop.quit();
    else if (!t) loop.trigger();
  });
  await loop.done;
  rl?.close();
  stop.removeEventListener("abort", onStop);
  return 0;
}
