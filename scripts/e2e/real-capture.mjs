#!/usr/bin/env node
// Real capture, end to end: install coding.sh from a tarball and real agent CLIs
// (npm, Goose's GitHub release, Aider through uv) under a throwaway HOME, run
// `coding.sh init`, drive one non-interactive session per agent against a local stub
// model (one tool call that writes hello.txt, then text; an edit for Aider), and check
// what coding.sh recorded. The MCP server must answer through ~/.coding.sh/bin/mcp.mjs,
// and `ingest --backfill` twice must add no duplicate rows.
//
//   node scripts/e2e/real-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--agents opencode,pi] [--keep]
//
// Agents are spawned with coding.sh's own core/spawn.ts (node 22.18+ loads the .ts),
// so on Windows they run through their npm .cmd shims as a user's would.
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network, and uv on PATH for Aider. Never touches the real HOME: every path is
// under a temp dir.
// Exit codes: 0 all checks passed, 1 a check failed.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  goose: {
    version: "1.57.0",
    bin: "goose",
    async install({ root, toolBin }) {
      const asset = isWin ? "goose-x86_64-pc-windows-msvc.zip" : process.platform === "darwin" ? `goose-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.bz2` : "goose-x86_64-unknown-linux-gnu.tar.bz2";
      const archive = join(root, asset);
      const res = await fetch(`https://github.com/aaif-goose/goose/releases/download/v${this.version}/${asset}`);
      if (!res.ok) throw new Error(`goose download: HTTP ${res.status}`);
      writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      const out = join(root, "goose-unpacked");
      mkdirSync(out, { recursive: true });
      // Windows' own bsdtar reads zip; Git Bash's GNU tar (first on PATH under bash) does not.
      const tar = isWin ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
      execFileSync(tar, ["-xf", archive, "-C", out], { stdio: "pipe" });
      const exe = isWin ? "goose.exe" : "goose";
      const found = findFile(out, exe);
      if (!found) throw new Error(`goose download: no ${exe} in ${asset}`);
      copyFileSync(found, join(toolBin, exe));
      chmodSync(join(toolBin, exe), 0o755);
    },
    configure() {},
    // Provider and model through goose's env settings, so no config file location is assumed.
    env: (stub) => ({ GOOSE_PROVIDER: "openai", GOOSE_MODEL: MODEL, OPENAI_HOST: stub, OPENAI_API_KEY: "stub", GOOSE_DISABLE_KEYRING: "1", GOOSE_MODE: "auto", GOOSE_TELEMETRY_ENABLED: "false" }),
    args: ["run", "-t", PROMPT, "--with-builtin", "developer", "--output-format", "stream-json", "-q", "--max-turns", "5", "--provider", "openai", "--model", MODEL],
    // Goose hooks carry no model: sessions.db adds it at backfill.
    expect: { backfillOnly: ["model"] },
  },
  droid: {
    pkg: "droid@1.6.0",
    bin: "droid",
    configure(home, stub) {
      const dir = join(home, ".factory");
      mkdirSync(dir, { recursive: true });
      const customModels = [{ model: MODEL, displayName: "Stub", baseUrl: `${stub}/v1`, apiKey: "stub", provider: "generic-chat-completion-api", maxOutputTokens: 4096 }];
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ customModels }, null, 2));
    },
    args: ["exec", "--auto", "high", "-m", "custom:Stub-0", "-o", "json", PROMPT],
    // `droid exec` fires no UserPromptSubmit and its Stop carries no text: the transcript adds both.
    expect: { model: "custom:Stub-0", backfillOnly: ["prompt", "reply"] },
  },
  "copilot-cli": {
    pkg: "@github/copilot@1.0.107",
    bin: "copilot",
    configure() {},
    // BYOK against the stub, offline: no GitHub login.
    env: (stub) => ({ COPILOT_PROVIDER_BASE_URL: `${stub}/v1`, COPILOT_PROVIDER_API_KEY: "stub", COPILOT_MODEL: MODEL, COPILOT_OFFLINE: "true", COPILOT_AUTO_UPDATE: "false" }),
    args: ["-p", PROMPT, "--allow-all", "--no-ask-user", "--output-format=json", "--model", MODEL],
    // Copilot hooks carry no model or reply: session-state/<id>/events.jsonl adds them.
    expect: { backfillOnly: ["model", "reply"] },
  },
  aider: {
    version: "0.86.2",
    bin: "aider",
    async install({ root, toolBin, env }) {
      // uv fetches a Python aider supports (3.10-3.12) and keeps the tool under the temp root.
      const uvEnv = { ...env, UV_TOOL_DIR: join(root, "uv-tools"), UV_TOOL_BIN_DIR: toolBin, UV_PYTHON_INSTALL_DIR: join(root, "uv-python"), UV_NO_MODIFY_PATH: "1" };
      const r = await run("uv", ["tool", "install", "--python", "3.12", `aider-chat==${this.version}`], { env: uvEnv, cwd: root, timeoutMs: 900_000 });
      if (r.code !== 0) throw new Error("uv tool install aider-chat failed");
    },
    configure() {},
    env: () => ({ AIDER_CHECK_UPDATE: "false", AIDER_ANALYTICS: "false", PYTHONIOENCODING: "utf-8" }),
    // No hooks: `coding.sh run --` records it, as a user would run it.
    wrap: true,
    args: ["--model", `openai/${MODEL}`, "--openai-api-base", "{stub}/v1", "--openai-api-key", "stub", "--edit-format", "whole", "--yes-always", "--no-auto-commits", "--no-stream", "--no-pretty", "--no-check-update", "--no-analytics", "--no-show-model-warnings", "--no-show-release-notes", "--no-gitignore", "--message", PROMPT],
    // The wrapper sees argv and the repo, not tool calls or replies: one model call, no tools.
    // Its tokens come from Aider's analytics log, read while it runs (src/capture/aider.ts).
    expect: { model: `openai/${MODEL}`, tool: false, reply: false, minCalls: 1, usage: true },
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

/** Starts `node <launcher>` as an agent would, lists the tools and calls sessions_list. */
function mcpRoundTrip(launcher, env, cwd) {
  return new Promise((resolveRpc) => {
    const child = spawn(process.execPath, [launcher], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const replies = new Map();
    let buf = "";
    let stderr = "";
    const finish = (error) => {
      clearTimeout(timer);
      child.kill();
      resolveRpc({ tools: replies.get(2)?.result?.tools?.map((t) => t.name) ?? [], sessions: replies.get(3)?.result, error: error ?? (stderr.trim() || undefined) });
    };
    const timer = setTimeout(() => finish("timed out"), 60_000);
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) replies.set(msg.id, msg);
        } catch {}
        if (replies.has(3)) return finish();
      }
    });
    child.on("error", (e) => finish(String(e)));
    child.on("exit", (code) => !replies.has(3) && finish(`exited ${code}: ${stderr}`));
    const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "real-capture", version: "0" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list", params: {} });
    send({ id: 3, method: "tools/call", params: { name: "sessions_list", arguments: {} } });
  });
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: not JSON:\n${text.slice(0, 2000)}`);
  }
}

function findFile(dir, name) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (n === name) return p;
  }
  return undefined;
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
// Agents that are not on npm (Goose, Aider) install their executables here.
const toolBin = join(root, "tools-bin");
mkdirSync(toolBin, { recursive: true });

// A clean environment: nothing from the real HOME or agent configs leaks in.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(XDG_|OPENCODE|PI_|GOOSE_|COPILOT_|FACTORY_|AIDER_|OPENAI_|ANTHROPIC_|GH_TOKEN$|GITHUB_TOKEN$|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) continue;
  env[k] = v;
}
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  CODING_SH_HOME: csHome,
  [pathKey]: [binDir, toolBin, env[pathKey]].filter(Boolean).join(delimiter),
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
  const pkgs = opts.agents.map((a) => AGENTS[a].pkg).filter(Boolean);
  log(`installing ${tarball} and ${pkgs.join(", ")}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, ...pkgs], { env, cwd: root, timeoutMs: 600_000 });
  if (install.code !== 0) throw new Error("npm install -g failed");
  for (const a of opts.agents) {
    const spec = AGENTS[a];
    if (!spec.install) continue;
    log(`installing ${a} ${spec.version}`);
    await spec.install({ root, toolBin, env });
  }
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
    const args = spec.args.map((x) => x.replace("{stub}", stub.url));
    const [file0, args0] = spec.wrap ? ["coding.sh", ["run", "--", spec.bin, ...args]] : [spec.bin, args];
    log(`running ${file0} ${args0.join(" ")}`);
    const r = await run(file0, args0, { cwd: work, env: { ...env, ...spec.env?.(stub.url) }, timeoutMs: 300_000 });
    check(r.code === 0, `${a} exited 0`, r.code);
    const calls = stub.requests.slice(before);
    const minCalls = spec.expect?.minCalls ?? 2;
    check(calls.length >= minCalls, `${a} called the stub model (${minCalls > 1 ? "tool call, then text" : "an edit"})`, calls);
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
  // Each field the recorded session must hold; an agent's spec can drop one (`tool: false`) or
  // move it after history import (`backfillOnly`).
  const checkSession = (a, snap, fields, when = "") => {
    const s = snap.list.find((x) => x.agent === a);
    if (!s) return;
    const spec = AGENTS[a];
    const { session, events, snapshot } = snap.shows[s.id];
    const kinds = (k) => events.filter((e) => e.kind === k);
    const same = (p) => !!p && resolve(p).toLowerCase() === resolve(sessionsByAgent[a].work).toLowerCase();
    for (const f of fields) {
      if (f === "prompt") {
        const prompts = kinds("user.message").map((e) => String(e.payload.text ?? ""));
        check(prompts.some((t) => t.includes(PROMPT)), `${a}: the prompt${when}`, prompts);
      } else if (f === "tool") {
        const tools = events.filter((e) => e.kind === "tool.start" || e.kind === "tool.end").map((e) => e.payload.tool);
        check(tools.some((t) => /write|create/i.test(String(t))), `${a}: the write tool call${when}`, tools);
      } else if (f === "file") {
        const changed = [...kinds("file.change").map((e) => String(e.payload.path)), ...(snapshot?.files ?? []).map((x) => x.path)];
        check(changed.some((p) => /(^|[\\/])hello\.txt$/.test(p)), `${a}: the file change to hello.txt${when}`, changed);
      } else if (f === "model") {
        check(session.model === (spec.expect?.model ?? MODEL), `${a}: the model${when}`, session.model);
      } else if (f === "reply") {
        const replies = kinds("assistant.message").map((e) => String(e.payload.text ?? ""));
        check(replies.some((t) => t.includes(TEXT)), `${a}: the reply${when}`, replies);
      } else if (f === "cwd") check(same(session.cwd), `${a}: the cwd${when}`, [session.cwd, sessionsByAgent[a].work]);
      else if (f === "repo") check(same(session.repo), `${a}: the git repo${when}`, [session.repo, sessionsByAgent[a].work]);
      else if (f === "usage") check((session.stats?.usage?.inputTokens ?? 0) > 0 && (session.stats?.usage?.outputTokens ?? 0) > 0, `${a}: token usage${when}`, session.stats?.usage);
    }
  };
  const FIELDS = ["prompt", "tool", "file", "model", "reply", "cwd", "repo"];
  // "usage" is checked only where an agent's spec asks for it.
  const liveFields = (a) => [...FIELDS, ...(AGENTS[a].expect?.usage ? ["usage"] : [])].filter((f) => AGENTS[a].expect?.[f] !== false && !AGENTS[a].expect?.backfillOnly?.includes(f));
  const first = await showAll();
  for (const a of opts.agents) {
    const mine = first.list.filter((s) => s.agent === a);
    check(mine.length === 1, `${a}: one session recorded`, first.list.map((s) => [s.id, s.agent]));
    if (!mine[0]) continue;
    sessionsByAgent[a].id = mine[0].id;
    checkSession(a, first, liveFields(a));
  }

  // 5. The MCP server agents launch (init registered `node ~/.coding.sh/bin/mcp.mjs` with OpenCode):
  //    through the installed CLI named in cli-path, then through the coding.sh on PATH.
  const launcher = join(csHome, "bin", "mcp.mjs");
  const mcpCheck = async (how) => {
    const r = await mcpRoundTrip(launcher, env, root);
    const text = JSON.stringify(r.sessions ?? null);
    check(r.tools.includes("sessions_list") && opts.agents.every((a) => text.includes(sessionsByAgent[a].id ?? "?")), `MCP server via ${how}: tools/list and sessions_list`, r);
  };
  await mcpCheck("cli-path");
  const cliPath = join(csHome, "bin", "cli-path");
  const saved = readFileSync(cliPath, "utf8");
  rmSync(cliPath);
  await mcpCheck("coding.sh on PATH");
  writeFileSync(cliPath, saved);

  // 6. Backfill after live capture adds no duplicates, and a second backfill changes nothing.
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
  for (const a of opts.agents) if (AGENTS[a].expect?.backfillOnly) checkSession(a, second, AGENTS[a].expect.backfillOnly, " (after backfill)");
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
  if (!opts.keep && !failures.length) {
    // Best effort: on Windows a process an agent leaves behind can still hold a file open.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      log(`could not remove ${root}: ${e instanceof Error ? e.message : e}`);
      if (isWin) {
        try {
          const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${root.split(/[\\/]/).pop()}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.CommandLine)" }`;
          log(`processes still using it:\n${execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" })}`);
        } catch {}
      }
    }
  } else log(`kept ${root}`);
}
process.exit(exitCode);
