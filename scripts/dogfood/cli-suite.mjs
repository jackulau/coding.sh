#!/usr/bin/env node
// CLI effectiveness suite runner (docs/DOGFOOD.md §3.1, docs/TOOL-EVALS.md).
//
//   node scripts/dogfood/cli-suite.mjs validate [--split dev|heldout|all] [--task id]... [--concurrency n] [--json]
//   node scripts/dogfood/cli-suite.mjs run --driver agent:claude-code:sonnet [--driver agent:codex] [--k 3]
//        [--split dev|heldout|all] [--task id]... [--concurrency n] [--yes] [--json]
//
// validate ($0, no agent): for every task, builds a fresh world and checks that
//   1. the no-op trial fails (checks run right after setup),
//   2. the scripted reference passes (run through the tap shim, like an agent),
//   3. the instruction does not contain the expected answers.
// run (costs money): one trial per (task, driver, k). Metrics come from the
//   tap records, never from the agent's own report. Trial records go to
//   ~/.coding.sh/dogfood/cli-runs/<runId>/ (outside the repo: held-out data).
//
// Exit codes: 0 ok, 1 some tasks invalid or trials errored, 2 usage.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseToml } from "./lib/toml.mjs";
import { CLI, EVALS_CLI, REPO, log, parseArgs, readJsonl, round, shAsync, tempDir, treeHash, wilson } from "./lib/util.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURES = join(EVALS_CLI, "fixtures");
const TAP = join(HERE, "tap.mjs");

// ---------------------------------------------------------------- loading

export function expandHome(p) {
  return p.startsWith("~/") ? join(process.env.HOME || homedir(), p.slice(2)) : p;
}

export function loadSuite(dir = EVALS_CLI) {
  const suite = parseToml(readFileSync(join(dir, "suite.toml"), "utf8"));
  const load = (d, split) => {
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".toml"))
      .sort()
      .map((f) => {
        const path = join(d, f);
        let t;
        try {
          t = parseToml(readFileSync(path, "utf8"));
        } catch (e) {
          return { id: f.replace(/\.toml$/, ""), split, path, loadError: e.message, check: [] };
        }
        return { ...t, split: t.split ?? split, path, check: t.check ?? [], reference: t.reference ?? [] };
      });
  };
  const heldoutDir = expandHome(suite.heldoutDir ?? "~/.coding.sh/dogfood/heldout");
  const tasks = [...load(join(dir, "tasks"), "dev"), ...load(heldoutDir, "heldout")];
  return { suite, tasks, heldoutDir };
}

// ---------------------------------------------------------------- templating

function getPath(obj, path) {
  let v = obj;
  for (const k of path.split(".")) {
    if (v === undefined || v === null) return undefined;
    if (k === "length" && (Array.isArray(v) || typeof v === "string")) v = v.length;
    else v = v[k];
  }
  return v;
}

