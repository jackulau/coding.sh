#!/usr/bin/env node
// Skill trigger eval, end to end with real agents: install coding.sh from a
// tarball and the real Claude Code and Codex CLIs from npm under a throwaway
// HOME, point them at a local stub model, and run `coding.sh eval trigger` on a
// `pdf` skill with a `docx` sibling.
//
// The stub plays a router: it reads the skill list the agent put in its context
// ("<name>: Use when the user mentions a, b."), and when a listed word is in the
// prompt it loads that skill: Claude Code calls the Skill tool, Codex opens the
// skill's SKILL.md with cat. Otherwise it answers. So whether a probe triggers
// depends only on the description the agent was given, and every count is known:
//   current description ("mentions pdf"):        TP 2 FN 2 FP 1 TN 3 per run of each prompt
//   candidate ("mentions pdf, invoice, scanned"): TP 4 FN 0 FP 1 TN 3
// The docx prompt routes to the sibling (expect_skill), not a false trigger.
// Every probe must be read from its captured session (hooks), not stdout.
//
//   node scripts/e2e/trigger-capture.mjs [--agent claude-code|codex]... [--tarball coding.sh-x.y.z.tgz] [--k 2] [--keep]
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

const SHOULD = ["Fill in the pdf form", "Merge these pdf pages", "Make the invoice searchable", "OCR this scanned invoice"];
const SHOULD_NOT = ["Rename every txt file", "Write a docx memo", "Explain in one line what a pdf is", "Sort this list"];
const PROMPTS = [...SHOULD, ...SHOULD_NOT];
const SKILLS = { pdf: "pdf", docx: "docx, word" };
const CANDIDATE = "Use when the user mentions pdf, invoice, scanned.";

const AGENTS = {
  "claude-code": {
    pkg: "@anthropic-ai/claude-code@2.1.319",
    bin: "claude",
    model: "claude-sonnet-4-5",
    flags: () => [],
    skillsDir: ".claude/skills",
  },
  codex: {
    pkg: "@openai/codex@0.167.0",
    bin: "codex",
    model: "gpt-5",
    // A custom provider: Codex ignores OPENAI_BASE_URL.
    flags: (url) => ["-c", "model_provider=stub", "-c", `model_providers.stub={name="stub",base_url="${url}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`],
    skillsDir: ".agents/skills",
  },
};

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined, k: 2, agents: [] };
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

const log = (...a) => console.log("[trigger-capture]", ...a);
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

/** The skills the agent listed for the model, as name → trigger words (nearest known name before each description). */
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

/** The skill the router loads for this request, if any: the first listed skill naming a word of the prompt. */
function route(all) {
  const prompt = PROMPTS.find((p) => all.includes(p));
  if (!prompt) return undefined;
  const lower = prompt.toLowerCase();
  return Object.entries(listedSkills(all)).find(([, words]) => words.some((w) => lower.includes(w)))?.[0];
}

