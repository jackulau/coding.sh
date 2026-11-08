#!/usr/bin/env node
// "With plugin vs without" end to end: install coding.sh from a tarball and the
// pinned Claude Code from npm under a throwaway HOME, point it at the local stub
// model, and run `coding.sh compare base --with plugin:<dir>` on one task with a
// tiny local plugin: a SessionStart hook (an executable shell script) that logs
// the session's cwd and prints a marker into the context, plus a skill.
//
// The stub writes a correct sum.js only when the hook's marker reached the
// model, so B (with the plugin) passes and A fails. Each run's work dir names
// its run id, which the store maps to its bundle: the hook must have run in
// every B run and no A run, every B request must carry the marker and list the
// plugin's skill, and no A request may. Then `--without plugin:tiny` on the
// derived bundle reverses it, and the user's Claude config dir (a fake one with
// the plugin installed) must come out byte-for-byte the same.
//
//   node scripts/e2e/plugin-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--k 2] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME. Exit 0 when every check passed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub, toolNames } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE_PKG = "@anthropic-ai/claude-code@2.1.319";
const MARKER = "TINY-PLUGIN-HOOK-MARKER: sum.js must use the + operator.";
const SKILL = "sum-plus";
const INSTRUCTION = "Make sum.js add its two arguments.";
const GOOD = "module.exports = (a, b) => a + b;\n";
const BAD = "module.exports = (a, b) => a - b;\n";

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined, k: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else if (a === "--k") o.k = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const log = (...a) => console.log("[plugin-capture]", ...a);
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

function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[relative(dir, abs)] = `${createHash("sha256").update(readFileSync(abs)).digest("hex")}:${statSync(abs).mode}`;
    }
  };
  walk(dir);
  return out;
}

/** The run id in a coding.sh run's work dir (<runs>/<runId>/work). */
const runIdOf = (path) => /[\\/](run_[A-Za-z0-9_-]+)[\\/]work\b/.exec(path ?? "")?.[1];

