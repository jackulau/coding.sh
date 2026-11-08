#!/usr/bin/env node
// Repair rounds, end to end with real agents: install coding.sh from a tarball
// and the real Claude Code and Codex CLIs from npm under a throwaway HOME, point
// them at a local stub model, and run `coding.sh compare --repair 2
// --repair-signal names` on two tasks whose verifier tests are hidden.
//
// The stub plays a scripted agent. First attempt: read the module, write it.
// On "sum" it writes the wrong code unless SUM_RULE is in its context (the
// "rule" bundle); on "mul" it always writes the wrong code. After "Verification
// failed." (in the same session: Claude Code --resume, codex exec resume) it
// lists the work tree, then fixes sum, and on mul only answers, changing nothing.
// Expected per agent, with --k 2:
//   base: sum fails, then passes in round 1; mul never passes; its rounds change nothing.
//         Seq@1..3 = 0, 50%, 50%; EGS 1, LGS 0.
//   rule: sum passes first; mul as base. Seq@1..3 = 50%, 50%, 50%.
// The repair message names the failing node:test test, the resumed request carries
// the first attempt, and no listing in a repair round shows a hidden test file.
//
//   node scripts/e2e/repair-capture.mjs [--agent claude-code|codex]... [--tarball coding.sh-x.y.z.tgz] [--keep]
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
const K = 2;
const ROUNDS = 2;
const FAILED = "Verification failed.";
const TASKS = {
  sum: { instruction: "Make sum.js add its two arguments.", test: "sum adds", good: "module.exports = (a, b) => a + b;\n", bad: "module.exports = (a, b) => a - b;\n", call: "(2, 3)", want: 5 },
  mul: { instruction: "Make mul.js multiply its two arguments.", test: "mul multiplies", good: "module.exports = (a, b) => a * b;\n", bad: "module.exports = (a, b) => a + b;\n", call: "(2, 3)", want: 6 },
};
const SUM_RULE = "SUM-RULE: sum.js must use the + operator.";
const MUL_SAY = "mul.js looks right to me; I left it as it is.";

const AGENTS = {
  "claude-code": {
    pkg: "@anthropic-ai/claude-code@2.1.319",
    bin: "claude",
    model: "claude-sonnet-4-5",
    flags: () => [],
    include: ["CLAUDE.md", ".claude/**"],
    base: { "CLAUDE.md": "Keep changes small.\n" },
    rule: { "CLAUDE.md": `Keep changes small.\n${SUM_RULE}\n` },
  },
  codex: {
    pkg: "@openai/codex@0.167.0",
    bin: "codex",
    model: "gpt-5",
    // A custom provider: Codex ignores OPENAI_BASE_URL. The same flags in every arm.
    flags: (url) => ["-c", "model_provider=stub", "-c", `model_providers.stub={name="stub",base_url="${url}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`],
    include: ["AGENTS.md", ".agents/**"],
    base: { ".agents/skills/notes/SKILL.md": "---\nname: notes\ndescription: Use when writing release notes.\n---\nKeep notes short.\n" },
    rule: { "AGENTS.md": `${SUM_RULE}\n` },
  },
};

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined, agents: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--agent") {
      const id = argv[++i];
      if (!AGENTS[id]) throw new Error(`--agent ${id}: one of ${Object.keys(AGENTS).join(", ")}`);
      o.agents.push(id);
    } else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.agents.length) o.agents = Object.keys(AGENTS);
  return o;
}

const log = (...a) => console.log("[repair-capture]", ...a);
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

const taskOf = (all) => Object.keys(TASKS).find((t) => all.includes(TASKS[t].instruction));
const lastIndex = (xs, f) => {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i])) return i;
  return -1;
};
const nextOf = (plan, step) => {
  const next = plan[step];
  if (next === undefined) return { text: "Done." };
  if (typeof next === "string") return { text: next };
  return { tool: typeof next === "function" ? next() : next };
};