/** Replaces ${name} / ${answers.a.b}. A string that is exactly one placeholder keeps the value's type. */
export function template(value, vars) {
  if (Array.isArray(value)) return value.map((v) => template(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, vars)]));
  if (typeof value !== "string") return value;
  const one = /^\$\{([A-Za-z0-9_.-]+)\}$/.exec(value);
  if (one) {
    const v = getPath(vars, one[1]);
    if (v === undefined) throw new Error(`unresolved placeholder \${${one[1]}}`);
    return v;
  }
  return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (m, k) => {
    const v = getPath(vars, k);
    if (v === undefined) throw new Error(`unresolved placeholder ${m}`);
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// ---------------------------------------------------------------- json path

/** $.a.b, $.a[0], $.a[*].b — enough for state checks. */
export function jsonPath(doc, path) {
  if (!path || path === "$") return doc;
  const toks = [];
  for (const m of path.replace(/^\$\.?/, "").matchAll(/([^.[\]]+)|\[(\*|\d+)\]/g)) toks.push(m[1] ?? m[2]);
  const walk = (v, i) => {
    if (i === toks.length) return v;
    const t = toks[i];
    if (t === "*") return Array.isArray(v) ? v.flatMap((x) => [walk(x, i + 1)]).flat() : undefined;
    if (v === undefined || v === null) return undefined;
    return walk(Array.isArray(v) && /^\d+$/.test(t) ? v[Number(t)] : v[t], i + 1);
  };
  return walk(doc, 0);
}

// ---------------------------------------------------------------- checks

const NUM = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/g;
export function numbersIn(text) {
  return [...String(text).matchAll(NUM)].map((m) => Number(m[0].replaceAll(",", ""))).filter(Number.isFinite);
}

/** First JSON object or array embedded in text (code fences and prose allowed). */
export function firstJson(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const d = text[j];
      if (inStr) {
        if (d === "\\") j++;
        else if (d === '"') inStr = false;
        continue;
      }
      if (d === '"') inStr = true;
      else if (d === "{" || d === "[") depth++;
      else if (d === "}" || d === "]") {
        depth--;
        if (depth === 0) {
          try {
            return { ok: true, value: JSON.parse(text.slice(i, j + 1)) };
          } catch {
            break;
          }
        }
      }
    }
  }
  return { ok: false };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const has = (text, v) => text.toLowerCase().includes(String(v).toLowerCase());

/** Output checks against the final assistant text. Returns { pass, why }. */
export function checkOutput(c, text) {
  const t = String(text ?? "");
  const fails = [];
  for (const v of list(c.contains)) if (!has(t, v)) fails.push(`missing ${JSON.stringify(v)}`);
  for (const v of list(c.set)) if (!has(t, v)) fails.push(`missing set member ${JSON.stringify(v)}`);
  for (const v of list(c.absent)) if (has(t, v)) fails.push(`contains forbidden ${JSON.stringify(v)}`);
  if (c.regex !== undefined && !new RegExp(c.regex, "im").test(t)) fails.push(`no match for /${c.regex}/`);
  if (c.equals !== undefined && t.trim().toLowerCase() !== String(c.equals).trim().toLowerCase()) fails.push("not equal");
  const nums = numbersIn(t);
  if (c.number !== undefined) {
    const want = Number(c.number);
    const tol = Number(c.tolerance ?? 0);
    if (!nums.some((n) => Math.abs(n - want) <= tol + 1e-9)) fails.push(`no number within ${tol} of ${want}`);
  }
  if (c.anyNumber !== undefined) {
    const wants = list(c.anyNumber).map(Number);
    const tol = Number(c.tolerance ?? 1e-6);
    if (!nums.some((n) => wants.some((w) => Math.abs(n - w) <= tol))) fails.push(`no number equal to any of ${wants.join(", ")}`);
  }
  if (c.json !== undefined) {
    const j = firstJson(t);
    if (!j.ok) fails.push("no JSON value in output");
    else if (!deepEqual(j.value, c.json)) fails.push(`JSON ${JSON.stringify(j.value)} != ${JSON.stringify(c.json)}`);
  }
  return { pass: fails.length === 0, why: fails.join("; ") };
}

function configHash(trial) {
  return treeHash(join(trial.home, ".claude")) + treeHash(join(trial.home, ".codex"));
}

