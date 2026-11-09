#!/usr/bin/env node
// Opt-in git hooks for this checkout: points core.hooksPath at scripts/hooks.
//
//   node scripts/hooks/install.mjs              # install
//   node scripts/hooks/install.mjs --status     # say what is installed
//   node scripts/hooks/install.mjs --uninstall  # remove
//
// It only changes this repo's local git config. It refuses to replace another
// hooksPath, or to hide hooks already in .git/hooks, unless you pass --force.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./lib.mjs";

export const HOOKS_PATH = "scripts/hooks";
const HOOK_FILES = ["pre-commit", "pre-push"];

/** Hooks git would run from the default hooks dir (not the .sample ones). */
function activeDefaultHooks(root) {
  const r = git(root, ["rev-parse", "--git-path", "hooks"]);
  if (!r.ok) return [];
  const dir = isAbsolute(r.out) ? r.out : join(root, r.out);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.endsWith(".sample") && !f.startsWith("."));
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const known = ["--status", "--uninstall", "--force", "--help"];
  const bad = argv.find((a) => !known.includes(a));
  if (bad) {
    stderr.write(`error: unknown argument ${bad}\nnext: node scripts/hooks/install.mjs [--status | --uninstall] [--force]\n`);
    return 2;
  }
  if (argv.includes("--help")) {
    stdout.write("Usage: node scripts/hooks/install.mjs [--status | --uninstall] [--force]\n\nInstalls the repo's pre-commit (slop lint + typecheck) and pre-push (tests of touched packages) hooks\nby setting core.hooksPath to scripts/hooks in this checkout's git config.\n");
    return 0;
  }
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    stderr.write("error: not inside a git checkout\nnext: cd into the coding.sh repo\n");
    return 2;
  }
  const root = resolve(top.out);
  const current = git(root, ["config", "--local", "--get", "core.hooksPath"]).out;
  const force = argv.includes("--force");

  if (argv.includes("--status")) {
    stdout.write(current === HOOKS_PATH ? `installed: core.hooksPath=${HOOKS_PATH} (${HOOK_FILES.join(", ")})\n` : current ? `not installed: core.hooksPath is ${current}\n` : "not installed\n");
    return 0;
  }

  if (argv.includes("--uninstall")) {
    if (current !== HOOKS_PATH) {
      stdout.write(current ? `left alone: core.hooksPath is ${current}, not ${HOOKS_PATH}\n` : "not installed\n");
      return 0;
    }
    const r = git(root, ["config", "--local", "--unset", "core.hooksPath"]);
    if (!r.ok) {
      stderr.write(`error: git config --unset failed: ${r.err}\n`);
      return 1;
    }
    stdout.write("uninstalled: core.hooksPath unset\n");
    return 0;
  }

  if (current === HOOKS_PATH) {
    stdout.write(`already installed: core.hooksPath=${HOOKS_PATH}\n`);
    return 0;
  }
  if (current && !force) {
    stderr.write(`error: core.hooksPath is already ${current}\nnext: node scripts/hooks/install.mjs --force (replaces it)\n`);
    return 1;
  }
  const hidden = current ? [] : activeDefaultHooks(root);
  if (hidden.length && !force) {
    stderr.write(`error: these hooks in .git/hooks would stop running: ${hidden.join(", ")}\nnext: node scripts/hooks/install.mjs --force (or move them into ${HOOKS_PATH})\n`);
    return 1;
  }
  for (const f of HOOK_FILES) {
    const p = join(root, HOOKS_PATH, f);
    if (!existsSync(p)) {
      stderr.write(`error: ${HOOKS_PATH}/${f} is missing\nnext: git checkout -- ${HOOKS_PATH}\n`);
      return 1;
    }
    if (process.platform !== "win32") chmodSync(p, 0o755);
  }
  const r = git(root, ["config", "--local", "core.hooksPath", HOOKS_PATH]);
  if (!r.ok) {
    stderr.write(`error: git config failed: ${r.err}\n`);
    return 1;
  }
  stdout.write(`installed: pre-commit (slop lint + typecheck), pre-push (tests of touched packages)\n`);
  stderr.write("skip once with --no-verify, or set CODING_SH_SKIP_HOOKS=1; remove with node scripts/hooks/install.mjs --uninstall\n");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
