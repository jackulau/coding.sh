#!/usr/bin/env node
// `coding.sh refine run --suite --objective cost`, end to end with real Claude
// Code: install coding.sh from a tarball and the real Claude Code CLI from npm
// under a throwaway HOME, point both at a local stub model, and climb a bloated
// CLAUDE.md down on a suite of six repo tasks (2 trials each).
//
// The stub bills input tokens by the size of each request, so a shorter
// CLAUDE.md is cheaper. It writes chore.txt (what each task's hidden check
// wants) only when the request still carries the ESSENTIAL line, so a cut that
// drops that line fails every task. As the proposer it answers with a cut.
//
//   round 1  the proposer cuts the style section: same pass rate, lower cost
//            and tokens per run → kept on efficiency and applied.
//   round 2  --candidate drops the ESSENTIAL line: cheaper still, but every task
//            fails → rejected (hard regression), CLAUDE.md untouched.
//   round 3  the proposer is shown what made the last runs expensive (tokens per
//            run from the captured sessions) and the rejected cut, and cuts the
//            safety line → rejected by the protected-line check before any run.
//
//   node scripts/e2e/refine-suite-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME. Exit 0 when every check passed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub, toolNames } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-4-5";
const TASKS = 6;
const ESSENTIAL = "ESSENTIAL: when you finish a chore, write chore.txt with the word done.";
const SAFETY = "Never run `git push --force`.";
const STYLE = Array.from({ length: 300 }, (_, i) => `- Style note ${i}: prefer clear names, short functions and small modules over clever code.`).join("\n");
const BLOATED = `# Project\n\n${ESSENTIAL}\n${SAFETY}\n\n## Style\n\n${STYLE}\n`;

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const log = (...a) => console.log("[refine-suite-capture]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

function run(file, args, { cwd, env, timeoutMs = 1_800_000, quiet = false } = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env: cwd && env ? { ...env, PWD: cwd } : env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!quiet && code !== 0 && code !== 1) log(`${file} ${args.join(" ")} exited ${code}\n--- stdout\n${stdout.slice(-4000)}\n--- stderr\n${stderr.slice(-4000)}`);
      done({ code, stdout, stderr });
    });
  });
}

// ------------------------------------------------------------------ the stub's scenario

/** The cut the proposer answers with next, and every proposer prompt it got. */
let nextCut = { edits: [{ section: "## Style", replace: "" }], rationale: "the style notes repeat one rule 300 times" };
const proposerPrompts = [];
let wrote = 0;

const results = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_result") : [])).length;

