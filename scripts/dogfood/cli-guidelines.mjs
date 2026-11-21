#!/usr/bin/env node
// cli.guidelines (docs/design/dogfood.md §4): static conformance of coding.sh's CLI to
// docs/CLI-GUIDELINES.md, across output modes, over a fixture home (never the
// live one). Score = fraction of (command, mode) cases where every rule holds.
//
//   node scripts/dogfood/cli-guidelines.mjs [--json] [--verbose]
//
// Rules checked per case:
//   exit       exit code in {0, 1, 2, 130}, and equal to the expected code when one is given
//   json       with --json: one JSON document; on success on stdout, on an
//              error as one line on stderr with stdout empty (src/cli/output.ts)
//   color      no ANSI color unless stdout is a TTY and NO_COLOR is unset
//   words      no "successfully", "just" or "simply" in CLI-authored text
//   didYouMean at most one "did you mean"
//   helpFast   --help in under 200 ms (piped mode only)
//   confirm    non-interactive init without --yes: exit 2 and reason confirmation_required
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLI, EVALS_CLI, log, parseArgs, readJson, sh, tempDir } from "./lib/util.mjs";
import { isMain } from "./lib/main.mjs";

const ANSI_COLOR = /\x1b\[[0-9;]*m/;
const BANNED = /\b(successfully|just|simply)\b/i;

// [id, argv, { expect, data }]: data = stdout carries user data (prompts, tool
// output), so the word rule only looks at stderr for it.
export const COMMANDS = [
  ["help", ["--help"], {}],
  ["sessions", ["sessions"], { data: true }],
  ["sessions-filtered", ["sessions", "--since", "7d", "--agent", "codex"], { data: true }],
  ["show-latest", ["show", "latest"], { data: true }],
  ["status", ["status"], { data: true }],
  ["doctor", ["doctor"], {}],
  ["search", ["search", "ECONNREFUSED"], { data: true }],
  ["version", ["version"], {}],
  ["exp-list", ["exp", "list"], { data: true }],
  ["dataset-list", ["dataset", "list"], { data: true }],
  ["eval-list", ["eval", "list"], { data: true }],
  ["harness-list", ["harness", "list"], { data: true }],
  ["config-get", ["config", "get", "capture.maxInlineBytes"], {}],
  ["exp-help", ["exp", "--help"], {}],
  ["typo-command", ["sesions"], { expect: 2 }],
  ["unknown-flag", ["sessions", "--bogus"], { expect: 2 }],
  ["missing-session", ["show", "no-such-session-id"], { expect: 1 }],
  ["init-no-yes", ["init"], { expect: 2, confirm: true, noTty: true }],
];

export const MODES = {
  piped: { env: {} },
  stdinPipe: { env: {}, input: "" },
  tty: { env: {}, tty: true },
  json: { env: {}, json: true },
  ci: { env: { CI: "1" } },
  agent: { env: { CLAUDECODE: "1" } },
  noColorTty: { env: { NO_COLOR: "1" }, tty: true },
};

/** The argv for script(1) that runs `argv` on a pseudo-terminal (BSD syntax on macOS, util-linux elsewhere). */
export function scriptArgs(argv, platform = process.platform) {
  return platform === "darwin" ? ["-q", "/dev/null", ...argv] : ["-qec", argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" "), "/dev/null"];
}

export const NO_SCRIPT = "no script(1) on this machine to give the child a terminal";

/**
 * Whether script(1) can start here: one trivial run through it. A spawn error (ENOENT on Windows,
 * where Git Bash has no script) means the TTY modes cannot be measured, so they are skipped.
 */
