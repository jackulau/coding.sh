#!/usr/bin/env node
// Real capture, end to end: install coding.sh from a tarball and real agent CLIs
// from npm under a throwaway HOME, run `coding.sh init`, drive one non-interactive
// session per agent against a local stub model (one tool call that writes
// hello.txt, then text), and check what coding.sh recorded. Then `ingest
// --backfill` twice must add no duplicate rows.
//
//   node scripts/e2e/real-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--agents opencode,pi] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME: every path is under a temp dir.
// Exit codes: 0 all checks passed, 1 a check failed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { MODEL, TEXT, startStub } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROMPT = "create hello.txt";
const isWin = process.platform === "win32";

// Pinned: the releases verified on a real install (docs/guides/agents.md).
const AGENTS = {
  opencode: {
    pkg: "opencode-ai@1.19.5",
    bin: "opencode",
    configure(home, stub) {
      const dir = join(home, ".config", "opencode");
      mkdirSync(dir, { recursive: true });
      const config = {
        $schema: "https://opencode.ai/config.json",
        model: `stub/${MODEL}`,
        autoupdate: false,
        provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: `${stub}/v1`, apiKey: "stub" }, models: { [MODEL]: { name: "Stub" } } } },
      };
      writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2));
    },
    args: ["run", "--format", "json", "--model", `stub/${MODEL}`, PROMPT],
  },
  pi: {
    pkg: "@earendil-works/pi-coding-agent@1.5.0",
    bin: "pi",
    configure(home, stub) {
      const dir = join(home, ".pi", "agent");
      mkdirSync(dir, { recursive: true });
      const model = { id: MODEL, name: "Stub", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: `${stub}/v1`, api: "openai-completions", apiKey: "stub", models: [model] } } }, null, 2));
    },
    args: ["-p", "--provider", "stub", "--model", MODEL, PROMPT],
  },
};

// ------------------------------------------------------------------ helpers

function parseArgs(argv) {
  const o = { agents: Object.keys(AGENTS), keep: false, tarball: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else if (a === "--agents") o.agents = argv[++i].split(",").filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  for (const a of o.agents) if (!AGENTS[a]) throw new Error(`unknown agent ${a} (have ${Object.keys(AGENTS).join(", ")})`);
  return o;
}

const log = (...a) => console.log("[real-capture]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

/** Runs `file args` through coding.sh's portable spawn (so `.cmd` shims work on Windows); resolves with its output. */
function run(file, args, { cwd, env, timeoutMs = 300_000, quiet = false } = {}) {
  return new Promise((resolveRun) => {
    // PWD as a shell would set it: some agents (OpenCode) take their directory from it.
    const childEnv = cwd && env ? { ...env, PWD: cwd } : env;
    const child = spawn(file, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\n[real-capture] timed out after ${timeoutMs} ms`;
      child.kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!quiet && code !== 0) log(`${file} ${args.join(" ")} exited ${code}\n--- stdout\n${stdout.slice(-4000)}\n--- stderr\n${stderr.slice(-4000)}`);
      resolveRun({ code, stdout, stderr });
    });
  });
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: not JSON:\n${text.slice(0, 2000)}`);
  }
}

function listTree(dir, depth = 4, prefix = "") {
  if (!existsSync(dir) || depth < 0) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "blobs") continue;
    const p = join(dir, name);
    const st = statSync(p);
    out.push(`${prefix}${name}${st.isDirectory() ? "/" : ` (${st.size})`}`);
    if (st.isDirectory()) out.push(...listTree(p, depth - 1, prefix + "  "));
  }
  return out;
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-real-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const csHome = join(home, ".coding.sh");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
// Snapshots and test repos commit; the CI's global git identity lives in the real HOME.
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
const binDir = isWin ? prefix : join(prefix, "bin");

// A clean environment: nothing from the real HOME or agent configs leaks in.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(XDG_|OPENCODE|PI_|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) continue;
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
  NO_UPDATE_NOTIFIER: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  PI_SKIP_VERSION_CHECK: "1",
});
if (isWin) {
  // Agents that follow Windows conventions keep state under these: keep it in the temp home too.
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
}
// The real npm cache keeps reinstalls fast and lives outside any agent config.
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;

const stub = await startStub();
log(`temp root ${root}`);
log(`stub model on ${stub.url}`);

