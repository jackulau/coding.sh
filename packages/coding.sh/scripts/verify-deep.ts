// Runs the formal models and property tests in test/verify past their default bounds, one file at a
// time: each model at a raised CODING_SH_MODEL_BOUND, each property file with more
// CODING_SH_PROP_RUNS. The nightly workflow (.github/workflows/verify-deep.yml) runs it, and so can
// you, from packages/coding.sh:
//
//   npm run verify:deep                                   every file with its NIGHTLY knobs
//   npm run verify:deep -- lock-model fold-prop           some files, by name or by path
//   CODING_SH_MODEL_BOUND=1 npm run verify:deep           every model at bound 1
//   CODING_SH_PROP_SEED=1234 npm run verify:deep -- fold-prop      the seed of an earlier run
//
// A knob set in the environment replaces the table's value for every file that reads that knob. An
// empty one counts as unset. The property files share one seed: CODING_SH_PROP_SEED when it is set,
// otherwise a random one. The seed is printed first. A file that runs past its time limit (--minutes,
// default 40) is stopped and counts as failed. --out <dir> keeps each file's output, seed.txt and
// summary.md there (default: a new temp folder). summary.md is written again after each file, and at
// the end the summary also goes to $GITHUB_STEP_SUMMARY when that is set. A model past its default
// bound can need several GB of heap: raise it with NODE_OPTIONS=--max-old-space-size=<MB>. Exits 1
// when a file fails, 2 on a bad knob or argument.
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The knobs a file runs with: the model bound and the property runs. A knob the file does not read is absent. */
export interface Knobs {
  bound?: number;
  runs?: number;
}

/**
 * Each verify file's knobs on a nightly run, by file name without `.test.ts`. Every file in test/verify
 * has a row, `{}` when it reads no knob. The times are from one desk machine, one file at a time, and
 * are rough. A property file without a time takes under half a minute. Every file together: about 9
 * minutes.
 */
export const NIGHTLY: Readonly<Record<string, Knobs>> = {
  // Each case spools real hook lines and runs the real ingest on them: about 2.5 minutes. 1000 runs take
  // about 9.
  "capture-code": { runs: 200 },
  // Its state count stops growing at bound 2: 36,170 and 65,414 states in its first two runs, the same
  // at bounds 3 and 6. About 20 seconds.
  "capture-model": { bound: 2 },
  "cost-prop": { runs: 10000 },
  "fold-prop": { runs: 5000 },
  "hook-imports": {},
  // About 1 minute and 3 GB of heap.
  "lock-model": { bound: 2 },
  model: {},
  // Its properties check forAll itself, each with an environment of its own, so no knob reaches them.
  prop: {},
  "redact-prop": { runs: 10000 },
  // About 3 minutes and 6.5 GB of heap. At bound 3 the first run alone has 3,443,232 states and needs 8 GB.
  "refold-model": { bound: 2 },
  "short-id-prop": { runs: 10000 },
  // About 1.5 minutes and 2 GB of heap.
  "work-model": { bound: 1 },
  "work-snooze": {},
};

/** The variables that carry the knobs. A file gets only the ones it reads. */
export const KNOB_VARS = ["CODING_SH_MODEL_BOUND", "CODING_SH_PROP_RUNS", "CODING_SH_PROP_SEED"] as const;

const PKG = fileURLToPath(new URL("../", import.meta.url));
const VERIFY = join(PKG, "test", "verify");
const TWO_32 = 2 ** 32;

/** A bad knob or argument: the run exits 2 before any file starts. */
export class UsageError extends Error {}

export interface FilePlan {
  /** The file name without `.test.ts`. */
  name: string;
  /** The path to run, from packages/coding.sh when the file is in it. */
  file: string;
  /** The knob variables the file runs with. */
  vars: Record<string, string>;
}

export interface Plan {
  seed: number;
  /** "CODING_SH_PROP_SEED", or "random" when the run picked the seed. */
  seedFrom: string;
  /** The knob variables set in the environment, as given. */
  given: Record<string, string>;
  files: FilePlan[];
}

/** The names of the files in test/verify, sorted. */
export function verifyFiles(dir: string = VERIFY): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.slice(0, -".test.ts".length))
    .sort();
}

