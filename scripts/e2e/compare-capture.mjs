#!/usr/bin/env node
// Harness compare, end to end with real agents: install coding.sh from a
// tarball and the real Claude Code and Codex CLIs from npm under a throwaway
// HOME, point them at a local stub model, and run `coding.sh compare` on two
// tasks with bundles that differ by exactly one rule, skill or context file.
// Every run is a captured agent session, so the one-item gate (AA-2) reads real
// exposure and the own-tests split (AB-10) reads real test results.
//
// The stub plays a scripted agent per task: read the file, write it, run its own
// (always green) tests, then answer. What it writes depends on what reached its
// context:
//   sum task: a correct sum only when the "good" item's text is in context:
//             Claude Code: the path-scoped rule .claude/rules/sum.md (paths: sum.js),
//               which Claude Code loads after the Read of sum.js;
//             Codex: the skill .agents/skills/sum-fix, which the agent opens (cat) on sum only.
//   mul task: a correct mul unless the "bad" always-on item is in context
//             (Claude Code: .claude/rules/style.md; Codex: AGENTS.md).
// Expected per agent: base vs good → KEEP (S = {sum}: the item never loads on mul);
// base vs bad → KILL (mul breaks); good vs base re-analysed → REJECT. Base fails
// on sum are silent misses: own tests green, verifier red.
//
//   node scripts/e2e/compare-capture.mjs [--agent claude-code|codex]... [--tarball coding.sh-x.y.z.tgz] [--k 3] [--keep]
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
const isWin = process.platform === "win32";
const TASKS = {
  sum: { instruction: "Make sum.js add its two arguments.", good: "module.exports = (a, b) => a + b;\n", bad: "module.exports = (a, b) => a - b;\n" },
  mul: { instruction: "Make mul.js multiply its two arguments.", good: "module.exports = (a, b) => a * b;\n", bad: "module.exports = (a, b) => a + b;\n" },
};
const SUM_RULE = "SUM-RULE: sum.js must use the + operator.";
const BAD_RULE = "STYLE-RULE: always combine numbers with +.";

/** Per agent: the pinned CLI, how to point it at the stub, and its base/good/bad bundles. */
const AGENTS = {
  "claude-code": {
    pkg: "@anthropic-ai/claude-code@2.1.319",
    bin: "claude",
    model: "claude-sonnet-4-5",
    flags: () => [],
    include: ["CLAUDE.md", ".claude/**"],
    base: { "CLAUDE.md": "Keep changes small.\n" },
    good: { path: ".claude/rules/sum.md", kind: "rule", tier: "path", text: `---\npaths: sum.js\n---\n${SUM_RULE}\n` },
    bad: { path: ".claude/rules/style.md", kind: "rule", tier: "always", text: `${BAD_RULE}\n` },
  },
  codex: {
    pkg: "@openai/codex@0.167.0",
    bin: "codex",
    model: "gpt-5",
    // A custom provider: Codex ignores OPENAI_BASE_URL. The same flags in every arm.
    flags: (url) => ["-c", "model_provider=stub", "-c", `model_providers.stub={name="stub",base_url="${url}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`],
    include: ["AGENTS.md", ".agents/**"],
    base: { ".agents/skills/notes/SKILL.md": "---\nname: notes\ndescription: Use when writing release notes.\n---\nKeep notes short.\n" },
    good: { path: ".agents/skills/sum-fix/SKILL.md", kind: "skill", tier: "always", text: `---\nname: sum-fix\ndescription: Use when changing sum.js.\n---\n${SUM_RULE}\n` },
    bad: { path: "AGENTS.md", kind: "context", tier: "always", text: `${BAD_RULE}\n` },
  },
};

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined, k: 3, agents: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--agent") {
      const id = argv[++i];
      if (!AGENTS[id]) throw new Error(`--agent ${id}: one of ${Object.keys(AGENTS).join(", ")}`);
      o.agents.push(id);
    } else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else if (a === "--k") o.k = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.agents.length) o.agents = Object.keys(AGENTS);
  return o;
}

const log = (...a) => console.log("[compare-capture]", ...a);
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

/** What the scripted agent writes: the right code only when the right text reached it. */
const rightCode = (task, all) => (task === "sum" ? all.includes(SUM_RULE) : !all.includes(BAD_RULE));
const taskOf = (all) => Object.keys(TASKS).find((t) => all.includes(TASKS[t].instruction));
const nextOf = (plan, step) => {
  const next = plan[step];
  return next ? { tool: typeof next === "function" ? next() : next } : { text: "Done: tests pass." };
};

