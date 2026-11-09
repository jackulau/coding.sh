// Task validation (§3), mirroring validateTask for eval tasks:
//   1. the no-op trial fails (checks against the sandbox after setup only);
//   2. the reference trial passes (`reference` shell commands run through the shim);
//   3. the instruction does not contain the expected output (ngramOverlap).
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sortableId } from "../core/ids.ts";
import { ngramOverlap } from "../eval/leakage.ts";
import { commandEnv, sh } from "../runner/exec.ts";
import { resolveText, runChecks } from "./checks.ts";
import { readTap } from "./experiment.ts";
import { openapiPaths, startHttpTap } from "./tap/http-proxy.ts";
import { startMcpProxy } from "./tap/mcp-proxy.ts";
import { prepareSandbox, suiteDirOf, type Sandbox } from "./sandbox.ts";
import type { AgainstRow } from "../datasets/kinds.ts";
import type { CaseKind } from "../datasets/types.ts";
import type { CheckResult, Target, ToolTask, TrialResult, Variant } from "./types.ts";

export interface TaskValidation {
  taskId: string;
  ok: boolean;
  noop: { pass: boolean; checks: CheckResult[]; error?: string };
  /** `errorAt`: "setup" when the sandbox or tap could not start, "reference" when a reference command failed. */
  reference?: { pass: boolean; checks: CheckResult[]; targetCalls: number; error?: string; errorAt?: "setup" | "reference" };
  leakage: { leaked: boolean; detail?: string };
  problems: string[];
}

const REFERENCE_TIMEOUT_MS = 5 * 60_000;