/**
 * Every request after a "Verification failed." message, per agent: whether the
 * earlier attempt came with it (a resumed session), what the message said, and the
 * tool output the agent saw in the repair round.
 */
const repairs = { "claude-code": [], codex: [] };

/** Claude Code (Anthropic messages): Read, Write; after the failure, Bash ls, then fix sum or only answer on mul. */
function claudeTurn(body, all) {
  const names = toolNames(body);
  if (!names.includes("Read") || !names.includes("Write") || !names.includes("Bash")) return { text: "ok" };
  const task = taskOf(all);
  const cwd = /[Ww]orking directory: ([^\s"\\]+)/.exec(all)?.[1];
  if (!task || !cwd) return { text: "ok" };
  const msgs = body.messages;
  const at = lastIndex(msgs, (m) => m.role === "user" && JSON.stringify(m.content).includes(FAILED));
  const after = at < 0 ? msgs : msgs.slice(at + 1);
  const results = after.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_result") : []));
  const file = `${cwd}/${task}.js`;
  if (at < 0) {
    return nextOf([{ name: "Read", args: { file_path: file } }, () => ({ name: "Write", args: { file_path: file, content: task === "sum" && all.includes(SUM_RULE) ? TASKS.sum.good : TASKS[task].bad } })], results.length);
  }
  repairs["claude-code"].push({ task, earlier: msgs.slice(0, at).some((m) => JSON.stringify(m.content).includes('"tool_use"')), message: JSON.stringify(msgs[at].content), seen: JSON.stringify(results) });
  const ls = { name: "Bash", args: { command: "ls -a", description: "List files" } };
  return nextOf(task === "sum" ? [ls, { name: "Write", args: { file_path: file, content: TASKS.sum.good } }] : [ls, MUL_SAY], results.length);
}

/** Codex (OpenAI responses, exec_command): cat, write; after the failure, ls, then fix sum or only answer on mul. */
function codexTurn(body, all) {
  if (!toolNames(body).includes("exec_command")) return { text: "ok" };
  const task = taskOf(all);
  if (!task) return { text: "ok" };
  const input = body.input;
  const at = lastIndex(input, (i) => i?.type === "message" && i.role === "user" && JSON.stringify(i.content).includes(FAILED));
  const after = at < 0 ? input : input.slice(at + 1);
  const results = after.filter((i) => i?.type === "function_call_output");
  const sh = (cmd) => ({ name: "exec_command", args: { cmd } });
  const write = (code) => sh(`cat > ${task}.js <<'EOF'\n${code.trim()}\nEOF`);
  if (at < 0) return nextOf([sh(`cat ${task}.js`), () => write(task === "sum" && all.includes(SUM_RULE) ? TASKS.sum.good : TASKS[task].bad)], results.length);
  repairs.codex.push({ task, earlier: input.slice(0, at).some((i) => i?.type === "function_call"), message: JSON.stringify(input[at].content), seen: JSON.stringify(results) });
  return nextOf(task === "sum" ? [sh("ls -a"), write(TASKS.sum.good)] : [sh("ls -a"), MUL_SAY], results.length);
}

function scenario(body) {
  const all = JSON.stringify(body);
  if (Array.isArray(body.input)) return codexTurn(body, all);
  if (Array.isArray(body.messages)) return claudeTurn(body, all);
  return { text: "ok" };
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const isWin = process.platform === "win32";
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-repair-"));
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

  // A repo with two broken modules. Each reference session fixes one and adds its node:test
  // verifier test, which `eval new --hidden-test` moves into the task's hidden files.
  const repo = join(root, "repo");
  mkdirSync(repo);
  for (const [t, spec] of Object.entries(TASKS)) writeFileSync(join(repo, `${t}.js`), spec.bad);
  const git = (...a) => execFileSync("git", a, { cwd: repo, env, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const taskIds = {};
  for (const [t, spec] of Object.entries(TASKS)) {
    const test = `const test = require("node:test");\nconst assert = require("node:assert");\ntest(${JSON.stringify(spec.test)}, () => assert.strictEqual(require("./${t}.js")${spec.call}, ${spec.want}));\n`;
    const fix = `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(`${t}.js`)}, ${JSON.stringify(spec.good)}); fs.writeFileSync(${JSON.stringify(`test-${t}.js`)}, ${JSON.stringify(test)})`;
    const r = await run("coding.sh", ["run", "--", process.execPath, "-e", fix], { env, cwd: repo });
    check(r.code === 0, `reference session for ${t}`, r.stderr);
    const created = json(await run("coding.sh", ["eval", "new", "latest", "--name", t, "--verifier", `node test-${t}.js`, "--hidden-test", `test-${t}.js`, "--instruction", spec.instruction, "--json"], { env, cwd: repo }), `eval new ${t}`);
    taskIds[t] = created.task?.id ?? created.id;
    check(Object.keys(created.task?.verifier?.hiddenFiles ?? created.verifier?.hiddenFiles ?? {}).includes(`test-${t}.js`), `${t}: test-${t}.js is a hidden verifier file`, created);
    git("checkout", "-q", `${t}.js`);
    rmSync(join(repo, `test-${t}.js`));
  }
  log(`tasks ${JSON.stringify(taskIds)}`);
  const taskArgs = Object.values(taskIds).flatMap((id) => ["-t", id]);

  for (const agent of opts.agents) {
    const A = AGENTS[agent];
    const tag = (what) => `${agent}: ${what}`;
    const bundle = (name, files) => {
      const dir = join(root, `harness-${name}`);
      for (const [p, text] of Object.entries({ ...A.base, ...files })) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), text);
      }
      writeFileSync(join(dir, "harness.toml"), `name = "${name}"\nagent = "${agent}"\nmodel = "${A.model}"\nflags = ${JSON.stringify(A.flags(stub.url))}\ninclude = ${JSON.stringify(A.include)}\n`);
      return join(dir, "harness.toml");
    };
    const [base, rule] = [`${agent}-base`, `${agent}-rule`];
    for (const [name, files] of [
      [base, {}],
      [rule, A.rule],
    ]) {
      const r = await cs(["harness", "snapshot", "--file", bundle(name, files), "--json"]);
      check(r.code === 0, tag(`harness snapshot ${name}`), r.stderr);
    }

    const r = await cs(["compare", base, rule, ...taskArgs, "--k", String(K), "--repair", String(ROUNDS), "--repair-signal", "names", "-c", "4", "--yes", "--json"]);
    const out = json(r, `compare ${base} ${rule} --repair`);
    const text = (await cs(["compare", base, rule, "--experiment", out.experimentId], { quiet: true })).stdout;
    log(`compare ${base} ${rule} --repair ${ROUNDS} (exit ${r.code}):\n${text}`);
    const [a, b] = [out.report.baseline, out.report.candidate];
    check(a.runs === 2 * K && b.runs === 2 * K && a.errors === 0 && b.errors === 0, tag(`every run finished (${2 * K} per arm)`), { a: [a.runs, a.errors], b: [b.runs, b.errors] });
    check(a.passes === 0 && b.passes === K, tag(`first attempts: base 0, rule ${K} (sum)`), [a.passes, b.passes]);

    // The repair summary: base repairs sum in round 1, never mul; rule has only mul to repair.
    const ra = a.repair;
    const rb = b.repair;
    log(`repair A ${JSON.stringify(ra)}`);
    log(`repair B ${JSON.stringify(rb)}`);
    check(ra?.mode === "resume" && ra?.signal === "names" && ra?.limit === ROUNDS, tag("resumed the agent's own session, names signal"), ra && { mode: ra.mode, signal: ra.signal, limit: ra.limit });
    check(ra?.firstFails === 2 * K && ra?.repaired === K && ra?.meanRounds === 1, tag(`base: ${2 * K} first fails, ${K} repaired in 1 round`), ra);
    check(ra?.rounds === K + K * ROUNDS && rb?.rounds === K * ROUNDS, tag("rounds: stop at the first pass, never more than --repair"), [ra?.rounds, rb?.rounds]);
    check(rb?.firstFails === K && rb?.repaired === 0, tag("rule: mul never repaired"), rb);
    check(ra?.namesUnparsed === 0, tag("every failing test name was read from the verifier output"), ra?.namesUnparsed);

    // Seq@K: base 0 → 50% after one round; rule 50% throughout.
    const sa = a.seq;
    const sb = b.seq;
    const rates = (s) => s?.curve?.map((p) => Math.round(p.rate * 1000) / 1000);
    log(`seq A ${JSON.stringify(sa)}`);
    check(JSON.stringify(rates(sa)) === JSON.stringify([0, 0.5, 0.5]), tag("base Seq@1..3 = 0, 50%, 50%"), rates(sa));
    check(JSON.stringify(rates(sb)) === JSON.stringify([0.5, 0.5, 0.5]), tag("rule Seq@1..3 = 50%, 50%, 50%"), rates(sb));
    check(sa?.egs === 1 && sa?.lgs === 0 && sb?.egs === undefined, tag("gain shares: base EGS 1, LGS 0; rule none"), { a: [sa?.egs, sa?.lgs], b: [sb?.egs, sb?.lgs] });
    check(sa?.unchanged === K * ROUNDS && sb?.unchanged === K * ROUNDS, tag("mul's rounds changed nothing"), [sa?.unchanged, sb?.unchanged]);
    check(JSON.stringify(sa?.passAtK?.map((p) => p.rate)) === JSON.stringify([0, 0]), tag("base pass@1..2 = 0"), sa?.passAtK);
    check(out.report.seqRanking?.k === ROUNDS + 1 && out.report.seqRanking?.flipped?.length === 0, tag("seqRanking: no flip"), out.report.seqRanking);
    check(/^with verifier feedback \(names, up to 2 rounds, resume\)$/m.test(text), tag("the report's repair block"));
    check(/^seq@1 \(first\) +0\.0% .* 50\.0% /m.test(text) && /^seq@2 +50\.0% .* 50\.0% /m.test(text), tag("the Seq@k rows"));
    check(/^unchanged +4\/6 \(67%\) +4\/4 \(100%\)/m.test(text), tag("the unchanged row"));

    // What the agent saw: its own session, the failing test's name, and no hidden test file.
    const seen = repairs[agent];
    check(seen.length > 0, tag("repair rounds reached the model"), seen.length);
    check(
      seen.every((s) => s.earlier),
      tag("each repair request carries the first attempt (resumed session)"),
      seen.map((s) => s.earlier),
    );
    check(seen.some((s) => s.message.includes(`${FAILED} Failing tests: ${TASKS.sum.test}`)) && seen.some((s) => s.message.includes(`${FAILED} Failing tests: ${TASKS.mul.test}`)), tag("the message names the failing test"), seen.map((s) => s.message.slice(0, 200)));
    check(
      seen.every((s) => !s.message.includes("assert") && !s.message.includes(TASKS.sum.instruction)),
      tag("the message carries neither the verifier's output nor the instruction again"),
      seen.map((s) => s.message.slice(0, 300)),
    );
    // The tool output is JSON-escaped: each listing line follows a backslash-n.
    const listed = seen.filter((s) => /(^|\\n|\/)(sum|mul)\.js/.test(s.seen));
    check(listed.length > 0 && listed.every((s) => !s.seen.includes("test-sum.js") && !s.seen.includes("test-mul.js")), tag("ls in a repair round shows the module, never a hidden test"), (listed.length ? listed : seen).map((s) => s.seen.slice(0, 600)));
  }
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
