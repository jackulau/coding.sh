#!/usr/bin/env node
// A real Claude Code transcript with turns the person stopped, for adapter fixtures: install the
// pinned Claude Code CLI from npm under a throwaway HOME, point it at the local stub model and play
// three prompts in one process (stream-json input):
//   - the first is stopped while the model writes: the stub streams a sentence, holds back the rest
//     of its reply, and the script sends the interrupt control request (what the Agent SDK sends to
//     stop a turn, as Esc does in the terminal);
//   - the second is stopped during a tool call: the model runs a Bash `sleep`, and the script sends
//     the interrupt while it runs;
//   - the third ends as usual.
// Claude Code records each stop as a prompt: "[Request interrupted by user]", and "[Request
// interrupted by user for tool use]" during a tool call. The transcript is copied out with the temp
// paths (and the project slug) scrubbed to /work/demo and /home/user, like the other adapter
// fixtures. Request snapshots (api-request lines, prompt_snapshot attachments) are dropped.
//
//   node scripts/e2e/claude-stop-capture.mjs --out <dir> [--tmp <dir>] [--keep]
//
// Claude Code reads CLAUDE.md files, rules, skills and agents from every folder above the project,
// and git looks for a repository there, so the script refuses to run when a folder above its temp
// folder holds a CLAUDE.md, CLAUDE.local.md, .claude or .git. Windows keeps the temp folder under
// your home, next to ~/.claude: pass --tmp with a folder outside it. The script also writes no
// transcript that names your home.
//
// Needs network for npm. Never touches the real HOME. Exit 0 when a transcript with both stops was
// written. On Windows npm and claude are .cmd shims: they run through coding.sh's portable spawn, the
// npm global bin is the prefix itself, and USERPROFILE/APPDATA point into the throwaway home.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execFileSync, spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub, toolNames } from "./stub-model.mjs";
import { tempBase } from "./temp-base.ts";

const PKG = "@anthropic-ai/claude-code@2.1.319";
const isWin = process.platform === "win32";
const MODEL = "claude-sonnet-4-5";
const debug = (line) => process.env.CAPTURE_DEBUG && console.error(line);

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : undefined);
const outDir = flag("--out");
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

// Real path: Claude Code records the resolved cwd (/private/var/… on macOS), which the scrub must match.
const base = tempBase(realpathSync(flag("--tmp") ?? tmpdir()), "pass --tmp <dir> with a folder that has none of them above it");
const root = realpathSync(mkdtempSync(join(base, "csh-cc-stop-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
// npm -g puts command shims in <prefix>/bin on POSIX and in <prefix> itself on Windows.
const binDir = isWin ? prefix : join(prefix, "bin");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "CLAUDE.md"), "Keep changes small.\n");
writeFileSync(join(project, "notes.txt"), "alpha\nbravo\n");

// One entry per main-loop model call (one that offers Read); Claude Code's side calls get "ok".
const SCRIPT = [
  // A sentence, then the Read call held back long after the script stops the turn.
  { text: "Let me read notes.txt first.", tool: { name: "Read", args: { file_path: join(project, "notes.txt") } }, pauseMs: 20_000 },
  { text: "Running the slow check.", tool: { name: "Bash", args: { command: "sleep 20", description: "Slow check" } } },
  { text: "Done." },
];
/** Main-loop model calls answered so far. */
let call = 0;

function decide(body) {
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Read")) return { text: "ok" };
  const s = SCRIPT[Math.min(call++, SCRIPT.length - 1)];
  debug(`stub: call ${call - 1} -> ${s.tool?.name ?? "text"}`);
  return s;
}

const stub = await startStub({ decide });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) env[k] = v;
// Windows spells it Path; a second PATH key would leave which one wins to chance.
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
Object.assign(env, {
  HOME: home,
  // Node (and so Claude Code) takes the home directory from USERPROFILE on Windows.
  USERPROFILE: home,
  [pathKey]: [binDir, env[pathKey]].filter(Boolean).join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
});
if (process.getuid?.() === 0) env.IS_SANDBOX = "1";
if (isWin) {
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
}
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;

