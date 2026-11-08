#!/usr/bin/env node
// `coding.sh eval init` then `coding.sh eval run`, end to end with real Claude
// Code: install coding.sh from a tarball and the real Claude Code CLI from npm
// under a throwaway HOME, point both at a local stub model, and build one suite
// per persona in a small git project.
//
//   failures  a captured session where the agent wrote a wrong sum.js:
//             eval init --session latest drafts a repo task with the failed diff as a
//             near miss; eval run -k 2 has the agent write the right code in one trial
//             and the wrong code in the other: pass@2 100%, pass^2 0%, flaky, a transcript.
//   triage    eval init --describe … --draft: the stub (as the drafting model, reached
//             through ANTHROPIC_BASE_URL) writes four cases with exact answers; eval run
//             grades the project's triage.mjs with an exact grader and exits 1 on the
//             case it gets wrong (a regression suite).
//   pdf       eval init --skill .claude/skills/pdf --draft: the stub writes should and
//             should_not prompts; eval run probes Claude Code, where the stub routes to
//             the skill whose description names a word of the prompt: all 4 right, exit 0.
//
//   node scripts/e2e/eval-init-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME. Exit 0 when every check passed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub, toolNames } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-4-5";
const INSTRUCTION = "Make sum.js add its two arguments.";
const GOOD = "module.exports = (a, b) => a + b;\n";
const BAD = "module.exports = (a, b) => a * b;\n";
const SKILLS = { pdf: "pdf", docx: "docx, word" };
const DRAFT_CASES = [
  { input: "I was charged twice this month", expected: "billing", should: true },
  { input: "The app crashes when I open settings", expected: "bug", should: true },
  { input: "The save button is the wrong color", expected: "bug", should: true, note: "a bug with no crash words" },
  { input: "What are your office hours?", expected: "other", should: false },
];
const DRAFT_TRIGGERS = { should: ["Fill in this pdf form", "Merge two pdf files into one"], should_not: ["Write a docx memo for the team", "Sort this list of names"] };

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