/** A whole-number knob from `env`, or undefined when it is unset or empty. Throws on a value its tests would reject. */
function knob(env: NodeJS.ProcessEnv, name: "CODING_SH_MODEL_BOUND" | "CODING_SH_PROP_RUNS"): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  const least = name === "CODING_SH_PROP_RUNS" ? 1 : 0;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < least) throw new UsageError(`${name} must be a whole number${least ? " above 0" : ""}, not ${JSON.stringify(raw)}`);
  return n;
}

/** The run's seed: CODING_SH_PROP_SEED as forAll reads it, or `random()` when it is unset, empty or "random". */
function seedOf(env: NodeJS.ProcessEnv, random: () => number): { seed: number; from: string } {
  const raw = env.CODING_SH_PROP_SEED?.trim();
  if (!raw || raw === "random") return { seed: random(), from: "random" };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= TWO_32) throw new UsageError(`CODING_SH_PROP_SEED must be a whole number below 2^32 or "random", not ${JSON.stringify(raw)}`);
  return { seed: n, from: "CODING_SH_PROP_SEED" };
}

/** A file argument as its name and path: a name or file name in test/verify, or a path from the working directory. */
function locate(arg: string): { name: string; path: string } {
  const path = /[\\/]/.test(arg) ? resolve(arg) : join(VERIFY, arg.endsWith(".test.ts") ? arg : `${arg}.test.ts`);
  if (!path.endsWith(".test.ts") || !existsSync(path)) throw new UsageError(`no test file ${arg}`);
  return { name: basename(path).slice(0, -".test.ts".length), path };
}

/**
 * What each file runs with. A file in test/verify gets the knobs its NIGHTLY row names, with a knob set
 * in the environment in place of the row's value, and the seed when it has runs. A file elsewhere gets
 * the knobs set in the environment as they are, and the seed.
 */
export function plan(args: readonly string[], env: NodeJS.ProcessEnv, random: () => number = () => randomInt(0, TWO_32)): Plan {
  const bound = knob(env, "CODING_SH_MODEL_BOUND");
  const runs = knob(env, "CODING_SH_PROP_RUNS");
  const { seed, from } = seedOf(env, random);
  const given: Record<string, string> = {};
  for (const v of KNOB_VARS) {
    const value = env[v]?.trim();
    if (value) given[v] = value;
  }
  const files = args.map((arg): FilePlan => {
    const { name, path } = locate(arg);
    const inside = relative(VERIFY, dirname(path)) === "";
    const row = inside ? NIGHTLY[name] : undefined;
    const vars: Record<string, string> = {};
    if (row) {
      if (row.bound !== undefined) vars.CODING_SH_MODEL_BOUND = String(bound ?? row.bound);
      if (row.runs !== undefined) Object.assign(vars, { CODING_SH_PROP_RUNS: String(runs ?? row.runs), CODING_SH_PROP_SEED: String(seed) });
    } else {
      if (bound !== undefined) vars.CODING_SH_MODEL_BOUND = String(bound);
      if (runs !== undefined) vars.CODING_SH_PROP_RUNS = String(runs);
      vars.CODING_SH_PROP_SEED = String(seed);
    }
    const rel = relative(PKG, path);
    const file = rel.startsWith("..") || isAbsolute(rel) ? path : rel.split(sep).join("/");
    return { name, file, vars };
  });
  return { seed, seedFrom: from, given, files };
}

/** The environment a file runs in: this one without any knob, then the file's own knobs. */
export function childEnv(env: NodeJS.ProcessEnv, vars: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const v of KNOB_VARS) delete out[v];
  // Set when this script runs under node --test: the file would report to that run instead of to its own output.
  delete out.NODE_TEST_CONTEXT;
  return { ...out, ...vars };
}

/** The command that runs one file again with the same knobs, from packages/coding.sh. */
export function replayCommand(f: FilePlan): string {
  const vars = Object.entries(f.vars).map(([k, v]) => `${k}=${v} `).join("");
  return `${vars}node --no-warnings --test ${/\s/.test(f.file) ? JSON.stringify(f.file) : f.file}`;
}

export interface FileResult extends FilePlan {
  result: "pass" | "fail" | "timed out" | "out of memory";
  ms: number;
}