try {
  // npm 12 runs no install script it is not told to; Claude Code's fetches its native binary. npm 11 and older accept the flag too.
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", "--allow-scripts=@anthropic-ai/claude-code", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).trim()}`);
  // Async: the stub answers from this process, so a sync spawn would deadlock it.
  await new Promise((done, fail) => {
    const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    const say = (text) => send({ type: "user", message: { role: "user", content: text } });
    // Claude Code answers on stdout, one message per line: a control_response for the interrupt, a result when a turn ends.
    const seen = [];
    let rest = "";
    child.stdout.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          seen.push(m);
          debug(`claude: ${m.type}${m.subtype ? ` ${m.subtype}` : ""}${m.response?.subtype ? ` ${m.response.subtype}` : ""}`);
        } catch {}
      }
    });
    const results = () => seen.filter((m) => m.type === "result").length;
    const until = (what, test, ms = 60_000) =>
      new Promise((ok, no) => {
        const by = Date.now() + ms;
        (function poll() {
          if (test()) return ok();
          if (Date.now() > by) return no(new Error(`timed out waiting for ${what}`));
          setTimeout(poll, 100);
        })();
      });
    const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
    let stops = 0;
    const stop = async (turns) => {
      const id = `stop-${++stops}`;
      send({ type: "control_request", request_id: id, request: { subtype: "interrupt" } });
      await until(`the answer to ${id}`, () => seen.some((m) => m.type === "control_response" && m.response?.request_id === id));
      await until(`the end of turn ${turns}`, () => results() >= turns);
    };
    (async () => {
      say("Summarize notes.txt.");
      await until("the first model call", () => call >= 1);
      // The sentence has streamed; the Read call is held back.
      await pause(1500);
      await stop(1);
      await pause(1000);
      say("Run the slow check.");
      await until("the second model call", () => call >= 2);
      // The Bash sleep is running.
      await pause(3000);
      await stop(2);
      await pause(1000);
      say("Say done.");
      await until("the end of turn 3", () => results() >= 3);
      await pause(1000);
      child.stdin.end();
    })().catch((e) => (child.kill(), fail(e)));
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c}`))));
  });
  const projects = join(home, ".claude", "projects");
  mkdirSync(outDir, { recursive: true });
  const dropped = (line) => /^\{"type":"api-request/.test(line) || line.includes('"type":"prompt_snapshot"');
  // Each temp path as written, as JSON escapes it once and twice (tool input quoted inside a
  // message: a Windows path's backslashes doubled, then doubled again) and with forward slashes;
  // then on Windows the separators left inside a scrubbed path (two or four backslashes: a lone
  // one starts an escape such as \n) become forward slashes.
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  const forms = (path) => [...new Set([esc(esc(path)), esc(path), path, path.replaceAll("\\", "/")])];
  const swaps = [
    ...forms(project).map((f) => [f, "/work/demo"]),
    [project.replace(/[^A-Za-z0-9]/g, "-"), "-work-demo"],
    ...forms(home).map((f) => [f, "/home/user"]),
    ...forms(root).map((f) => [f, "/tmp/capture"]),
  ];
  const posixTail = (s) => s.replace(/(\/work\/demo|\/home\/user|\/tmp\/capture)((?:(?:\\\\){1,2}[^"\\\s]+)+)/g, (_, head, tail) => head + tail.replace(/(?:\\\\){1,2}/g, "/"));
  const scrub = (s) => {
    const kept = s
      .split("\n")
      .filter((l) => !dropped(l))
      .join("\n");
    const out = swaps.reduce((text, [from, to]) => text.split(from).join(to), kept);
    return isWin ? posixTail(out) : out;
  };
  const files = [];
  for (const slug of readdirSync(projects)) {
    for (const f of readdirSync(join(projects, slug), { recursive: true })) {
      if (String(f).endsWith(".jsonl")) files.push([join(outDir, String(f)), scrub(readFileSync(join(projects, slug, String(f)), "utf8"))]);
    }
  }
  const written = files.map(([, text]) => text).join("\n");
  const fold = (s) => (isWin ? s.toLowerCase() : s);
  const yours = forms(userInfo().homedir).filter((f) => fold(written).includes(fold(f)));
  if (yours.length) throw new Error(`a transcript names your home (${yours[0]}); nothing was written`);
  for (const [dest, text] of files) {
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, text);
  }
  const both = written.includes("[Request interrupted by user]") && written.includes("[Request interrupted by user for tool use]");
  console.error(`${files.length} transcript(s) in ${outDir}; ${stub.requests.length} model requests; ${both ? "both stops recorded" : "a stop is missing"}`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = files.length && both ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
