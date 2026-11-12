#!/usr/bin/env node
// Runs one git hook's plan: `node scripts/hooks/run.mjs pre-commit|pre-push`.
// The shell hooks in this folder call it. `--dry-run` prints the plan.
// CODING_SH_SKIP_HOOKS=1 (or git's --no-verify) skips it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, needsShell, precommitPlan, prepushPlan, pushedFiles, pushedRanges, stagedFiles } from "./lib.mjs";

const HOOKS = ["pre-commit", "pre-push"];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), stdin = readStdin } = {}) {
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
  const started = Date.now();
  for (const s of plan) {
    stderr.write(`${hook}: ${s.label}\n`);
    const r = spawnSync(s.cmd, s.args, { cwd: join(root, s.cwd), stdio: "inherit", env, shell: needsShell(s.cmd) });
    if (r.status !== 0) {
      const skip = hook === "pre-commit" ? "git commit --no-verify" : "git push --no-verify";
      stderr.write(`${hook}: ${s.label} failed${r.error ? ` (${r.error.message})` : ""}.\nnext: fix it and retry, or skip once with \`${skip}\`\n`);
      return 1;
    }
  }
  stderr.write(`${hook}: ok (${plan.length} step${plan.length === 1 ? "" : "s"}, ${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