const log = (...a) => console.log("[eval-init-capture]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

function run(file, args, { cwd, env, timeoutMs = 900_000, quiet = false } = {}) {
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

/** "capture": the agent writes the wrong sum.js and sees the test fail. "suite": trials alternate right and wrong. */
let phase = "capture";
let writes = 0;
const drafts = { cases: 0, triggers: 0 };
const routed = [];

const results = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_result") : [])).length;

/** The skills Claude Code listed for the model, as name → trigger words. */
function listedSkills(all) {
  const out = {};
  for (const m of all.matchAll(/Use when the user mentions ([^.]*)\./g)) {
    const before = all.slice(Math.max(0, m.index - 200), m.index);
    const name = Object.keys(SKILLS)
      .map((n) => [n, before.lastIndexOf(n)])
      .filter(([, i]) => i >= 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    if (name && !out[name]) out[name] = m[1].split(/,\s*/).filter(Boolean);
  }
  return out;
}

function scenario(body) {
  const system = typeof body.system === "string" ? body.system : "";
  // coding.sh's own drafting calls: a plain system string, no tools.
  if (system.startsWith("You write evaluation cases")) {
    drafts.cases++;
    return { text: JSON.stringify({ cases: DRAFT_CASES }) };
  }
  if (system.startsWith("You write routing tests")) {
    drafts.triggers++;
    return { text: JSON.stringify(DRAFT_TRIGGERS) };
  }
  if (!Array.isArray(body.messages)) return { text: "ok" };
  const names = toolNames(body);
  const all = JSON.stringify(body);
  const prompt = [...DRAFT_TRIGGERS.should, ...DRAFT_TRIGGERS.should_not].find((p) => all.includes(p));
  if (prompt) {
    // A trigger probe: load the skill whose listed words appear in the prompt, else answer.
    if (!names.includes("Skill") || results(body)) return { text: "done" };
    const lower = prompt.toLowerCase();
    const skill = Object.entries(listedSkills(all)).find(([, words]) => words.some((w) => lower.includes(w)))?.[0];
    routed.push(`${prompt} → ${skill ?? "-"}`);
    return skill ? { tool: { name: "Skill", args: { skill } } } : { text: "done" };
  }
  if (!all.includes(INSTRUCTION) || !names.includes("Write") || !names.includes("Bash")) return { text: "ok" };
  const cwd = /[Ww]orking directory: ([^\s"\\]+)/.exec(all)?.[1];
  if (!cwd) return { text: "ok" };
  const file = `${cwd}/sum.js`;
  const step = results(body);
  if (step === 0) return { tool: { name: "Read", args: { file_path: file } } };
  if (step === 1) {
    const good = phase === "suite" && ++writes % 2 === 1;
    return { tool: { name: "Write", args: { file_path: file, content: good ? GOOD : BAD } } };
  }
  if (step === 2 && phase === "capture") return { tool: { name: "Bash", args: { command: "node test.js", description: "Run the test" } } };
  return { text: "Done." };
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const isWin = process.platform === "win32";
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-evalinit-"));
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

  // The project: a broken sum.js with its test, a triage app, and two skills.
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "sum.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(proj, "test.js"), 'const sum = require("./sum.js");\nif (sum(2, 3) !== 5) {\n  console.error("sum(2, 3) should be 5");\n  process.exit(1);\n}\nconsole.log("ok");\n');
  writeFileSync(
    join(proj, "triage.mjs"),
    'let s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => {\n  const t = String(JSON.parse(s)).toLowerCase();\n  process.stdout.write(/charge|refund/.test(t) ? "billing" : /crash|error/.test(t) ? "bug" : "other");\n});\n',
  );
  for (const [name, words] of Object.entries(SKILLS)) {
    mkdirSync(join(proj, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Use when the user mentions ${words}.\n---\nSay which ${name} tool you would use.\n`);
  }
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "start"]]) execFileSync("git", args, { cwd: proj, env });

  // ---------------------------------------------------------------- failures: a repo task from a failed session
  const cap = await run("claude", ["-p", INSTRUCTION, "--model", MODEL, "--permission-mode", "bypassPermissions"], { env, cwd: proj });
  check(cap.code === 0, "the failed session ran", cap.stderr.slice(-500));
  // The hook kicks an ingest on Stop that snapshots the work tree as the session's end state.
  // Ingest here too so that snapshot is taken before the repo goes back.
  const ing = await cs(["ingest"]);
  check(ing.code === 0, "coding.sh ingest", ing.stderr.slice(-500));
  execFileSync("git", ["checkout", "--", "sum.js"], { cwd: proj, env });
  const fi = await cs(["eval", "init", "failures", "--session", "latest", "--verifier", "node test.js", "--json"]);
  const f = json(fi, "eval init --session latest");
  check(fi.code === 0 && f.kind === "tasks" && f.purpose === "capability" && f.tasks?.length === 1, "eval init: one repo task, a capability suite", f);
  check(f.ci === undefined && f.run === "coding.sh eval run failures", "eval init: the run command, no CI snippet for repo tasks", f);
  const taskDir = join(proj, "evals", "failures", "tasks", readdirSync(join(proj, "evals", "failures", "tasks"))[0] ?? "-");
  const nearMiss = join(taskDir, "near-misses", "001.patch");
  const ref = join(taskDir, "reference.patch");
  log(`task dir: ${readdirSync(taskDir).join(", ")}`);
  check(existsSync(nearMiss) ? /a \* b/.test(readFileSync(nearMiss, "utf8")) && !existsSync(ref) : /a \* b/.test(readFileSync(ref, "utf8")), "eval init: the session's diff is kept (a near miss when the session was flagged)");
  check(JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")).tags.includes("suite:failures"), "eval init: the task is tagged suite:failures");

  phase = "suite";
  const fr = await cs(["eval", "run", "failures", "-k", "2", "--model", MODEL, "--yes", "--json"]);
  const frj = json(fr, "eval run failures");
  const r = frj.report;
  log(`failures report: ${JSON.stringify({ k: r.k, passed: r.passed, trials: r.trials, passAtK: r.passAtK, passHatK: r.passHatK, flaky: r.flaky, rows: r.rows })}`);
  check(fr.code === 0, "eval run: a capability suite exits 0 on any score", fr.stderr.slice(-800));
  check(r.k === 2 && r.passed === 1 && r.trials === 2, "eval run: 1 of 2 trials passed", r);
  check(r.passAtK === 1 && r.passHatK === 0 && r.flaky.length === 1, "eval run: pass@2 100%, pass^2 0%, one flaky task", r);
  const failedSession = r.rows[0]?.failedSession;
  check(!!failedSession, "eval run: the failed trial links its captured session");
  if (failedSession) {
    const show = await cs(["show", failedSession.slice(0, 12)], { quiet: true });
    check(show.code === 0 && /sum\.js/.test(show.stdout), "coding.sh show opens the failed trial's transcript", show.stderr.slice(-300));
  }
  const text = await cs(["eval", "run", "failures", "-k", "2", "--model", MODEL, "--yes"], { quiet: true });
  log(`failures text:\n${text.stdout}`);
  check(/^pass\^2  0\.0%/m.test(text.stdout) && /flaky: /m.test(text.stdout), "eval run: the text report shows pass^k and the flaky task");

  // ---------------------------------------------------------------- triage: drafted cases, an exact grader, a regression
  const ti = await cs(["eval", "init", "triage", "--describe", "Labels a support ticket billing, bug or other", "--command", "node triage.mjs", "--draft", "--json"]);
  const t = json(ti, "eval init triage --draft");
  check(ti.code === 0 && t.drafted === true && t.kind === "cases" && t.purpose === "regression", "eval init --draft: a drafted regression suite", t);
  check(drafts.cases === 1, "the drafting call reached the stub through ANTHROPIC_BASE_URL", drafts);
  const lines = readFileSync(join(proj, "evals", "triage", "cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check(lines.length === 4 && lines.every((l) => l.metadata?.draft === true) && lines.filter((l) => l.tags?.[0] === "should-not").length === 1, "eval init --draft: 4 cases, marked draft, one should-not", lines);
  check(JSON.parse(readFileSync(join(proj, "evals", "triage", "suite.json"), "utf8")).graders[0].kind === "exact", "eval init: short expected answers get an exact grader");
  check(/coding\.sh eval run triage --yes/.test(t.ci ?? ""), "eval init: a CI workflow for the cases suite");
  const tr = await cs(["eval", "run", "triage", "--json"]);
  const trj = json(tr, "eval run triage");
  check(tr.code === 1 && trj.report.failing.length === 1 && /^the-save-button/.test(trj.report.failing[0]), "eval run: the regression suite exits 1 on the case triage.mjs gets wrong", trj.report);
  const ttext = await cs(["eval", "run", "triage"], { quiet: true });
  log(`triage text:\n${ttext.stdout}${ttext.stderr}`);
  check(ttext.code === 1 && /regression suite: the-save-button\S* fails most trials/.test(ttext.stdout + ttext.stderr), "eval run: the text report names the case that fails most trials");

  // ---------------------------------------------------------------- pdf: drafted trigger prompts, probed on Claude Code
  const pi = await cs(["eval", "init", "--skill", ".claude/skills/pdf", "--draft", "--json"]);
  const p = json(pi, "eval init --skill --draft");
  check(pi.code === 0 && p.name === "pdf" && p.kind === "triggers" && p.drafted === true && p.todo === false, "eval init --skill --draft: a drafted trigger suite", p);
  check(/^# DRAFT/m.test(readFileSync(join(proj, "evals", "pdf", "triggers.toml"), "utf8")), "eval init: triggers.toml says DRAFT");
  const pr = await cs(["eval", "run", "pdf", "-k", "1", "--model", MODEL, "--yes", "--json"]);
  const prj = json(pr, "eval run pdf");
  log(`routing: ${routed.join("; ")}`);
  check(pr.code === 0 && prj.kind === "triggers" && prj.report.tasks === 4 && prj.report.passed === 4 && prj.report.ok, "eval run: all 4 trigger prompts right, exit 0", prj.report);

  // ---------------------------------------------------------------- every suite at once
  const all = await cs(["eval", "run", "-k", "1", "--model", MODEL, "--yes", "--json"]);
  const allj = json(all, "eval run (all)");
  check(all.code === 1 && allj.ok === false && allj.suites.map((s) => s.suite).sort().join(",") === "failures,pdf,triage", "eval run with no names runs every suite and exits 1 for triage", allj.suites?.map((s) => [s.suite, s.report.ok]));
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`stub requests (${stub.requests.length}): ${JSON.stringify(stub.requests.slice(-40))}`);
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