let lastBody;
const routed = [];
function scenario(body) {
  if (toolNames(body).length) lastBody = body;
  const all = JSON.stringify(body);
  const names = toolNames(body);
  if (Array.isArray(body.input)) {
    // Codex: open the skill's SKILL.md once, then answer.
    if (!names.includes("exec_command") || body.input.some((i) => i?.type === "function_call_output")) return { text: "done" };
    const skill = route(all);
    routed.push({ agent: "codex", skill });
    return skill ? { tool: { name: "exec_command", args: { cmd: `cat ${AGENTS.codex.skillsDir}/${skill}/SKILL.md` } } } : { text: "done" };
  }
  if (Array.isArray(body.messages)) {
    if (!names.includes("Skill")) return { text: "done" };
    if (body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"))) return { text: "done" };
    const skill = route(all);
    routed.push({ agent: "claude-code", skill });
    return skill ? { tool: { name: "Skill", args: { skill } } } : { text: "done" };
  }
  return { text: "done" };
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-trigger-"));
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

  // The skill under test, its sibling, and the spec.
  const skills = join(root, "skills");
  for (const [name, words] of Object.entries(SKILLS)) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: Use when the user mentions ${words}.\n---\nSay which ${name} tool you would use.\n`);
  }
  const toml = (s) => JSON.stringify(s);
  writeFileSync(
    join(skills, "pdf", "triggers.toml"),
    `k = ${opts.k}\ntimeout_s = 300\n${SHOULD.map((p) => `\n[[should]]\nprompt = ${toml(p)}\n`).join("")}${SHOULD_NOT.map((p) => `\n[[should_not]]\nprompt = ${toml(p)}\n${p.includes("docx") ? 'expect_skill = "docx"\n' : ""}`).join("")}`,
  );

  const k = opts.k;
  for (const agent of opts.agents) {
    const A = AGENTS[agent];
    const tag = (what) => `${agent}: ${what}`;
    const hdir = join(root, `harness-${agent}`);
    mkdirSync(hdir, { recursive: true });
    writeFileSync(join(hdir, "harness.toml"), `name = "${agent}-base"\nagent = "${agent}"\nmodel = "${A.model}"\nflags = ${JSON.stringify(A.flags(stub.url))}\ninclude = []\n`);
    const snap = await cs(["harness", "snapshot", "--file", join(hdir, "harness.toml"), "--json"]);
    check(snap.code === 0, tag("harness snapshot"), snap.stderr);

    // 1. One arm: exact counts, the sibling route, every probe read from its captured session.
    const calls = stub.requests.length;
    const one = await cs(["eval", "trigger", "skills/pdf", "--harness", `${agent}-base`, "--yes", "--json"]);
    const o1 = json(one, tag("eval trigger"));
    const a = o1.report.arms[0];
    log(`${agent} one arm: ${JSON.stringify({ raw: a.raw, metrics: a.metrics, errors: a.errors, errorReasons: a.errorReasons })}`);
    check(one.code === 0, tag("eval trigger exits 0"), one.stderr);
    check(stub.requests.length > calls, tag("the agent called the stub model"));
    check(a.errors === 0, tag("no errored probe"), a.errorReasons);
    check(JSON.stringify(a.raw) === JSON.stringify({ tp: 2 * k, fp: k, tn: 3 * k, fn: 2 * k }), tag(`TP ${2 * k} FP ${k} TN ${3 * k} FN ${2 * k}`), a.raw);
    check(a.metrics.precision === 2 / 3 && a.metrics.recall === 0.5, tag("precision 2/3, recall 1/2"), a.metrics);
    const docx = a.prompts.find((p) => p.expectSkill === "docx");
    check(docx?.expectHits === k && docx?.triggered === 0, tag(`the docx prompt routes to the sibling ${k}/${k}`), docx);
    const fromSession = o1.report.observations.filter((x) => x.sessionId);
    check(fromSession.length === o1.report.observations.length, tag("every probe read from a captured session"), `${fromSession.length}/${o1.report.observations.length}`);
    check(existsSync(o1.file), tag("result file written"), o1.file);

    // 2. A/B: a description that also names invoices and scans. Recall rises, both invoice prompts flip.
    const ab = await cs(["eval", "trigger", "skills/pdf", "--harness", `${agent}-base`, "--description", CANDIDATE, "--fail-on", "regression", "--yes", "--json"]);
    const o2 = json(ab, tag("eval trigger --description"));
    const [x, y] = o2.report.arms;
    log(`${agent} A/B: ${o2.report.delta?.verdict}`);
    check(ab.code === 0, tag("--fail-on regression exits 0 on an improvement"), ab.stderr);
    check(x.raw.tp === 2 * k && y.raw.tp === 4 * k && y.raw.fp === k, tag(`recall ${2 * k}/${4 * k} → ${4 * k}/${4 * k}, false triggers unchanged`), [x.raw, y.raw]);
    const flips = o2.report.delta?.flips ?? [];
    check(flips.length === 2 && flips.every((f) => f.better && /invoice/.test(f.prompt)), tag("the two invoice prompts flip to loaded"), flips);
    // 2 of 8 prompts flip: the bootstrap CI reaches down to 0, so 8 prompts can't call it; it is not a regression.
    check(o2.report.delta?.regression === false && o2.report.delta?.ci?.lo >= 0 && o2.report.delta?.ci?.mean === 0.25, tag("Δ accuracy +25 pp, CI not below 0"), o2.report.delta?.ci);
    const text = await cs(["eval", "trigger", "skills/pdf", "--harness", `${agent}-base`, "--description", CANDIDATE, "--yes"], { quiet: true });
    log(`${agent} A/B text:\n${text.stdout}`);
    check(/^B vs A over 8 prompts: recall /m.test(text.stdout), tag("the verdict line"));

    // 3. --min-f1 sets the exit code (F1 0.57 for the current description).
    const low = await cs(["eval", "trigger", "skills/pdf", "--harness", `${agent}-base`, "--min-f1", "0.9", "-k", "1", "--yes"], { quiet: true });
    check(low.code === 1 && /under --min-f1 0\.9/.test(low.stderr), tag("--min-f1 0.9 exits 1"), low.stderr.slice(-500));
  }
  log(`routing decisions: ${JSON.stringify(routed.reduce((m, r) => ((m[`${r.agent}:${r.skill ?? "-"}`] = (m[`${r.agent}:${r.skill ?? "-"}`] ?? 0) + 1), m), {}))}`);
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