/** State checks run the CLI directly (no shim), so they never count as agent calls. */
export async function checkState(c, trial) {
  const fails = [];
  for (const p of list(c.exists)) if (!existsSync(resolve(trial.work, p))) fails.push(`missing ${p}`);
  if (c.unchanged === "agent-configs" && configHash(trial) !== trial.configHash) fails.push("agent config files changed");
  if (c.command) {
    const cmd = c.command.replace(/^coding\.sh\b/, `${JSON.stringify(process.execPath)} ${JSON.stringify(trial.cli)}`);
    const r = await shAsync("bash", ["-c", cmd], { cwd: trial.work, env: trial.targetEnv, timeoutMs: 120_000 });
    if (r.code !== 0) fails.push(`${c.command} exited ${r.code}: ${r.stderr.slice(0, 300)}`);
    else {
      let v = r.stdout;
      if (c.jsonPath !== undefined) {
        try {
          v = jsonPath(JSON.parse(r.stdout), c.jsonPath);
        } catch (e) {
          fails.push(`${c.command}: not JSON (${e.message})`);
          v = undefined;
        }
      }
      if (c.where && Array.isArray(v)) v = v.find((x) => Object.entries(c.where).every(([k, w]) => deepEqual(getPath(x, k), w)));
      if (c.pick && v !== undefined) v = getPath(v, c.pick);
      if (c.equals !== undefined && !deepEqual(v, c.equals)) fails.push(`${c.command} ${c.jsonPath ?? ""}${c.pick ? "." + c.pick : ""} = ${JSON.stringify(v)}, want ${JSON.stringify(c.equals)}`);
      if (c.includes !== undefined && !(Array.isArray(v) && v.some((x) => deepEqual(x, c.includes)))) fails.push(`${JSON.stringify(v)?.slice(0, 200)} does not include ${JSON.stringify(c.includes)}`);
      if (c.length !== undefined && !(Array.isArray(v) && v.length === c.length)) fails.push(`length ${Array.isArray(v) ? v.length : "n/a"}, want ${c.length}`);
      if (c.contains !== undefined && !has(typeof v === "string" ? v : JSON.stringify(v ?? ""), c.contains)) fails.push(`output lacks ${JSON.stringify(c.contains)}`);
    }
  }
  return { pass: fails.length === 0, why: fails.join("; ") };
}

export async function runChecks(checks, trial, text) {
  const out = [];
  for (const c of checks) out.push({ kind: c.kind, ...(c.kind === "state" ? await checkState(c, trial) : checkOutput(c, text)) });
  return out;
}

/** Expected values that appear verbatim in the instruction (answer leakage). */
export function leakage(instruction, checks) {
  const found = [];
  const ins = instruction.toLowerCase();
  for (const c of checks) {
    if (c.leakOk || c.kind !== "output") continue;
    for (const v of [...list(c.contains), ...list(c.set), ...(c.number !== undefined ? [c.number] : [])]) {
      const s = String(v).toLowerCase();
      if (s.length >= 3 && ins.includes(s)) found.push(`instruction contains expected value ${JSON.stringify(v)}`);
    }
  }
  return found;
}

// ---------------------------------------------------------------- trials

/**
 * Builds a fresh world for one trial: setup commands, answers, and the tap
 * shim at <trial>/bin/coding.sh (first on the agent's PATH). The target's own
 * env (fake HOME, CODING_SH_HOME…) is applied only inside the shim, so the
 * agent itself keeps its real HOME and credentials.
 */
