// Eval suites on disk: `evals/<name>/suite.json`, written by `coding.sh eval
// init` and run by `coding.sh eval run`. A suite is one of three kinds, told
// apart by which field it has:
//
//   tasks     "tasks": "tasks"        repo tasks (eval import's task dirs), run by an agent
//   cases     "cases": "cases.jsonl"  dataset cases, run by a command or HTTP task and graded
//   triggers  "skill": "<dir>"        a skill's should / should_not prompts (eval trigger)
//
// A cases suite carries the same fields as an `exp run` spec (task, graders,
// trials, split), so `coding.sh exp run evals/<name>/suite.json` reads it too
// once the dataset is imported. Paths are relative to the suite dir.
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SUITE_PURPOSES, type SuitePurpose } from "./report.ts";

export const SUITE_FILE = "suite.json";
/** Where `eval init` writes suites and `eval run` looks for them, under the project root. */
export const SUITES_DIR = "evals";
export const DEFAULT_TRIALS = 3;

export type SuiteKind = "tasks" | "cases" | "triggers";

export interface SuiteSpec {
  name: string;
  /** capability: a hill to climb, starts low. regression: should pass nearly everything. */
  purpose: SuitePurpose;
  /** Trials per task, case or prompt (default 3). */
  trials?: number;
  description?: string;
  /** tasks: the dir holding one task dir per task (task.json, instruction.md, tests/, reference.patch). */
  tasks?: string;
  /** tasks, triggers: the agent that runs them (default claude-code). */
  agent?: string;
  /** tasks: a stored harness bundle (default: a snapshot of the project's current setup). */
  harness?: string;
  model?: string;
  /** cases: a JSONL, JSON or CSV file of {"input", "expected"} cases. */
  cases?: string;
  /** cases: the dataset to import them into (default: the suite name). */
  dataset?: string;
  task?: Record<string, unknown>;
  graders?: Record<string, unknown>[];
  concurrency?: number;
  split?: string;
  /** triggers: the skill dir. */
  skill?: string;
  /** triggers: the trigger spec (default: triggers.toml in the suite dir). */
  triggers?: string;
}

export interface LoadedSuite {
  dir: string;
  file: string;
  spec: SuiteSpec;
  kind: SuiteKind;
}

export class SuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuiteError";
  }
}

export function suiteKind(s: Pick<SuiteSpec, "tasks" | "cases" | "skill">): SuiteKind | undefined {
  const kinds = (["tasks", "cases", "skill"] as const).filter((k) => typeof s[k] === "string" && s[k] !== "");
  if (kinds.length !== 1) return undefined;
  return kinds[0] === "skill" ? "triggers" : kinds[0];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse and check a suite.json; `file` names it in errors. */
export function parseSuite(text: string, file: string): SuiteSpec {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new SuiteError(`${file}: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isObj(v)) throw new SuiteError(`${file}: expected a JSON object`);
  const name = typeof v.name === "string" && v.name.trim() ? v.name.trim() : basename(dirname(file));
  const purpose = v.purpose ?? "capability";
  if (!SUITE_PURPOSES.includes(purpose as SuitePurpose)) throw new SuiteError(`${file}: "purpose" must be "capability" or "regression", got ${JSON.stringify(purpose)}`);
  if (v.trials !== undefined && !(Number.isInteger(v.trials) && (v.trials as number) >= 1)) throw new SuiteError(`${file}: "trials" must be a whole number ≥ 1`);
  const spec = { ...v, name, purpose } as SuiteSpec;
  const kind = suiteKind(spec);
  if (!kind) throw new SuiteError(`${file}: give exactly one of "tasks" (a dir of task dirs), "cases" (a cases file) or "skill" (a skill dir)`);
  if (kind === "cases") {
    if (!isObj(spec.task)) throw new SuiteError(`${file}: a cases suite needs "task", e.g. {"kind":"command","command":"node","args":["app.mjs"]}`);
    if (!Array.isArray(spec.graders) || !spec.graders.length || !spec.graders.every(isObj)) throw new SuiteError(`${file}: a cases suite needs "graders", e.g. [{"kind":"exact"}]`);
  }
  return spec;
}

export async function loadSuite(dirOrFile: string): Promise<LoadedSuite> {
  const file = dirOrFile.endsWith(".json") ? dirOrFile : join(dirOrFile, SUITE_FILE);
  const text = await readFile(file, "utf8").catch(() => {
    throw new SuiteError(`No ${SUITE_FILE} in ${dirname(file)}`);
  });
  const spec = parseSuite(text, file);
  return { dir: dirname(file), file, spec, kind: suiteKind(spec)! };
}

/** The suites under `<root>/evals`, by dir name. */
export function suiteDirs(root: string): string[] {
  const base = join(root, SUITES_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => existsSync(join(base, d, SUITE_FILE)))
    .sort()
    .map((d) => join(base, d));
}

/**
 * What `eval run <ref>` names: a dir or file path, else a suite name under
 * `<root>/evals`. No refs: every suite under `<root>/evals`.
 */
export async function resolveSuites(refs: readonly string[], cwd: string, root: string): Promise<LoadedSuite[]> {
  if (!refs.length) {
    const dirs = suiteDirs(root);
    if (!dirs.length) throw new SuiteError(`No suites in ${join(root, SUITES_DIR)}`);
    return Promise.all(dirs.map((d) => loadSuite(d)));
  }
  const out: LoadedSuite[] = [];
  for (const ref of refs) {
    const path = resolve(cwd, ref);
    if (existsSync(path) && (statSync(path).isDirectory() || path.endsWith(".json"))) out.push(await loadSuite(path));
    else if (existsSync(join(root, SUITES_DIR, ref, SUITE_FILE))) out.push(await loadSuite(join(root, SUITES_DIR, ref)));
    else {
      const known = suiteDirs(root).map((d) => basename(d));
      throw new SuiteError(`No suite ${JSON.stringify(ref)}${known.length ? ` (suites here: ${known.join(", ")})` : ` in ${join(root, SUITES_DIR)}`}`);
    }
  }
  return out;
}

/** The task dirs of a tasks suite: each subdir of its "tasks" dir with a task.json. */
export function taskDirs(s: LoadedSuite): string[] {
  const base = resolve(s.dir, s.spec.tasks ?? "tasks");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => existsSync(join(base, d, "task.json")))
    .sort()
    .map((d) => join(base, d));
}