function scenario(body) {
  const system = typeof body.system === "string" ? body.system : "";
  if (system.startsWith("You make the instruction file")) {
    proposerPrompts.push(String(body.messages?.[0]?.content ?? ""));
    return { text: JSON.stringify(nextCut) };
  }
  if (!Array.isArray(body.messages)) return { text: "ok" };
  const all = JSON.stringify(body);
  // Input tokens grow with the request, so a bloated CLAUDE.md costs more on every call.
  const usage = { input_tokens: Math.round(all.length / 4) };
  if (!/Do chore \d/.test(all) || !toolNames(body).includes("Write")) return { text: "ok", usage };
  const cwd = /[Ww]orking directory: ([^\s"\\]+)/.exec(all)?.[1];
  if (!cwd || results(body) > 0 || !all.includes("ESSENTIAL:")) return { text: "Done.", usage };
  wrote++;
  return { tool: { name: "Write", args: { file_path: `${cwd}/chore.txt`, content: "done\n" } }, usage };
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const isWin = process.platform === "win32";
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-refinesuite-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const csHome = join(home, ".coding.sh");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
const binDir = isWin ? prefix : join(prefix, "bin");

const stub = await startStub({ decide: scenario });
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) continue;
  env[k] = v;
}
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  CODING_SH_HOME: csHome,
  [pathKey]: [binDir, env[pathKey]].filter(Boolean).join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  CODING_SH_NO_UPDATE_CHECK: "1",
  CODING_SH_NO_UI: "1",
  NO_COLOR: "1",
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  // Claude Code refuses bypassPermissions as root unless it is told it is sandboxed (the desk runs as root).
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
log(`temp root ${root}`);
log(`stub model on ${stub.url}`);

let exitCode = 0;
try {
  let tarball = opts.tarball;
  if (!tarball) {
    const pkgDir = join(REPO, "packages", "coding.sh");
    if (!existsSync(join(pkgDir, "dist", "cli.mjs"))) throw new Error("packages/coding.sh/dist is missing: run npm run build first, or pass --tarball");
    const packed = await run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: pkgDir });
    if (packed.code !== 0) throw new Error("npm pack failed");
    tarball = join(root, packed.stdout.trim().split(/\r?\n/).pop());
  }
  log(`installing ${tarball} and ${CLAUDE}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, CLAUDE], { env, cwd: root });
  if (install.code !== 0) throw new Error("npm install -g failed");
  const proj = join(root, "proj");
  const cs = (args, o = {}) => run("coding.sh", args, { env, cwd: proj, ...o });
  const json = (r, what) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`${what}: not JSON (exit ${r.code}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
    }
  };
  log(`coding.sh ${(await cs(["--version"], { cwd: root })).stdout.trim()}`);
  const init = await cs(["init", "--agent", "claude-code", "--yes", "--no-mcp", "--json"], { cwd: root });
  check(init.code === 0, "coding.sh init --agent claude-code", init.stderr);

  // The project: a bloated CLAUDE.md and a suite of six chores, each checked by a hidden test.
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "CLAUDE.md"), BLOATED);
  const suite = join(proj, "evals", "chores");
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, "suite.json"), `${JSON.stringify({ name: "chores", purpose: "regression", trials: 2, tasks: "tasks" }, null, 2)}\n`);
  for (let i = 0; i < TASKS; i++) {
    const t = join(suite, "tasks", `chore-${i}`);
    mkdirSync(join(t, "tests"), { recursive: true });
    writeFileSync(join(t, "task.json"), `${JSON.stringify({ name: `chore-${i}`, verifier: { command: "node check.mjs", timeoutMs: 60_000 } }, null, 2)}\n`);
    writeFileSync(join(t, "instruction.md"), `Do chore ${i}.\n`);
    writeFileSync(join(t, "tests", "check.mjs"), 'import { existsSync, readFileSync } from "node:fs";\nprocess.exit(existsSync("chore.txt") && readFileSync("chore.txt", "utf8").includes("done") ? 0 : 1);\n');
  }
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "start"]]) execFileSync("git", args, { cwd: proj, env });
  const climb = ["--suite", "chores", "--objective", "cost,tokens", "--margin", "2pp", "--model", MODEL];

  // ---------------------------------------------------------------- dry run
  const dry = await cs(["refine", "run", ...climb, "--dry-run", "--json"]);
  const plan = json(dry, "refine run --dry-run");
  check(dry.code === 0 && plan.mode === "cut" && plan.sessionsPerRound === TASKS * 4 && plan.target === "CLAUDE.md", "dry run: a cut climb on CLAUDE.md, 24 sessions a round", plan);

  // ---------------------------------------------------------------- round 1: the proposer's cut is kept on cost
  const r1 = await cs(["refine", "run", ...climb, "--rounds", "1", "--yes", "--json"]);
  const d1 = json(r1, "refine run round 1");
  const k1 = d1.rounds?.[0];
  const cost1 = k1?.objectives?.metrics?.find((m) => m.objective === "cost");
  const tok1 = k1?.objectives?.metrics?.find((m) => m.objective === "tokens");
  log(`round 1: ${k1?.verdict} ${k1?.reasons?.[0]}`);
  log(`round 1 arms: ${JSON.stringify(k1?.objectives?.arms)}`);
  check(r1.code === 0 && k1?.verdict === "keep" && k1.objectives.branch === "efficiency", "round 1: the cut is kept on efficiency", k1?.reasons);
  check(k1?.objectives?.arms.base.pass === 1 && k1?.objectives?.arms.cand.pass === 1, "round 1: every trial passes in both arms", k1?.objectives?.arms);
  check(cost1?.better && cost1.relative < -0.1 && cost1.hi < 0 && cost1.coverage.base === 1 && cost1.coverage.cand === 1, "round 1: cost per run is significantly lower, from every run's captured usage", cost1);
  check(tok1?.better && tok1.relative < -0.1, "round 1: tokens per run are significantly lower", tok1);
  check(wrote === TASKS * 4, `the agent wrote chore.txt in all ${TASKS * 4} runs`, wrote);
  const after1 = readFileSync(join(proj, "CLAUDE.md"), "utf8");
  check(after1.includes(ESSENTIAL) && after1.includes(SAFETY) && !after1.includes("Style note"), "round 1: the kept cut is applied to CLAUDE.md", after1.slice(0, 300));
  check(proposerPrompts.length === 1 && /Largest sections: ## Style/.test(proposerPrompts[0]) && /READ-ONLY[\s\S]*git push --force/.test(proposerPrompts[0]), "round 1: the proposer saw the largest sections and the protected line", proposerPrompts[0]?.slice(0, 600));

  // ---------------------------------------------------------------- round 2: a cheaper cut that drops the ESSENTIAL line is rejected
  const broken = join(root, "drafts", "CLAUDE.md");
  mkdirSync(dirname(broken), { recursive: true });
  writeFileSync(broken, `# Project\n\n${SAFETY}\n`);
  const r2 = await cs(["refine", "run", ...climb, "--candidate", broken, "--yes", "--json"]);
  const d2 = json(r2, "refine run round 2");
  const k2 = d2.rounds?.[0];
  log(`round 2: ${k2?.verdict} ${k2?.reasons?.[0]}`);
  check(r2.code === 1 && k2?.verdict === "reject" && /hard regression/.test(k2.reasons[0]), "round 2: dropping the line the tasks need is rejected", k2?.reasons);
  check(k2?.objectives?.arms.cand.pass === 0 && k2?.objectives?.metrics.find((m) => m.objective === "cost")?.relative < 0, "round 2: it was cheaper, and every task failed", k2?.objectives?.arms);
  check(readFileSync(join(proj, "CLAUDE.md"), "utf8").includes("ESSENTIAL:"), "round 2: CLAUDE.md is untouched");

  // ---------------------------------------------------------------- round 3: the proposer sees the drivers; a cut of the safety line never runs
  nextCut = { edits: [{ find: `${SAFETY}\n`, replace: "" }], rationale: "shorter" };
  const r3 = await cs(["refine", "run", ...climb, "--rounds", "1", "--yes", "--json"]);
  const d3 = json(r3, "refine run round 3");
  const k3 = d3.rounds?.[0];
  const p3 = proposerPrompts[1] ?? "";
  log(`round 3 prompt drivers:\n${/What the last eval runs show:[\s\S]*?(?=\n\n)/.exec(p3)?.[0] ?? "(none)"}`);
  check(/12 runs over 6 tasks, 100% passed\. Per run: cost \$[\d.]+, \d+ tokens/.test(p3), "round 3: the proposer is shown cost and tokens per run from the last round's runs", p3.slice(0, 800));
  check(/Tested before and not kept[\s\S]*ESSENTIAL:/.test(p3), "round 3: the proposer is shown the rejected cut and the lines it removed");
  check(k3?.verdict === "reject" && k3.stage === "protected" && k3.objectives === undefined, "round 3: a cut of the safety line is rejected before any agent runs", k3);

  // ---------------------------------------------------------------- the log
  const lg = await cs(["refine", "log"], { quiet: true });
  log(`refine log:\n${lg.stdout}`);
  check(lg.code === 0 && /Climb on chores \(CLAUDE\.md, primary cost \/ run\)/.test(lg.stdout) && /Pareto front \(pass rate vs cost \/ run\)/.test(lg.stdout), "refine log: the climb and its Pareto front");
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`stub requests (${stub.requests.length}): ${JSON.stringify(stub.requests.slice(-20))}`);
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