/** What each model request carried, by the run it came from. */
const seen = [];
function scenario(body) {
  const names = toolNames(body);
  if (!Array.isArray(body.messages) || !names.includes("Read") || !names.includes("Write")) return { text: "ok" };
  const all = JSON.stringify(body);
  if (!all.includes(INSTRUCTION)) return { text: "ok" };
  const cwd = /[Ww]orking directory: ([^\s"\\]+)/.exec(all)?.[1];
  const marker = all.includes(MARKER);
  seen.push({ run: runIdOf(cwd), marker, skill: all.includes(SKILL) });
  if (!cwd) return { text: "ok" };
  const file = `${cwd}/sum.js`;
  const step = body.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_result").length : 0), 0);
  const plan = [
    { tool: { name: "Read", args: { file_path: file } } },
    { tool: { name: "Write", args: { file_path: file, content: marker ? GOOD : BAD } } },
  ];
  return plan[step] ?? { text: "Done." };
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-plugin-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const csHome = join(home, ".coding.sh");
const claudeDir = join(home, ".claude");
const hookLog = join(root, "hook.log");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");

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
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
log(`temp root ${root}`);
log(`stub model on ${stub.url}`);

/** The tiny plugin: an executable SessionStart hook that logs its cwd and prints the marker, plus a skill. */
function writePlugin(dir) {
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "tiny", version: "0.1.0", description: "coding.sh e2e plugin" }),
    "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/start.sh"' }] }] } }),
    "hooks/start.sh": `#!/bin/sh\ninput=$(cat)\nprintf '%s\\t%s\\n' "$CLAUDE_PLUGIN_ROOT" "$input" | tr -d '\\r' >> ${JSON.stringify(hookLog)}\necho ${JSON.stringify(MARKER)}\n`,
    [`skills/${SKILL}/SKILL.md`]: `---\nname: ${SKILL}\ndescription: Use when changing sum.js.\n---\nUse the + operator.\n`,
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  chmodSync(join(dir, "hooks/start.sh"), 0o755);
}

/** Hook log lines: the plugin root and the session's cwd. */
const hookRuns = () =>
  existsSync(hookLog)
    ? readFileSync(hookLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [pluginRoot, input] = l.split("\t");
          let cwd;
          try {
            cwd = JSON.parse(input).cwd;
          } catch {}
          return { pluginRoot, cwd, run: runIdOf(cwd) };
        })
    : [];

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
  log(`installing ${tarball} and ${CLAUDE_PKG}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, CLAUDE_PKG], { env, cwd: root });
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
  log(`claude ${(await run("claude", ["--version"], { env, cwd: root })).stdout.trim()}`);
  const init = await cs(["init", "--agent", "claude-code", "--yes", "--no-mcp", "--json"]);
  check(init.code === 0, "coding.sh init --agent claude-code", init.stderr);

  // The user's Claude config: the plugin installed and enabled, as Claude Code would leave it.
  const installed = join(claudeDir, "plugins", "cache", "e2e", "tiny", "0.1.0");
  writePlugin(installed);
  writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tiny@e2e": [{ scope: "user", installPath: installed, version: "0.1.0" }] } }));
  const settingsFile = join(claudeDir, "settings.json");
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  writeFileSync(settingsFile, JSON.stringify({ ...settings, enabledPlugins: { "tiny@e2e": true } }, null, 2));
  const configBefore = fingerprint(claudeDir);
  // The same plugin in a plain dir, for plugin:<dir>.
  const pluginDir = join(root, "tiny-plugin");
  writePlugin(pluginDir);

  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "sum.js"), BAD);
  writeFileSync(join(repo, "test-sum.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
  const git = (...a) => execFileSync("git", a, { cwd: repo, env, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const fix = `require("fs").writeFileSync("sum.js", ${JSON.stringify(GOOD)})`;
  check((await run("coding.sh", ["run", "--", process.execPath, "-e", fix], { env, cwd: repo })).code === 0, "reference session");
  const created = json(await run("coding.sh", ["eval", "new", "latest", "--name", "sum", "--verifier", "node test-sum.js", "--instruction", INSTRUCTION, "--json"], { env, cwd: repo }), "eval new");
  const taskId = created.task?.id ?? created.id;
  git("checkout", "-q", "sum.js");

  const h = join(root, "harness-base");
  mkdirSync(h);
  writeFileSync(join(h, "CLAUDE.md"), "Keep changes small.\n");
  writeFileSync(join(h, "harness.toml"), `name = "base"\nagent = "claude-code"\nmodel = "claude-sonnet-4-5"\ninclude = ["CLAUDE.md"]\n`);
  check((await cs(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"])).code === 0, "harness snapshot base");

  /** Run id → bundle name, from the store. */
  const armsOf = async (experimentId) => {
    const q = await cs(["sql", `select r.id as id, b.name as bundle from runs r join bundles b on b.id = r.bundle_id where r.experiment_id = '${experimentId}'`, "--json"]);
    const rows = json(q, "sql runs").rows ?? json(q, "sql runs");
    return new Map(rows.map((r) => [r.id, r.bundle]));
  };

  /** One comparison: B's runs ran the plugin, A's did not, judged from the hook log, the model requests and the store. */
  const verify = async (label, args, withArm, withoutArm) => {
    const hooksBefore = hookRuns().length;
    const seenBefore = seen.length;
    const r = await cs(["compare", ...args, "-t", taskId, "--k", String(opts.k), "-c", "2", "--yes", "--json"]);
    const out = json(r, `compare ${args.join(" ")}`);
    const text = await cs(["compare", ...args, "--experiment", out.experimentId], { quiet: true });
    log(`${label} (exit ${r.code}):\n${text.stdout}`);
    const { baseline, candidate } = out.report;
    const arm = (name) => (baseline.name === name ? baseline : candidate);
    check(arm(withArm).passes === opts.k && arm(withoutArm).passes === 0, `${label}: ${withArm} passes ${opts.k}/${opts.k}, ${withoutArm} 0/${opts.k}`, { baseline, candidate });
    const arms = await armsOf(out.experimentId);
    check(arms.size === 2 * opts.k, `${label}: ${2 * opts.k} runs stored`, [...arms]);
    const hooks = hookRuns().slice(hooksBefore);
    log(`hook runs ${JSON.stringify(hooks.map((x) => ({ run: x.run, arm: arms.get(x.run), pluginRoot: x.pluginRoot })))}`);
    check(hooks.length === opts.k && hooks.every((x) => arms.get(x.run) === withArm), `${label}: the plugin's SessionStart hook ran in every ${withArm} run and no ${withoutArm} run`, hooks);
    check(
      hooks.every((x) => x.pluginRoot && /[\\/]home[\\/]\.coding\.sh-plugins[\\/]tiny$/.test(x.pluginRoot) && !x.pluginRoot.startsWith(claudeDir) && !x.pluginRoot.includes(`${x.run}/work`)),
      `${label}: the plugin loaded from the run's own home, not the work dir or the user's config`,
      hooks.map((x) => x.pluginRoot),
    );
    const reqs = seen.slice(seenBefore).filter((s) => s.run && arms.has(s.run));
    const inArm = (name) => reqs.filter((s) => arms.get(s.run) === name);
    log(`requests ${withArm}: ${inArm(withArm).length} (marker ${inArm(withArm).filter((s) => s.marker).length}, skill ${inArm(withArm).filter((s) => s.skill).length}); ${withoutArm}: ${inArm(withoutArm).length} (marker ${inArm(withoutArm).filter((s) => s.marker).length}, skill ${inArm(withoutArm).filter((s) => s.skill).length})`);
    check(inArm(withArm).length > 0 && inArm(withArm).every((s) => s.marker && s.skill), `${label}: every ${withArm} model request carries the hook's context and lists the plugin's skill`);
    check(inArm(withoutArm).length > 0 && inArm(withoutArm).every((s) => !s.marker && !s.skill), `${label}: no ${withoutArm} model request has either`);
    return { out, text: text.stdout };
  };

  const w = await verify("base vs --with plugin:<dir>", ["base", "--with", `plugin:${pluginDir}`], "base-with-plugin-tiny", "base");
  check(/^ {2}\+ plugin tiny$/m.test(w.text), "the bundle diff reads + plugin tiny");
  const wo = await verify("--without plugin:tiny", ["base-with-plugin-tiny", "--without", "plugin:tiny"], "base-with-plugin-tiny", "base-with-plugin-tiny-without-plugin-tiny");
  check(/^ {2}- plugin tiny$/m.test(wo.text), "the bundle diff reads - plugin tiny");

  // By name, from the (fake) user's installed plugins: the same derived bundle content, read-only.
  const byName = json(await cs(["compare", "base", "--with", "plugin:tiny", "-t", taskId, "--dry-run", "--json"]), "compare --with plugin:tiny --dry-run");
  check(byName.candidate?.name === "base-with-plugin-tiny", "--with plugin:tiny resolves the installed plugin", byName);
  const list = json(await cs(["harness", "list", "--json"]), "harness list");
  const derived = list.bundles.find((b) => b.name === "base-with-plugin-tiny");
  check(derived?.plugins?.[0]?.name === "tiny", "harness list shows the derived bundle's plugin", derived);
  check(JSON.stringify(fingerprint(claudeDir)) === JSON.stringify(configBefore), "the user's Claude config dir is byte-for-byte untouched");
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`requests seen: ${JSON.stringify(seen.slice(-20))}`);
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
