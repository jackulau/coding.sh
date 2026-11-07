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
import type { CheckResult, Target, ToolTask, Variant } from "./types.ts";

export interface TaskValidation {
  taskId: string;
  ok: boolean;
  noop: { pass: boolean; checks: CheckResult[]; error?: string };
  reference?: { pass: boolean; checks: CheckResult[]; targetCalls: number; error?: string };
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
    const ref: NonNullable<TaskValidation["reference"]> = { pass: false, checks: [], targetCalls: 0 };
    v.reference = ref;
    let sb: Sandbox | undefined;
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
      for (const line of task.reference) {
        const r = await sh(line, { cwd: sb.work, env: commandEnv(env), timeoutMs: REFERENCE_TIMEOUT_MS });
        if (r.exitCode !== 0) throw new Error(`reference \`${line}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${r.stderrTail.slice(-300)}`);
        last = r.stdoutTail;
      }
      for (const c of closers.splice(0)) await c().catch(() => {});
      ref.targetCalls = (await readTap(sb.tapLog)).filter((t) => t.class !== "meta").length;
      ref.checks = await runChecks(task, sb, last);
      ref.pass = ref.checks.length > 0 && ref.checks.every((c) => c.pass);
      if (!ref.pass) problems.push(`the reference trial fails: ${ref.checks.filter((c) => !c.pass).map((c) => `${c.kind}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`);
    } catch (e) {
      ref.error = e instanceof Error ? e.message : String(e);
      problems.push(`reference trial: ${ref.error}`);
    } finally {
      for (const c of closers) await c().catch(() => {});
      if (sb && !o.keep) await rm(sb.root, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    problems.push("no reference commands: add `reference = [...]` so the task can be shown solvable");
  }
  v.ok = problems.length === 0;
  return v;
}