let exitCode = 0;
try {
  // 1. coding.sh from the tarball, the agents from npm (pinned).
  let tarball = opts.tarball;
  if (!tarball) {
    const pkgDir = join(REPO, "packages", "coding.sh");
    if (!existsSync(join(pkgDir, "dist", "cli.mjs"))) throw new Error("packages/coding.sh/dist is missing: run npm run build first, or pass --tarball");
    const packed = await run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: pkgDir });
    if (packed.code !== 0) throw new Error("npm pack failed");
    tarball = join(root, packed.stdout.trim().split(/\r?\n/).pop());
  }
  log(`installing ${tarball} and ${opts.agents.map((a) => AGENTS[a].pkg).join(", ")}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, ...opts.agents.map((a) => AGENTS[a].pkg)], { env, cwd: root, timeoutMs: 600_000 });
  if (install.code !== 0) throw new Error("npm install -g failed");
  const cs = (args, o = {}) => run("coding.sh", args, { env, cwd: root, ...o });
  const csJson = async (args, what = args.join(" ")) => {
    const r = await cs([...args, "--json"]);
    if (r.code !== 0) throw new Error(`coding.sh ${what} failed`);
    return parseJson(r.stdout, `coding.sh ${what}`);
  };
  log(`coding.sh ${(await cs(["--version"])).stdout.trim()}`);

  // 2. Point each agent at the stub, then init.
  for (const a of opts.agents) AGENTS[a].configure(home, stub.url);
  const init = await csJson(["init", ...opts.agents.flatMap((a) => ["--agent", a]), "--yes"], "init");
  for (const a of opts.agents) {
    const got = init.agents?.find((x) => x.id === a);
    check(got && !got.error, `init set up ${a}`, got ?? init);
  }
  const doctor = await cs(["doctor", ...opts.agents.flatMap((a) => ["--agent", a])], { quiet: true });
  log(`doctor exited ${doctor.code}\n${doctor.stdout}${doctor.stderr}`);

  // 3. One session per agent, each in its own git repo.
  const sessionsByAgent = {};
  for (const a of opts.agents) {
    const spec = AGENTS[a];
    const work = join(root, `work-${a}`);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "README.md"), `# ${a} e2e\n`);
    const git = (...args) => execFileSync("git", args, { cwd: work, env, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const before = stub.requests.length;
    log(`running ${spec.bin} ${spec.args.join(" ")}`);
    const r = await run(spec.bin, spec.args, { cwd: work, env, timeoutMs: 300_000 });
    check(r.code === 0, `${a} exited 0`, r.code);
    const calls = stub.requests.slice(before);
    check(calls.length >= 2, `${a} called the stub model (tool call, then text)`, calls);
    const file = join(work, "hello.txt");
    check(existsSync(file) && readFileSync(file, "utf8").includes("hello from stub"), `${a} wrote hello.txt`);
    sessionsByAgent[a] = { work };
  }

  // 4. What coding.sh recorded.
  const showAll = async () => {
    const list = (await csJson(["sessions", "--limit", "100"], "sessions")).sessions;
    const shows = {};
    for (const s of list) shows[s.id] = await csJson(["show", s.id, "--limit", "100000"], `show ${s.id}`);
    return { list, shows };
  };
  const first = await showAll();
  for (const a of opts.agents) {
    const mine = first.list.filter((s) => s.agent === a);
    check(mine.length === 1, `${a}: one session recorded`, first.list.map((s) => [s.id, s.agent]));
    const s = mine[0];
    if (!s) continue;
    sessionsByAgent[a].id = s.id;
    const { session, events, snapshot } = first.shows[s.id];
    const kinds = (k) => events.filter((e) => e.kind === k);
    const prompts = kinds("user.message").map((e) => String(e.payload.text ?? ""));
    check(prompts.some((t) => t.includes(PROMPT)), `${a}: the prompt`, prompts);
    const tools = events.filter((e) => e.kind === "tool.start" || e.kind === "tool.end").map((e) => e.payload.tool);
    check(tools.some((t) => /write/i.test(String(t))), `${a}: the write tool call`, tools);
    const changed = [...kinds("file.change").map((e) => String(e.payload.path)), ...(snapshot?.files ?? []).map((f) => f.path)];
    check(changed.some((p) => /(^|[\\/])hello\.txt$/.test(p)), `${a}: the file change to hello.txt`, changed);
    check(session.model === MODEL, `${a}: the model`, session.model);
    const replies = kinds("assistant.message").map((e) => String(e.payload.text ?? ""));
    check(replies.some((t) => t.includes(TEXT)), `${a}: the reply`, replies);
    check(session.cwd && resolve(session.cwd).toLowerCase() === resolve(sessionsByAgent[a].work).toLowerCase(), `${a}: the cwd`, [session.cwd, sessionsByAgent[a].work]);
  }

  // 5. Backfill after live capture adds no duplicates, and a second backfill changes nothing.
  const counts = (snap) =>
    Object.fromEntries(
      snap.list.map((s) => {
        const byKind = {};
        for (const e of snap.shows[s.id].events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        return [s.id, byKind];
      }),
    );
  const dupes = (snap) => {
    const out = [];
    for (const s of snap.list) {
      const ev = snap.shows[s.id].events;
      const seen = new Map();
      for (const e of ev) {
        // Natural keys: one row per prompt, reply, call and file per session.
        const key =
          e.kind === "user.message" || e.kind === "assistant.message" ? `${e.kind}:${e.payload.text}`
          : e.kind === "tool.start" || e.kind === "tool.end" ? `${e.kind}:${e.payload.toolUseId ?? e.payload.tool}`
          : e.kind === "file.change" ? `${e.kind}:${e.payload.path}`
          : e.kind === "session.start" || e.kind === "session.end" ? e.kind
          : undefined;
        if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [k, n] of seen) if (n > 1) out.push(`${s.agent} ${k} x${n}`);
    }
    return out;
  };
  check(dupes(first).length === 0, "live capture: no duplicate rows", dupes(first));
  const bf1 = await cs(["ingest", "--backfill", "--json"]);
  check(bf1.code === 0, "ingest --backfill exited 0", bf1.stderr);
  const second = await showAll();
  check(second.list.length === first.list.length, "backfill: no new sessions", second.list.map((s) => [s.id, s.agent]));
  check(dupes(second).length === 0, "backfill: no duplicate rows", dupes(second));
  log(`event counts after live capture ${JSON.stringify(counts(first))}`);
  log(`event counts after backfill     ${JSON.stringify(counts(second))}`);
  const bf2 = await cs(["ingest", "--backfill", "--json"]);
  check(bf2.code === 0, "second ingest --backfill exited 0", bf2.stderr);
  const third = await showAll();
  check(JSON.stringify(counts(third)) === JSON.stringify(counts(second)), "second backfill: nothing changes", [counts(second), counts(third)]);
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`stub requests ${JSON.stringify(stub.requests)}`);
    log(`coding.sh home:\n${listTree(csHome).join("\n")}`);
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