/** Claude Code (Anthropic messages): Read, Write, Bash own tests, answer. */
function claudeTurn(body, all) {
  const names = toolNames(body);
  if (!names.includes("Read") || !names.includes("Write") || !names.includes("Bash")) return { text: "ok" };
  const task = taskOf(all);
  const cwd = /[Ww]orking directory: ([^\s"\\]+)/.exec(all)?.[1];
  if (!task || !cwd) return { text: "ok" };
  const file = `${cwd}/${task}.js`;
  const step = body.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_result").length : 0), 0);
  return nextOf(
    [
      { name: "Read", args: { file_path: file } },
      () => ({ name: "Write", args: { file_path: file, content: rightCode(task, all) ? TASKS[task].good : TASKS[task].bad } }),
      { name: "Bash", args: { command: "node --test own.test.js", description: "Run my tests" } },
    ],
    step,
  );
}

/** Codex (OpenAI responses, exec_command): open the sum-fix skill when listed (sum only), cat, write, test, answer. */
function codexTurn(body, all) {
  if (!toolNames(body).includes("exec_command")) return { text: "ok" };
  const task = taskOf(all);
  if (!task) return { text: "ok" };
  const step = body.input.filter((i) => i?.type === "function_call_output").length;
  const sh = (cmd) => ({ name: "exec_command", args: { cmd } });
  return nextOf(
    [
      ...(task === "sum" && all.includes("sum-fix") ? [sh("cat .agents/skills/sum-fix/SKILL.md")] : []),
      sh(`cat ${task}.js`),
      () => sh(`cat > ${task}.js <<'EOF'\n${(rightCode(task, all) ? TASKS[task].good : TASKS[task].bad).trim()}\nEOF`),
      sh("node --test own.test.js"),
    ],
    step,
  );
}

let lastBody;
function scenario(body) {
  if (toolNames(body).length) lastBody = body;
  const all = JSON.stringify(body);
  if (Array.isArray(body.input)) return codexTurn(body, all);
  if (Array.isArray(body.messages)) return claudeTurn(body, all);
  return { text: "ok" };
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-compare-"));
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
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
  OPENAI_API_KEY: "sk-stub",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  // Claude Code refuses bypassPermissions as root unless it is told it is sandboxed (the desk runs as root).
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (isWin) {
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
}
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
  const pkgs = opts.agents.map((a) => AGENTS[a].pkg);
  log(`installing ${tarball} and ${pkgs.join(", ")}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, ...pkgs], { env, cwd: root });
  if (install.code !== 0) throw new Error("npm install -g failed");
  const cs = (args, o = {}) => run("coding.sh", args, { env, cwd: root, ...o });
  const json = (r, what) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`${what}: not JSON (exit ${r.code}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
    }
  };
  log(`coding.sh ${(await cs(["--version"])).stdout.trim()}`);
  for (const a of opts.agents) log(`${a} ${(await run(AGENTS[a].bin, ["--version"], { env, cwd: root })).stdout.trim()}`);
  const init = await cs(["init", ...opts.agents.flatMap((a) => ["--agent", a]), "--yes", "--no-mcp", "--json"]);
  check(init.code === 0, `coding.sh init --agent ${opts.agents.join(" --agent ")}`, init.stderr);

  // A repo with two broken modules, the verifier tests, and the agent's own (trivial) test.
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "sum.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(repo, "mul.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(repo, "test-sum.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
  writeFileSync(join(repo, "test-mul.js"), 'if (require("./mul.js")(2, 3) !== 6) process.exit(1);\n');
  writeFileSync(join(repo, "own.test.js"), 'require("node:test")("my change loads", () => { require("./sum.js"); require("./mul.js"); });\n');
  const git = (...a) => execFileSync("git", a, { cwd: repo, env, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  // Each task: a session that fixes the module (the reference), then the repo goes back.
  const taskIds = {};
  for (const [t, spec] of Object.entries(TASKS)) {
    const fix = `require("fs").writeFileSync(${JSON.stringify(`${t}.js`)}, ${JSON.stringify(spec.good)})`;
    const r = await run("coding.sh", ["run", "--", process.execPath, "-e", fix], { env, cwd: repo });
    check(r.code === 0, `reference session for ${t}`, r.stderr);
    const created = json(await run("coding.sh", ["eval", "new", "latest", "--name", t, "--verifier", `node test-${t}.js`, "--instruction", spec.instruction, "--json"], { env, cwd: repo }), `eval new ${t}`);
    taskIds[t] = created.task?.id ?? created.id;
    git("checkout", "-q", `${t}.js`);
  }
  log(`tasks ${JSON.stringify(taskIds)}`);

  const taskArgs = Object.values(taskIds).flatMap((id) => ["-t", id]);
  const nameOf = Object.fromEntries(Object.entries(taskIds).map(([t, id]) => [id, t]));
  const gateSummary = (g) => g && { verdict: g.verdict, mode: g.mode, item: g.item, S: g.S.map((id) => nameOf[id] ?? id), f: g.f, kN: g.kN, D: g.D, reasons: g.reasons };
  for (const agent of opts.agents) {
    const A = AGENTS[agent];
    const tag = (what) => `${agent}: ${what}`;
    // Three bundles: base, base + the good item, base + the bad item.
    const bundle = (name, files) => {
      const dir = join(root, `harness-${name}`);
      for (const [p, text] of Object.entries({ ...A.base, ...files })) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), text);
      }
      writeFileSync(join(dir, "harness.toml"), `name = "${name}"\nagent = "${agent}"\nmodel = "${A.model}"\nflags = ${JSON.stringify(A.flags(stub.url))}\ninclude = ${JSON.stringify(A.include)}\n`);
      return join(dir, "harness.toml");
    };
    const [base, good, bad] = ["base", "good", "bad"].map((n) => `${agent}-${n}`);
    for (const [name, files] of [
      [base, {}],
      [good, { [A.good.path]: A.good.text }],
      [bad, { [A.bad.path]: A.bad.text }],
    ]) {
      const r = await cs(["harness", "snapshot", "--file", bundle(name, files), "--json"]);
      check(r.code === 0, tag(`harness snapshot ${name}`), r.stderr);
    }
    const compareRun = async (a, b) => {
      const r = await cs(["compare", a, b, ...taskArgs, "--k", String(opts.k), "-c", "4", "--yes", "--item-gate", "--json"]);
      const out = json(r, `compare ${a} ${b}`);
      const text = await cs(["compare", a, b, "--experiment", out.experimentId], { quiet: true });
      log(`compare ${a} ${b} (exit ${r.code}):\n${text.stdout}`);
      return { code: r.code, ...out, text: text.stdout };
    };

    // 1. The good item: KEEP, scored on sum only (it never loads on mul).
    const calls = stub.requests.length;
    const g = await compareRun(base, good);
    const runs = g.report.baseline.runs + g.report.candidate.runs;
    check(runs === 2 * 2 * opts.k, tag("base vs good: every run finished"), runs);
    check(stub.requests.length > calls, tag("the agent called the stub model"));
    const g1 = g.report.itemGate;
    log(`item gate ${JSON.stringify(gateSummary(g1))}`);
    check(g1?.mode === "add" && g1?.item?.path === A.good.path && g1?.item?.kind === A.good.kind && g1?.item?.tier === A.good.tier, tag(`base vs good: add mode, ${A.good.path}`), g1?.item);
    check(g1?.verdict === "KEEP", tag("base vs good: item gate KEEP"), gateSummary(g1));
    check(JSON.stringify(g1?.S) === JSON.stringify([taskIds.sum]), tag("base vs good: S is the sum task only"), gateSummary(g1)?.S);
    check(g1?.f?.fired === opts.k && g1?.f?.rollouts === 2 * opts.k, tag(`base vs good: fired ${opts.k}/${2 * opts.k}`), g1?.f);
    check(g.code === 0, tag("base vs good: --item-gate exits 0"), g.code);
    check(/^item gate k=\d+ τ=\.34 m=2: KEEP · /m.test(g.text), tag("base vs good: the item gate line"));
    // Own tests: base fails on sum are silent misses (own tests green).
    const sc = g.report.baseline.selfCheck;
    log(`baseline self-check ${JSON.stringify(sc)}`);
    check(sc?.fails === opts.k && sc?.green === opts.k && sc?.unknown === 0, tag(`base: ${opts.k} fails, all own tests green`), sc);
    check(g.report.candidate.selfCheck?.fails === 0, tag("good: no fails"), g.report.candidate.selfCheck);
    check(new RegExp(`A fails ${opts.k}: own tests green ${opts.k} \\(100%\\)`).test(g.text), tag("the own-tests line"));

    // 2. The bad item: KILL (it breaks mul, which base always solved).
    const b = await compareRun(base, bad);
    const g2 = b.report.itemGate;
    log(`item gate ${JSON.stringify(gateSummary(g2))}`);
    check(g2?.verdict === "KILL" && g2?.mode === "add" && g2?.item?.path === A.bad.path && g2?.item?.tier === "always", tag(`base vs bad: item gate KILL on ${A.bad.path}`), gateSummary(g2));
    check(g2?.S?.length === 2, tag("base vs bad: both tasks exposed"), gateSummary(g2)?.S);
    check(b.code === 1, tag("base vs bad: --item-gate exits 1"), b.code);

    // 3. The same runs read as a removal: dropping the good item is REJECT. No new runs.
    const before = stub.requests.length;
    const rm = json(await cs(["compare", good, base, "--experiment", g.experimentId, "--json"]), `compare ${good} ${base}`);
    check(rm.report.itemGate?.mode === "remove" && rm.report.itemGate?.verdict === "REJECT", tag("good vs base (re-analysed): removal REJECT"), gateSummary(rm.report.itemGate));
    check(stub.requests.length === before, tag("re-analysis ran no agent"));
  }
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`stub requests (${stub.requests.length}): ${JSON.stringify(stub.requests.slice(-40))}`);
    if (lastBody) writeFileSync(join(root, "last-request.json"), JSON.stringify(lastBody, null, 1));
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