export async function prepareTrial(suite, task, opts) {
  const root = tempDir(`csh-cli-${task.id}-`);
  const trialDir = join(root, "t");
  const answersFile = join(root, "hidden", "answers.json");
  const base = { fixtures: FIXTURES, trial: trialDir, cli: opts.cli, seed: opts.seed ?? 1, answersFile, repo: REPO };
  for (const cmd of template(suite.setup?.commands ?? [], base)) {
    const r = await shAsync("bash", ["-c", cmd], { cwd: root, timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`setup failed (${r.code}): ${cmd}\n${r.stderr.slice(-2000)}`);
  }
  const answers = JSON.parse(readFileSync(answersFile, "utf8"));
  const vars = { ...base, answers };
  const resolved = { ...task, instruction: template(task.instruction ?? "", vars).trim(), check: template(task.check, vars), reference: template(task.reference ?? [], vars) };
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const tapLog = join(root, "tap.jsonl");
  const targetEnv = { ...answers.env };
  const shim = `#!/bin/sh\nCODINGSH_TAP_LOG=${sq(tapLog)} CODINGSH_TAP_CMD=${sq(JSON.stringify([process.execPath, opts.cli]))} CODINGSH_TAP_ENV=${sq(JSON.stringify(targetEnv))} exec ${sq(process.execPath)} ${sq(TAP)} "$@"\n`;
  for (const name of [suite.target?.bin ?? "coding.sh", "codingsh"]) {
    writeFileSync(join(bin, name), shim);
    chmodSync(join(bin, name), 0o755);
  }
  const trial = {
    root,
    work: answers.paths.work,
    home: answers.paths.home,
    bin,
    tapLog,
    cli: opts.cli,
    answers,
    task: resolved,
    targetEnv: { ...process.env, ...targetEnv, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
  };
  trial.configHash = configHash(trial);
  return trial;
}

function sq(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

/** PATH for anything acting as the agent: the shim dir first. */
function agentPath(trial) {
  return `${trial.bin}:${process.env.PATH}`;
}

// ---------------------------------------------------------------- tap metrics

const HELP_ARGS = new Set(["--help", "-h", "help"]);
export function classify(rec, patterns = []) {
  const a = rec.argv ?? [];
  if (!a.length || a.some((x) => HELP_ARGS.has(x)) || a[0] === "help") return { cls: "help" };
  if (a[0] === "version" || a.includes("--version") || a.includes("-v")) return { cls: "meta" };
  const err = rec.stderrHead ?? "";
  if (rec.exit === 2 || patterns.some((p) => new RegExp(p, "im").test(err))) {
    const reason = /unknown (option|flag)|--\S+.*did you mean/i.test(err) ? "unknown-flag" : /unknown command|did you mean/i.test(err) ? "unknown-command" : /missing/i.test(err) ? "missing-arg" : "usage";
    return { cls: "invalid", reason };
  }
  if (rec.exit !== 0) return { cls: "failed", reason: /not.?found|can't find/i.test(err) ? "not-found" : "error" };
  return { cls: "ok" };
}

/** Identity for retries: the leading non-flag tokens (subcommand path), max 2. */
function identity(argv) {
  const out = [];
  for (const t of argv) {
    if (t.startsWith("-") || out.length >= 2) break;
    out.push(t);
  }
  return out.join(" ");
}

export function tapMetrics(records, patterns = []) {
  const rows = records.map((r) => ({ ...r, ...classify(r, patterns) }));
  const target = rows.filter((r) => r.cls !== "meta");
  const bad = new Map();
  let retries = 0;
  let selfCorrections = 0;
  for (const r of target) {
    if (r.cls === "help") continue;
    const id = identity(r.argv);
    if (bad.has(id)) {
      retries++;
      if (r.cls === "ok") {
        selfCorrections++;
        bad.set(id, true);
      }
    } else if (r.cls === "invalid" || r.cls === "failed") bad.set(id, false);
  }
  const work = target.filter((r) => r.cls !== "help");
  const firstOk = work.findIndex((r) => r.cls === "ok");
  const invalidKinds = {};
  for (const r of target) if (r.cls === "invalid") invalidKinds[r.reason] = (invalidKinds[r.reason] ?? 0) + 1;
  return {
    targetCalls: target.length,
    invalidCalls: target.filter((r) => r.cls === "invalid").length,
    failedCalls: target.filter((r) => r.cls === "failed").length,
    helpLookups: target.filter((r) => r.cls === "help").length,
    helpBytesRead: target.filter((r) => r.cls === "help").reduce((n, r) => n + (r.stdoutBytes ?? 0), 0),
    invalidKinds,
    retries,
    selfCorrections,
    recoveryRate: bad.size ? [...bad.values()].filter(Boolean).length / bad.size : undefined,
    firstCallCorrect: work.length ? work[0].cls === "ok" : false,
    callsToFirstCorrect: firstOk >= 0 ? firstOk + 1 : undefined,
    targetLatencyP50Ms: pct(target.map((r) => r.durationMs), 50),
  };
}

function pct(xs, p) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

// ---------------------------------------------------------------- validate

async function validateTask(suite, task, opts) {
  const res = { id: task.id, split: task.split, status: task.status ?? "active", ok: false, noopFails: null, referencePasses: null, leakage: [], errors: [] };
  if (task.loadError) {
    res.errors.push(task.loadError);
    return res;
  }
  if (task.status === "blocked") {
    res.blockedBy = task.blockedBy ?? "blocked";
    return res;
  }
  if (!task.reference?.length) {
    res.errors.push("no reference solution");
    return res;
  }
  try {
    // 1. No-op: checks right after setup.
    const noop = await prepareTrial(suite, task, opts);
    try {
      const checks = await runChecks(noop.task.check, noop, "");
      res.noopFails = checks.some((c) => !c.pass);
      res.leakage = leakage(noop.task.instruction, noop.task.check);
    } finally {
      if (!opts.keep) rmSync(noop.root, { recursive: true, force: true });
    }
    // 2. Reference through the shim.
    const ref = await prepareTrial(suite, task, opts);
    try {
      const script = ["set -euo pipefail", ...ref.task.reference].join("\n");
      const r = await shAsync("bash", ["-c", script], { cwd: ref.work, env: { ...process.env, PATH: agentPath(ref) }, timeoutMs: 300_000 });
      if (r.code !== 0) res.errors.push(`reference exited ${r.code}: ${r.stderr.slice(-800)}`);
      const checks = await runChecks(ref.task.check, ref, r.stdout);
      res.referencePasses = r.code === 0 && checks.every((c) => c.pass);
      if (!res.referencePasses) res.referenceFailures = checks.filter((c) => !c.pass).map((c) => c.why);
      res.referenceTap = tapMetrics(readJsonl(ref.tapLog), suite.target?.usagePatterns);
    } finally {
      if (!opts.keep) rmSync(ref.root, { recursive: true, force: true });
    }
  } catch (e) {
    res.errors.push(e.message);
  }
  res.ok = res.noopFails === true && res.referencePasses === true && res.leakage.length === 0 && res.errors.length === 0;
  return res;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export async function validate(opts = {}) {
  const { suite, tasks, heldoutDir } = loadSuite();
  const picked = pickTasks(tasks, opts);
  const results = await pool(picked, opts.concurrency ?? 6, (t) => validateTask(suite, t, { cli: opts.cli ?? CLI, seed: opts.seed, keep: opts.keep }));
  const active = results.filter((r) => r.status !== "blocked");
  return {
    tasks: results,
    heldoutDir,
    counts: {
      dev: tasks.filter((t) => t.split === "dev").length,
      heldout: tasks.filter((t) => t.split === "heldout").length,
      validated: active.filter((r) => r.ok).length,
      invalid: active.filter((r) => !r.ok).length,
      blocked: results.length - active.length,
    },
    valid: active.length ? active.filter((r) => r.ok).length / active.length : null,
  };
}

function pickTasks(tasks, opts) {
  const ids = list(opts.task);
  const split = opts.split ?? "all";
  return tasks.filter((t) => (ids.length ? ids.includes(t.id) : split === "all" || t.split === split));
}

// ---------------------------------------------------------------- agent drivers

export function driverKeyMissing(driver) {
  if (driver.startsWith("agent:claude-code")) return process.env.ANTHROPIC_API_KEY ? undefined : "ANTHROPIC_API_KEY";
  if (driver.startsWith("agent:codex")) return process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY ? undefined : "OPENAI_API_KEY";
  return `unknown driver ${driver}`;
}

async function runAgent(driver, trial, budget) {
  const [, agent, model] = driver.split(":");
  const env = { ...process.env, PATH: agentPath(trial), CODING_SH_DOGFOOD_ROLE: "cli-eval" };
  delete env.CLAUDECODE;
  const timeoutMs = budget.wallMs ?? 300_000;
  if (agent === "claude-code") {
    const args = ["-p", "--bare", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--no-session-persistence", "--settings", join(HERE, "claude-otel.json")];
    if (model) args.push("--model", model);
    if (budget.costUsd) args.push("--max-budget-usd", String(budget.costUsd));
    args.push(trial.task.instruction);
    const r = await shAsync("claude", args, { cwd: trial.work, env, timeoutMs });
    let result;
    for (const l of r.stdout.split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "result") result = o;
      } catch {}
    }
    return { exit: r.code, timedOut: r.timedOut, wallMs: r.ms, text: result?.result ?? "", costUsd: result?.total_cost_usd, turns: result?.num_turns, sessionId: result?.session_id, error: result ? undefined : r.stderr.slice(-500) };
  }
  if (agent === "codex") {
    const last = join(trial.root, "last.txt");
    const args = ["exec", "--json", "-s", "workspace-write", "-C", trial.work, "--add-dir", trial.root, "--skip-git-repo-check", "--ephemeral", "-o", last];
    if (model) args.push("-m", model);
    args.push(trial.task.instruction);
    const r = await shAsync("codex", args, { cwd: trial.work, env, timeoutMs });
    let turns = 0;
    let tokens = 0;
    for (const l of r.stdout.split("\n")) {
      try {
        const o = JSON.parse(l);
        if (o.type === "turn.completed") tokens += (o.usage?.input_tokens ?? 0) + (o.usage?.output_tokens ?? 0);
        if (o.type === "item.completed" && o.item?.type === "agent_message") turns++;
      } catch {}
    }
    const text = existsSync(last) ? readFileSync(last, "utf8") : "";
    return { exit: r.code, timedOut: r.timedOut, wallMs: r.ms, text, costUsd: undefined, turns, tokens, error: r.code ? r.stderr.slice(-500) : undefined };
  }
  throw new Error(`unknown driver ${driver}`);
}

export async function runSuite(opts) {
  const { suite, tasks } = loadSuite();
  const drivers = list(opts.driver).length ? list(opts.driver) : list(suite.drivers?.list);
  const k = Number(opts.k ?? suite.drivers?.k ?? 3);
  const picked = pickTasks(tasks, opts).filter((t) => t.status !== "blocked" && !t.loadError);
  const skipped = [];
  const usable = drivers.filter((d) => {
    const miss = driverKeyMissing(d);
    if (miss && !opts.yes) skipped.push({ driver: d, reason: `${miss} not set` });
    return !miss || opts.yes;
  });
  const runId = new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
  const outDir = join(expandHome("~/.coding.sh/dogfood/cli-runs"), runId);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const jobs = [];
  for (const t of picked) for (const d of usable) for (let i = 0; i < k; i++) jobs.push({ t, d, i });
  const trials = await pool(jobs, opts.concurrency ?? 2, async ({ t, d, i }) => {
    const budget = { ...suite.defaults?.budget, ...t.budget };
    let trial;
    try {
      trial = await prepareTrial(suite, t, { cli: opts.cli ?? CLI, seed: (opts.seed ?? 1) + i });
      const a = await runAgent(d, trial, budget);
      const checks = await runChecks(trial.task.check, trial, a.text);
      const tap = tapMetrics(readJsonl(trial.tapLog), suite.target?.usagePatterns);
      const over = a.timedOut ? "wallMs" : budget.costUsd && a.costUsd > budget.costUsd ? "costUsd" : budget.turns && a.turns > budget.turns ? "turns" : undefined;
      const rec = { task: t.id, split: t.split, driver: d, attempt: i, success: checks.every((c) => c.pass) && !over && !a.error, budgetExceeded: over, checks, ...tap, efficiency: t.expect?.minTargetCalls ? tap.targetCalls / t.expect.minTargetCalls : undefined, wallMs: Math.round(a.wallMs), costUsd: a.costUsd, turns: a.turns, error: a.error };
      appendFileSync(join(outDir, "trials.jsonl"), JSON.stringify(rec) + "\n");
      log(`${rec.success ? "pass" : "FAIL"} ${t.split}/${t.id} ${d} #${i}`);
      return rec;
    } catch (e) {
      const rec = { task: t.id, split: t.split, driver: d, attempt: i, success: false, error: e.message };
      appendFileSync(join(outDir, "trials.jsonl"), JSON.stringify(rec) + "\n");
      return rec;
    } finally {
      if (trial && !opts.keep) rmSync(trial.root, { recursive: true, force: true });
    }
  });
  const summary = Object.fromEntries(["dev", "heldout"].map((s) => [s, aggregate(trials.filter((r) => r.split === s))]));
  const out = { runId, outDir, drivers: usable, skipped, k, trials: trials.length, summary };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

export function aggregate(trials) {
  const n = trials.length;
  if (!n) return { n: 0 };
  const succ = trials.filter((r) => r.success).length;
  const sum = (f) => trials.reduce((a, r) => a + (f(r) ?? 0), 0);
  const rec = trials.map((r) => r.recoveryRate).filter((x) => x !== undefined);
  const costs = trials.filter((r) => typeof r.costUsd === "number");
  return {
    n,
    success: succ / n,
    ci: wilson(succ, n).map((x) => round(x, 3)),
    invalidRate: sum((r) => r.targetCalls) ? sum((r) => r.invalidCalls) / sum((r) => r.targetCalls) : 0,
    helpPerTask: sum((r) => r.helpLookups) / n,
    recoveryRate: rec.length ? rec.reduce((a, b) => a + b, 0) / rec.length : null,
    costUsd: costs.length ? round(costs.reduce((a, r) => a + r.costUsd, 0), 4) : null,
    costPerSuccess: costs.length && succ ? round(costs.reduce((a, r) => a + r.costUsd, 0) / succ, 4) : null,
    wallMs: Math.round(sum((r) => r.wallMs) / n),
    errors: trials.filter((r) => r.error).length,
  };
}

// ---------------------------------------------------------------- main

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json", "yes", "keep"] });
  const [cmd] = args._;
  const opts = { split: args.split, task: args.task, concurrency: args.concurrency ? Number(args.concurrency) : undefined, k: args.k, driver: args.driver, yes: args.yes, keep: args.keep, cli: args.cli ? resolve(args.cli) : undefined, seed: args.seed ? Number(args.seed) : undefined };
  if (cmd === "validate") {
    const r = await validate(opts);
    if (args.json) process.stdout.write(JSON.stringify(r) + "\n");
    else {
      for (const t of r.tasks) {
        const state = t.status === "blocked" ? `blocked: ${t.blockedBy}` : t.ok ? "ok" : `INVALID noopFails=${t.noopFails} referencePasses=${t.referencePasses} ${[...t.leakage, ...t.errors, ...(t.referenceFailures ?? [])].join(" | ").slice(0, 600)}`;
        process.stdout.write(`${t.split.padEnd(8)} ${t.id.padEnd(26)} ${state}\n`);
      }
      process.stdout.write(`\n${r.counts.validated} valid, ${r.counts.invalid} invalid, ${r.counts.blocked} blocked (dev ${r.counts.dev}, heldout ${r.counts.heldout})\n`);
    }
    process.exitCode = r.counts.invalid ? 1 : 0;
  } else if (cmd === "run") {
    const r = await runSuite(opts);
    if (args.json) process.stdout.write(JSON.stringify(r) + "\n");
    else process.stdout.write(JSON.stringify(r.summary, null, 2) + "\n");
    process.exitCode = r.trials && Object.values(r.summary).some((s) => s.errors) ? 1 : 0;
  } else {
    process.stderr.write("usage: cli-suite.mjs validate|run [--split dev|heldout|all] [--task id] [--driver d] [--k n] [--json]\n");
    process.exitCode = 2;
  }
}
