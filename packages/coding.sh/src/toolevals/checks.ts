// Task checks (§3): command, state, output, judge and calls. Every check must pass.
// Commands run with the tapped shim off PATH (checkbin/ instead), so checks
// are never counted as agent calls. `${answers.*}` resolves from the hidden
// answers.json written by setup.
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { deepEqual } from "../datasets/hash.ts";
import { queryJsonPath } from "../graders/json-path.ts";
import { sh } from "../runner/exec.ts";
import { safeJoin } from "../runner/fsutil.ts";
import { callsFromTap, checkCalls } from "./calls.ts";
import { checkEnv, expandVars, suiteDirOf, type Sandbox } from "./sandbox.ts";
import type { Check, CheckResult, JudgeFn, StateAssertion, TapRecord, ToolTask } from "./types.ts";

const CHECK_TIMEOUT_MS = 5 * 60_000;

async function loadAnswers(sb: Sandbox): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(sb.hidden, "answers.json"), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function lookup(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** `${answers.a.b}` and sandbox vars. Unresolved answers stay literal (and will not match). */
export function resolveText(s: string, sb: Sandbox, answers: unknown): string {
  return expandVars(s, sb.vars).replace(/\$\{answers\.([\w.]+)\}/g, (m, p: string) => {
    const v = lookup(answers, p);
    return v === undefined ? m : typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** JSONPath with a trailing `.length` (array/string length) on top of the shared subset. */
export function jsonPathValue(value: unknown, path: string): unknown {
  const m = /^(.*)\.length$/.exec(path);
  if (m) {
    const base = m[1] === "$" || m[1] === "" ? [value] : queryJsonPath(value, m[1]!);
    const b = base.length === 1 ? base[0] : base;
    if (Array.isArray(b) || typeof b === "string") return b.length;
  }
  const r = queryJsonPath(value, path);
  return r.length === 1 ? r[0] : r.length === 0 ? undefined : r;
}

/** The first JSON value in a text (whole text, a fenced block, or the first {…}/[…] span). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(t);
  if (fence) tries.push(fence[1]!);
  const s = t.search(/[[{]/);
  if (s >= 0) tries.push(t.slice(s, Math.max(t.lastIndexOf("}"), t.lastIndexOf("]")) + 1));
  for (const x of tries) {
    try {
      return JSON.parse(x) as unknown;
    } catch {
      // next
    }
  }
  return undefined;
}

function normalize(s: string, how: ("trim" | "lower" | "collapse-ws")[] | undefined): string {
  let out = s;
  for (const h of how ?? ["trim"]) {
    if (h === "trim") out = out.trim();
    else if (h === "lower") out = out.toLowerCase();
    else if (h === "collapse-ws") out = out.replace(/\s+/g, " ");
  }
  return out;
}

async function stateAssertion(a: StateAssertion, sb: Sandbox, answers: unknown): Promise<string | undefined> {
  if ("file" in a) {
    const p = safeJoin(sb.work, resolveText(a.file, sb, answers));
    const st = await stat(p).catch(() => undefined);
    if (a.exists === false) return st ? `${a.file} exists` : undefined;
    if (!st) return `${a.file} does not exist`;
    if (a.contains === undefined && a.regex === undefined && a.jsonPath === undefined) return undefined;
    const text = await readFile(p, "utf8");
    if (a.contains !== undefined && !text.includes(resolveText(a.contains, sb, answers))) return `${a.file} does not contain ${JSON.stringify(a.contains)}`;
    if (a.regex !== undefined && !new RegExp(resolveText(a.regex, sb, answers), "m").test(text)) return `${a.file} does not match /${a.regex}/`;
    if (a.jsonPath !== undefined) {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        return `${a.file} is not JSON`;
      }
      const v = jsonPathValue(doc, a.jsonPath);
      if (a.equals !== undefined && !deepEqual(v, a.equals)) return `${a.file} ${a.jsonPath} = ${JSON.stringify(v)}, want ${JSON.stringify(a.equals)}`;
      if (a.equals === undefined && v === undefined) return `${a.file} ${a.jsonPath} matched nothing`;
    }
    return undefined;
  }
  const cmd = resolveText(a.command, sb, answers);
  const r = await sh(cmd, { cwd: sb.work, env: checkEnv(sb), timeoutMs: CHECK_TIMEOUT_MS, tailBytes: 1 << 20 });
  if (r.exitCode !== 0) return `\`${cmd}\` exited ${r.timedOut ? "(timeout)" : r.exitCode}: ${r.stderrTail.slice(-300)}`;
  if (a.stdoutContains !== undefined && !r.stdoutTail.includes(resolveText(a.stdoutContains, sb, answers))) return `\`${cmd}\` stdout lacks ${JSON.stringify(a.stdoutContains)}`;
  if (a.jsonPath !== undefined) {
    let doc: unknown;
    try {
      doc = JSON.parse(r.stdoutTail);
    } catch {
      return `\`${cmd}\` stdout is not JSON`;
    }
    const v = jsonPathValue(doc, a.jsonPath);
    if (a.equals !== undefined && !deepEqual(v, a.equals)) return `\`${cmd}\` ${a.jsonPath} = ${JSON.stringify(v)}, want ${JSON.stringify(a.equals)}`;
  }
  return undefined;
}

async function one(c: Check, task: ToolTask, sb: Sandbox, finalText: string, answers: unknown, judge: JudgeFn | undefined, tap: readonly TapRecord[]): Promise<CheckResult> {
  try {
    if (c.kind === "calls") {
      const r = checkCalls(c, callsFromTap(tap, sb.cliBin));
      return r.pass ? { kind: c.kind, pass: true } : { kind: c.kind, pass: false, detail: r.detail };
    }
    if (c.kind === "command") {
      for (const [rel, src] of Object.entries(c.hiddenFiles ?? {})) {
        const from = isAbsolute(src) ? src : resolve(suiteDirOf(task), src);
        const to = safeJoin(sb.work, rel);
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true });
      }
      const cmd = resolveText(c.run, sb, answers);
      const r = await sh(cmd, { cwd: sb.work, env: checkEnv(sb), timeoutMs: c.timeoutMs ?? CHECK_TIMEOUT_MS });
      return r.exitCode === 0 ? { kind: c.kind, pass: true } : { kind: c.kind, pass: false, detail: `\`${cmd}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${(r.stderrTail || r.stdoutTail).slice(-300)}` };
    }
    if (c.kind === "state") {
      for (const a of c.assert) {
        const why = await stateAssertion(a, sb, answers);
        if (why) return { kind: c.kind, pass: false, detail: why };
      }
      return { kind: c.kind, pass: true };
    }
    if (c.kind === "output") {
      const got = normalize(finalText, c.normalize);
      if (c.equals !== undefined && got !== normalize(resolveText(c.equals, sb, answers), c.normalize)) return { kind: c.kind, pass: false, detail: `output is not ${JSON.stringify(c.equals)}` };
      for (const s of c.contains ?? []) {
        const want = normalize(resolveText(s, sb, answers), c.normalize);
        if (!got.includes(want)) return { kind: c.kind, pass: false, detail: `output lacks ${JSON.stringify(want)}` };
      }
      if (c.regex !== undefined && !new RegExp(resolveText(c.regex, sb, answers), "m").test(got)) return { kind: c.kind, pass: false, detail: `output does not match /${c.regex}/` };
      if (c.jsonPath !== undefined) {
        const doc = extractJson(finalText);
        if (doc === undefined) return { kind: c.kind, pass: false, detail: "output has no JSON" };
        const v = jsonPathValue(doc, c.jsonPath);
        if (c.jsonEquals !== undefined ? !deepEqual(v, c.jsonEquals) : v === undefined) return { kind: c.kind, pass: false, detail: `${c.jsonPath} = ${JSON.stringify(v)}` };
      }
      return { kind: c.kind, pass: true };
    }
    if (!judge) return { kind: c.kind, pass: false, detail: "no judge configured for judge checks" };
    const r = await judge({ judge: c.judge, rubric: resolveText(c.rubric, sb, answers), output: finalText });
    const flag = r.calibrated ? "" : "uncalibrated";
    return { kind: c.kind, pass: r.pass, detail: [flag, r.detail].filter(Boolean).join(": ") || undefined };
  } catch (e) {
    return { kind: c.kind, pass: false, detail: `check error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** `tap`: the trial's target calls, which `calls` checks read (none for a no-op trial). */
export async function runChecks(task: ToolTask, sb: Sandbox, finalText: string, judge?: JudgeFn, tap: readonly TapRecord[] = []): Promise<CheckResult[]> {
  const answers = await loadAnswers(sb);
  const out: CheckResult[] = [];
  for (const c of task.checks) out.push(await one(c, task, sb, finalText, answers, judge, tap));
  return out;
}