export function findScript(run = sh) {
  const r = run("script", scriptArgs([process.execPath, "-e", ""]), { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  return r.error ? { ok: false, reason: `${NO_SCRIPT} (${r.error.code ?? r.error.message})` } : { ok: true };
}

/**
 * Why the process for a case did not start, or undefined when it ran. A spawn error, or a missing
 * exit code with no signal, is the scorer's failure, not the CLI's exit code. A timeout kills the
 * CLI with a signal: that is the CLI's.
 */
export function notStarted(r) {
  if (r.signal) return undefined;
  if (r.error) return `process did not start: ${r.error.code ?? r.error.message}`;
  if (r.status === null) return "process did not start: no exit code and no signal";
  return undefined;
}

function runCase(cli, env, argv, mode) {
  const args = [...argv, ...(mode.json ? ["--json"] : [])];
  const e = { ...env, ...mode.env };
  if (mode.tty) {
    // `script` gives the child a pseudo-terminal on stdout/stderr.
    const r = sh("script", scriptArgs([process.execPath, cli, ...args]), { env: e, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { ...r, stdout: r.stdout.replace(/^\^D\x08\x08/, "").replaceAll("\r\n", "\n") };
  }
  return sh(process.execPath, [cli, ...args], { env: e, stdio: [mode.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input: mode.input, timeout: 60_000 });
}

export function judge(r, spec, mode) {
  const fails = [];
  const all = r.stdout + r.stderr;
  if (![0, 1, 2, 130].includes(r.code)) fails.push(`exit ${r.code} not in {0,1,2,130}`);
  if (spec.expect !== undefined && r.code !== spec.expect) fails.push(`exit ${r.code}, expected ${spec.expect}`);
  if (mode.json) {
    const doc = r.code === 0 ? r.stdout : r.stderr;
    const where = r.code === 0 ? "stdout" : "stderr (error)";
    try {
      JSON.parse(doc);
    } catch {
      fails.push(`--json ${where} is not one JSON document: ${JSON.stringify(doc.slice(0, 120))}`);
    }
    if (r.code !== 0 && r.stdout.trim()) fails.push("--json error also wrote to stdout");
  }
  const colorAllowed = mode.tty && !mode.env.NO_COLOR;
  if (!colorAllowed && ANSI_COLOR.test(all)) fails.push("ANSI color without a TTY or with NO_COLOR");
  const wordText = spec.data && !spec.id?.startsWith("help") ? r.stderr : all;
  const w = BANNED.exec(mode.json ? r.stderr : wordText);
  if (w) fails.push(`banned word "${w[1]}"`);
  const dym = (all.match(/did you mean/gi) ?? []).length;
  if (dym > 1) fails.push(`${dym} "did you mean" suggestions`);
  if (spec.helpFast && !mode.tty && r.ms >= 200) fails.push(`--help took ${Math.round(r.ms)} ms`);
  if (spec.confirm) {
    if (mode.json) {
      let reason;
      try {
        reason = JSON.parse(r.stderr).reason;
      } catch {}
      if (reason !== "confirmation_required") fails.push(`init --json reason ${reason}, expected confirmation_required`);
    } else if (!/confirm/i.test(all)) fails.push("init without --yes does not ask for confirmation");
  }
  return fails;
}

/**
 * Run every (command, mode) case through `run(argv, mode)` and score it. Without script(1)
 * (`script.ok` false) the TTY modes are left out of the score and reported in `skipped`. A case
 * whose process did not start is a scorer error, listed in `scorerErrors` and left out of `n`.
 */
export function scoreCases({ run, script = { ok: true }, commands = COMMANDS, modes = MODES }) {
  const cases = [];
  const scorerErrors = [];
  const skippedModes = script.ok ? [] : Object.entries(modes).filter(([, m]) => m.tty).map(([k]) => k);
  for (const [id, argv, spec0] of commands) {
    const spec = { ...spec0, id, helpFast: argv.includes("--help") };
    for (const [m, mode] of Object.entries(modes)) {
      if (mode.tty && (spec.noTty || !script.ok)) continue;
      const r = run(argv, mode);
      const error = notStarted(r);
      if (error) {
        scorerErrors.push({ id, mode: m, argv, error });
        continue;
      }
      const fails = judge(r, spec, mode);
      cases.push({ id, mode: m, argv, exit: r.code, ms: Math.round(r.ms), pass: !fails.length, fails });
    }
  }
  const passed = cases.filter((c) => c.pass).length;
  return {
    value: cases.length ? passed / cases.length : null,
    passed,
    n: cases.length,
    failures: cases.filter((c) => !c.pass),
    scorerErrors,
    ...(skippedModes.length ? { skipped: { modes: skippedModes, reason: script.reason ?? NO_SCRIPT } } : {}),
  };
}

/** Build the fixture home once and run every (command, mode) case. `script` overrides the script(1) lookup. */
export function runGuidelines({ cli = CLI, script = findScript() } = {}) {
  const root = tempDir("cs-guidelines-");
  try {
    const trial = join(root, "trial");
    mkdirSync(trial);
    const answersFile = join(root, "answers.json");
    const mk = sh(process.execPath, [join(EVALS_CLI, "fixtures", "make-home.mjs"), "--seed", "1", "--out", trial, "--cli", cli, "--answers", answersFile], { env: { ...process.env, CODING_SH_HOME: join(trial, "home", ".coding.sh"), HOME: join(trial, "home") } });
    if (mk.code !== 0) throw new Error(`fixture build failed: ${mk.stderr.slice(-400)}`);
    const env = { ...readJson(answersFile).env };
    for (const k of ["CI", "CLAUDECODE", "NO_COLOR", "FORCE_COLOR"]) delete env[k];
    return scoreCases({ run: (argv, mode) => runCase(cli, { ...process.env, ...env, PATH: `${env.PATH}` }, argv, mode), script });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json", "verbose"] });
  const r = runGuidelines();
  if (args.json) process.stdout.write(JSON.stringify(r) + "\n");
  else {
    for (const f of r.failures) process.stdout.write(`FAIL ${f.id.padEnd(18)} ${f.mode.padEnd(11)} ${f.fails.join("; ")}\n`);
    process.stdout.write(`cli.guidelines ${r.passed}/${r.n} = ${r.value.toFixed(3)}\n`);
  }
  if (args.verbose) log(JSON.stringify(r, null, 2));
}
