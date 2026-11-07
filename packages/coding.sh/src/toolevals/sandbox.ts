// Trial layout (§5.1):
//   <root>/<trialId>/
//     work/        agent cwd (setup files, fixtures)
//     home/        HOME/config dir for the agent when its overlay supports isolation
//     bin/<bin>    CLI shim (tapped); first on the agent's PATH
//     checkbin/    the same name without the tap, for setup and checks
//     tap.jsonl    one TapRecord per target call
//     hidden/      answers.json and hidden check files (never under work/)
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { commandEnv, sh } from "../runner/exec.ts";
import { safeJoin } from "../runner/fsutil.ts";
import { writeCliShim } from "./tap/cli.ts";
import type { Target, ToolTask, Variant } from "./types.ts";

export interface Sandbox {
  root: string;
  work: string;
  home: string;
  bin: string;
  hidden: string;
  tapLog: string;
  /** Env for the agent / model driver: PATH with bin/ first, CODING_SH_RUN_ID, task setup env. */
  env: Record<string, string>;
  /** Untapped binary dir for setup commands and checks. */
  checkBin: string;
  /** Variables for `${…}` expansion: sandbox, work, home, hidden, fixtures, bin. */
  vars: Record<string, string>;
  /** Env for the tool process itself (target env + variant env, expanded). */
  toolEnv: Record<string, string>;
}

const SETUP_TIMEOUT_MS = 15 * 60_000;

/** Expands `${name}` from vars; unknown names (e.g. `${answers.x}`) are left as is. */
export function expandVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

export function expandRecord(r: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r ?? {})) out[k] = expandVars(v, vars);
  return out;
}

export function suiteDirOf(task: ToolTask): string {
  if (task.suiteDir) return task.suiteDir;
  const src = task.source.replace(/:\d+$/, "");
  const d = dirname(src);
  return /[\\/]tasks$/.test(d) ? dirname(d) : d;
}

/** Env for setup commands and checks: inherited env + sandbox env, with the untapped bin first. */
export function checkEnv(sb: Sandbox): Record<string, string | undefined> {
  const base = commandEnv(sb.env);
  const path = (process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== sb.bin);
  base.PATH = [sb.checkBin, ...path].join(delimiter);
  return base;
}

/** A trial's sandbox dir under the experiment dir. */
export function sandboxDir(root: string, trialId: string): string {
  return resolve(root, trialId);
}

export async function prepareSandbox(task: ToolTask, target: Target, variant: Variant, trialId: string, root: string): Promise<Sandbox> {
  const dir = sandboxDir(root, trialId);
  const suite = suiteDirOf(task);
  const sb: Sandbox = {
    root: dir,
    work: join(dir, "work"),
    home: join(dir, "home"),
    bin: join(dir, "bin"),
    hidden: join(dir, "hidden"),
    tapLog: join(dir, "tap.jsonl"),
    checkBin: join(dir, "checkbin"),
    env: {},
    vars: {},
    toolEnv: {},
  };
  // Vars land in sh command lines, where a backslash is an escape: Windows paths use forward slashes.
  const v = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
  sb.vars = { sandbox: v(dir), work: v(sb.work), home: v(sb.home), hidden: v(sb.hidden), bin: v(sb.bin), fixtures: v(join(suite, "fixtures")), suite: v(suite) };
  for (const d of [sb.work, sb.home, sb.bin, sb.hidden, sb.checkBin]) await mkdir(d, { recursive: true });
  await writeFile(sb.tapLog, "");

  for (const [rel, src] of Object.entries(task.setup.files)) {
    const from = isAbsolute(src) ? src : resolve(suite, expandVars(src, sb.vars));
    const to = safeJoin(sb.work, rel);
    await mkdir(dirname(to), { recursive: true });
    const st = await stat(from).catch(() => undefined);
    if (!st) throw new Error(`${task.source}: setup file ${JSON.stringify(src)} not found (looked in ${from})`);
    await cp(from, to, { recursive: st.isDirectory() });
  }

  sb.toolEnv = { ...expandRecord(target.env, sb.vars), ...expandRecord(variant.env, sb.vars) };
  const setupEnv = expandRecord(task.setup.env, sb.vars);
  sb.env = { ...setupEnv, PATH: `${sb.bin}${delimiter}${process.env.PATH ?? ""}`, CODING_SH_RUN_ID: trialId };

  if (target.kind === "cli") {
    const command = (variant.command ?? target.command).map((a) => expandVars(a, sb.vars));
    const shim = { command, env: sb.toolEnv, usageExitCodes: target.usageExitCodes, usagePatterns: target.usagePatterns };
    await writeCliShim(sb.bin, target.bin, { ...shim, tapLog: sb.tapLog });
    await writeCliShim(sb.checkBin, target.bin, shim);
  }

  for (const cmd of task.setup.commands) {
    const line = expandVars(cmd, sb.vars);
    const r = await sh(line, { cwd: sb.work, env: checkEnv(sb), timeoutMs: SETUP_TIMEOUT_MS });
    if (r.exitCode !== 0) throw new Error(`setup \`${line}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${r.stderrTail.slice(-500)}`);
  }
  return sb;
}