/** 12.3 s, or 4 min 5 s past a minute. */
export function formatTime(ms: number): string {
  const s = ms / 1000;
  if (s < 59.95) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** Runs one file in a process of its own, its output to this one's and to `<out>/<name>.log`. */
async function runFile(f: FilePlan, out: string, limitMs: number): Promise<FileResult> {
  const log = createWriteStream(join(out, `${f.name}.log`));
  const started = performance.now();
  // The file runs as the main module, so a stop ends every test in it: no runner process in between.
  const child = spawn(process.execPath, ["--no-warnings", "--test-reporter=spec", "--test-force-exit", f.file], { cwd: PKG, env: childEnv(process.env, f.vars), stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const take = (to: NodeJS.WriteStream) => (chunk: Buffer) => {
    to.write(chunk);
    log.write(chunk);
    tail = (tail + chunk.toString("utf8")).slice(-4096);
  };
  child.stdout.on("data", take(process.stdout));
  child.stderr.on("data", take(process.stderr));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, limitMs);
  const code = await new Promise<number | null>((done) => {
    child.on("error", (err) => {
      tail += `\n${err.message}`;
      done(null);
    });
    child.on("close", (status) => done(status));
  });
  clearTimeout(timer);
  const ms = performance.now() - started;
  await new Promise<void>((done) => log.end(done));
  const result = timedOut ? "timed out" : /heap out of memory/.test(tail) ? "out of memory" : code === 0 ? "pass" : "fail";
  return { ...f, result, ms };
}

/** The summary in Markdown: the seed, the knobs, each file's result and time, and how to replay a failure. */
export function summary(p: Plan, results: readonly FileResult[], limitMinutes: number): string {
  const given = Object.entries(p.given).map(([k, v]) => `\`${k}=${v}\``);
  const failed = results.filter((r) => r.result !== "pass");
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  const lines = [
    "## Verify past the default bounds",
    "",
    `Seed ${p.seed}, ${p.seedFrom === "random" ? "picked at random" : "from CODING_SH_PROP_SEED"}. ${given.length ? `Set in the environment: ${given.join(", ")}. ` : ""}Other knobs come from NIGHTLY in packages/coding.sh/scripts/verify-deep.ts. Each file had ${limitMinutes} minutes.`,
    "",
    "| File | Knobs | Result | Time |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.name} | ${Object.entries(r.vars).map(([k, v]) => `\`${k}=${v}\``).join(" ") || "none"} | ${r.result} | ${formatTime(r.ms)} |`),
    "",
    `${results.length - failed.length} passed, ${failed.length} failed, in ${formatTime(total)}.`,
  ];
  if (failed.length) lines.push("", "To run a failed file again with the same knobs, from packages/coding.sh:", "", "```sh", ...failed.map(replayCommand), "```");
  return `${lines.join("\n")}\n`;
}

/** Runs the files named in `args` (every verify file when there are none) and returns the exit code. */
export async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" }, minutes: { type: "string" }, help: { type: "boolean" } } });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (parsed.values.help) {
    console.log("usage: npm run verify:deep -- [--out <dir>] [--minutes <per file>] [file ...]");
    return 0;
  }
  const minutes = Number(parsed.values.minutes ?? 40);
  if (!(minutes > 0)) throw new UsageError(`--minutes must be a number above 0, not ${JSON.stringify(parsed.values.minutes)}`);
  const p = plan(parsed.positionals.length ? parsed.positionals : verifyFiles(), env);
  console.log(`seed ${p.seed} (${p.seedFrom === "random" ? "picked at random" : "from CODING_SH_PROP_SEED"}); CODING_SH_PROP_SEED=${p.seed} runs the property files with it again`);
  const out = parsed.values.out ? resolve(parsed.values.out) : mkdtempSync(join(tmpdir(), "verify-deep-"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "seed.txt"), `${p.seed}\n`);
  console.log(`output in ${out}`);
  const groups = env.GITHUB_ACTIONS === "true";
  const results: FileResult[] = [];
  let md = summary(p, results, minutes);
  for (const f of p.files) {
    const head = `${f.name}${Object.keys(f.vars).length ? ` (${Object.entries(f.vars).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}`;
    console.log(groups ? `::group::${head}` : `== ${head}`);
    const r = await runFile(f, out, minutes * 60_000);
    if (groups) console.log("::endgroup::");
    console.log(`== ${f.name}: ${r.result} in ${formatTime(r.ms)}`);
    results.push(r);
    // Written after each file, so a run stopped from outside still says which files ran.
    md = summary(p, results, minutes);
    writeFileSync(join(out, "summary.md"), md);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  console.log(`\n${md}\noutput in ${out}`);
  return results.every((r) => r.result === "pass") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`verify:deep: ${err.message}`);
    process.exitCode = 2;
  }
}