async function answersOf(sb: Sandbox): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(sb.hidden, "answers.json"), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Expected output strings of a task's output checks, with answers resolved. */
export function expectedOutputs(task: ToolTask, sb: Sandbox | undefined, answers: unknown): string[] {
  const out: string[] = [];
  const r = (s: string) => (sb ? resolveText(s, sb, answers) : s);
  for (const c of task.checks) {
    if (c.kind !== "output") continue;
    if (c.equals !== undefined) out.push(r(c.equals));
    for (const x of c.contains ?? []) out.push(r(x));
    if (c.jsonEquals !== undefined) out.push(JSON.stringify(c.jsonEquals));
  }
  return out.filter((s) => s.trim() && !/\$\{answers\./.test(s));
}

/** Leak when a non-trivial expected string appears verbatim, or long ones share 8-token runs. */
export function leakage(instruction: string, expected: readonly string[]): { leaked: boolean; detail?: string } {
  const inst = instruction.toLowerCase();
  for (const e of expected) {
    const t = e.trim();
    if (t.length >= 4 && inst.includes(t.toLowerCase())) return { leaked: true, detail: `instruction contains the expected output ${JSON.stringify(t.slice(0, 60))}` };
    const o = ngramOverlap(t, instruction, 8);
    if (o.total > 0 && o.fraction >= 0.5) return { leaked: true, detail: `instruction shares ${(o.fraction * 100).toFixed(0)}% of 8-token runs with an expected output` };
  }
  return { leaked: false };
}

export async function validateToolTask(task: ToolTask, target: Target, o: { root: string; variant?: Variant; keep?: boolean; env?: NodeJS.ProcessEnv }): Promise<TaskValidation> {
  const variant = o.variant ?? { name: "base" };
  const problems: string[] = [];
  const v: TaskValidation = { taskId: task.id, ok: false, noop: { pass: false, checks: [] }, leakage: { leaked: false }, problems };
  if (!task.checks.length) problems.push("task has no checks");

  // 1. no-op
  let answers: unknown;
  let noopSb: Sandbox | undefined;
  try {
    noopSb = await prepareSandbox(task, target, variant, sortableId("tval_"), o.root);
    answers = await answersOf(noopSb);
    v.noop.checks = await runChecks(task, noopSb, "");
    v.noop.pass = v.noop.checks.length > 0 && v.noop.checks.every((c) => c.pass);
    if (v.noop.pass) problems.push("the no-op trial passes: checks do not depend on the agent's work");
  } catch (e) {
    v.noop.error = e instanceof Error ? e.message : String(e);
    problems.push(`no-op trial: ${v.noop.error}`);
  }

  // 3. leakage (uses answers resolved from setup)
  v.leakage = leakage(task.instruction, expectedOutputs(task, noopSb, answers));
  if (v.leakage.leaked) problems.push(v.leakage.detail!);
  if (noopSb && !o.keep) await rm(noopSb.root, { recursive: true, force: true }).catch(() => {});

  // 2. reference
  if (task.reference?.length) {
    const ref = await runReference(task, target, { root: o.root, variant, ...(o.keep ? { keep: true } : {}), ...(o.env ? { env: o.env } : {}) });
    v.reference = ref;
    if (ref.error !== undefined) problems.push(`reference trial: ${ref.error}`);
    else if (!ref.pass) problems.push(`the reference trial fails: ${ref.checks.filter((c) => !c.pass).map((c) => `${c.kind}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`);
  } else {
    problems.push("no reference commands: add `reference = [...]` so the task can be shown solvable");
  }
  v.ok = problems.length === 0;
  return v;
}

/** Run a task's `reference` commands through the tap on one variant and grade the result. */
export async function runReference(task: ToolTask, target: Target, o: { root: string; variant: Variant; keep?: boolean; env?: NodeJS.ProcessEnv }): Promise<NonNullable<TaskValidation["reference"]>> {
  const ref: NonNullable<TaskValidation["reference"]> = { pass: false, checks: [], targetCalls: 0 };
  if (!task.reference?.length) {
    ref.error = "no reference commands";
    return ref;
  }
  const variant = o.variant;
  let sb: Sandbox | undefined;
  let stage: "setup" | "reference" = "setup";
  const closers: (() => Promise<void>)[] = [];
  try {
    sb = await prepareSandbox(task, target, variant, sortableId("tref_"), o.root);
    const env: Record<string, string> = { ...sb.env, HOME: sb.home };
    if (target.kind === "mcp") {
      const p = await startMcpProxy({ target, variant, tapLog: sb.tapLog, binDir: sb.bin, env: sb.toolEnv, cwd: sb.work });
      closers.push(() => p.close());
      if (p.stdio) env.MCP_SERVER_COMMAND = p.stdio.map((a) => JSON.stringify(a)).join(" ");
      if (p.url) env.MCP_SERVER_URL = p.url;
    } else if (target.kind === "http") {
      let templates: string[] = [];
      if (target.openapi) templates = openapiPaths(JSON.parse(await readFile(join(suiteDirOf(task), target.openapi), "utf8")) as unknown);
      const h = await startHttpTap({ target, variant, tapLog: sb.tapLog, templates, env: { ...(o.env ?? process.env), ...sb.toolEnv } });
      closers.push(() => h.close());
      env[target.urlEnv ?? `${target.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`] = h.url;
    }
    let last = "";
    stage = "reference";
    for (const line of task.reference) {
      const r = await sh(line, { cwd: sb.work, env: commandEnv(env), timeoutMs: REFERENCE_TIMEOUT_MS });
      if (r.exitCode !== 0) throw new Error(`reference \`${line}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${r.stderrTail.slice(-300)}`);
      last = r.stdoutTail;
    }
    for (const c of closers.splice(0)) await c().catch(() => {});
    const tap = await readTap(sb.tapLog);
    ref.targetCalls = tap.filter((t) => t.class !== "meta").length;
    ref.checks = await runChecks(task, sb, last, undefined, tap);
    ref.pass = ref.checks.length > 0 && ref.checks.every((c) => c.pass);
  } catch (e) {
    ref.error = e instanceof Error ? e.message : String(e);
    ref.errorAt = stage;
  } finally {
    for (const c of closers) await c().catch(() => {});
    if (sb && !o.keep) await rm(sb.root, { recursive: true, force: true }).catch(() => {});
  }
  return ref;
}

// ------------------------------------------------------------ --against (TB-12)

/** Variant fields only an agent reads (text, harness, model settings): reference commands never see them, so only agent trials can show a failure they cause. */
export function agentFacingFields(v: Variant): string[] {
  const keys = ["descriptions", "paramDescriptions", "hideTools", "bundle", "outputCap", "promptCache"] as const;
  return keys.filter((k) => v[k] !== undefined);
}

/**
 * Reference trial of a kinded task on the variant it was written against. A
 * reference that errors out (a command exits non-zero) counts as a failing
 * trial here: on an old build that is how the failure shows. Only a sandbox
 * that cannot be set up is an error.
 */
export async function referenceAgainst(task: ToolTask & { kind: CaseKind }, target: Target, o: { root: string; variant: Variant; env?: NodeJS.ProcessEnv }): Promise<AgainstRow> {
  if (!task.reference?.length) return { caseId: task.id, kind: task.kind, passes: 0, trials: 0, error: "no reference commands to run" };
  const ref = await runReference(task, target, o);
  if (ref.errorAt === "setup") return { caseId: task.id, kind: task.kind, passes: 0, trials: 0, error: ref.error ?? "setup failed" };
  return { caseId: task.id, kind: task.kind, passes: ref.pass ? 1 : 0, trials: 1 };
}

/** Per-task rows from agent trials on the against variant; trials that errored are left out (neither pass nor fail). */
export function againstRows(tasks: readonly (ToolTask & { kind: CaseKind })[], trials: readonly TrialResult[]): AgainstRow[] {
  return tasks.map((t) => {
    const mine = trials.filter((x) => x.taskId === t.id);
    const counted = mine.filter((x) => !x.error);
    const row: AgainstRow = { caseId: t.id, kind: t.kind, passes: counted.filter((x) => x.pass).length, trials: counted.length };
    if (!counted.length) row.error = mine.find((x) => x.error)?.error ?? "no trial ran";
    return row;
  });
}
