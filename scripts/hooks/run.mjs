#!/usr/bin/env node
// Runs one git hook's plan: `node scripts/hooks/run.mjs pre-commit|pre-push`.
// The shell hooks in this folder call it. `--dry-run` prints the plan.
// CODING_SH_SKIP_HOOKS=1 (or git's --no-verify) skips it.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, needsShell, precommitPlan, prepushPlan, pushedFiles, pushedRanges, stagedFiles } from "./lib.mjs";

const HOOKS = ["pre-commit", "pre-push"];
/** Seconds a hook may take before it says so. A slow hook gets skipped, so it reports itself. */
export const BUDGET_S = { "pre-push": 9 };

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Runs one step. Alone, it writes straight to the terminal. With `hold`, its
 * output is kept and returned, so steps that run together don't interleave.
 */
function run(root, s, env, hold) {
  return new Promise((done) => {
    const chunks = [];
    const child = spawn(s.cmd, s.args, { cwd: join(root, s.cwd), stdio: hold ? ["ignore", "pipe", "pipe"] : "inherit", env, shell: needsShell(s.cmd) });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (c) => chunks.push(c));
    child.on("error", (error) => done({ ok: false, error, output: Buffer.concat(chunks).toString("utf8") }));
    child.on("close", (status) => done({ ok: status === 0, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** The plan in the order it runs: each step alone, except a run of `together` steps, which is one batch. */
export function batches(plan) {
  const out = [];
  for (const s of plan) {
    const last = out.at(-1);
    if (s.together && last?.[0].together) last.push(s);
    else out.push([s]);
  }
  return out;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), stdin = readStdin, now = Date.now } = {}) {
  const dry = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const [hook, ...rest] = argv.filter((a) => !a.startsWith("--"));
  if (!HOOKS.includes(hook ?? "")) {
    stderr.write(`error: expected one of ${HOOKS.join(", ")}\nnext: node scripts/hooks/run.mjs pre-commit --dry-run\n`);
    return 2;
  }
  if (env.CODING_SH_SKIP_HOOKS === "1") {
    stderr.write(`${hook}: skipped (CODING_SH_SKIP_HOOKS=1)\n`);
    return 0;
  }
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    stderr.write(`error: not inside a git checkout\nnext: cd into the coding.sh repo\n`);
    return 2;
  }
  const root = resolve(top.out);
  const input = hook === "pre-push" ? stdin() : "";
  const files = hook === "pre-commit" ? stagedFiles(root) : pushedFiles(root, input, rest[0] ?? "origin");
  const plan = hook === "pre-commit" ? precommitPlan(root, files) : prepushPlan(root, files, pushedRanges(root, input, rest[0] ?? "origin"));
  if (dry) {
    if (json) stdout.write(`${JSON.stringify({ hook, files: files.length, plan })}\n`);
    else for (const s of plan) stdout.write(`${s.cwd}\t${s.label}\t${[s.cmd === process.execPath ? "node" : s.cmd, ...s.args].join(" ")}\n`);
    return 0;
  }
  if (!plan.length) {
    stderr.write(`${hook}: nothing to check\n`);
    return 0;
  }
  const started = now();
  for (const batch of batches(plan)) {
    for (const s of batch) stderr.write(`${hook}: ${s.label}\n`);
    const hold = batch.length > 1;
    const results = await Promise.all(batch.map((s) => run(root, s, env, hold)));
    const failed = batch.map((s, i) => ({ s, r: results[i] })).filter(({ r }) => !r.ok);
    if (!failed.length) continue;
    // Held output is shown for the steps that failed only, each under its own name.
    if (hold) for (const { s, r } of failed) stderr.write(`\n${hook}: ${s.label}:\n${r.output.trimEnd()}\n`);
    const why = failed.map(({ s, r }) => `${s.label}${r.error ? ` (${r.error.message})` : ""}`).join(", ");
    const skip = hook === "pre-commit" ? "git commit --no-verify" : "git push --no-verify";
    stderr.write(`${hook}: ${why} failed.\nnext: fix it and retry, or skip once with \`${skip}\`\n`);
    return 1;
  }
  const took = (now() - started) / 1000;
  stderr.write(`${hook}: ok (${plan.length} step${plan.length === 1 ? "" : "s"}, ${took.toFixed(1)}s)\n`);
  const budget = BUDGET_S[hook];
  if (budget !== undefined && took > budget) stderr.write(`${hook}: over its ${budget}s budget. The push went through; report it if this machine was idle.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
