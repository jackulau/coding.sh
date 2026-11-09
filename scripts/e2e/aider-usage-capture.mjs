#!/usr/bin/env node
// Live Aider usage, recorded from a real Aider: `coding.sh run -- aider …` (from source) against
// the stub model, under a throwaway HOME and CODING_SH_HOME. Writes the fixtures that
// test/capture/aider.test.ts replays:
//
//   cache.spool.jsonl     two replies in one session, Anthropic usage with cache writes and reads,
//                         a model priced in ~/.aider.model.metadata.json; the wrapper read the usage
//                         from its own temp analytics log
//   nocost.spool.jsonl    one reply, openai/stub-model with no price, `--analytics-log` named on argv
//   cache.analytics.jsonl the analytics log of a third run (the cache session again, with
//                         AIDER_ANALYTICS_LOG set by the user), and cache.history.md the chat history
//                         that run appended: the files the tap reads, for replay through a fake aider
//
//   node scripts/e2e/aider-usage-capture.mjs [--aider <path to aider>] [--out <dir>]
//
// Needs Aider 0.86.2 (`uv tool install --python 3.12 aider-chat==0.86.2`) and node 22.18+.
// Paths are scrubbed to /work/demo and /home/user, the stub's port to 8794, and the analytics
// user id and platform fields to fixed values.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO, "packages", "coding.sh", "src", "cli", "main.ts");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const AIDER = opt("--aider", "aider");
const OUT = resolve(opt("--out", join(REPO, "packages", "coding.sh", "test", "fixtures", "adapters", "aider")));
const CACHE_MODEL = "anthropic/claude-3-5-sonnet-20241022";
// Prompt side of each Anthropic reply: 1500 uncached, 2400 written to the cache, 12000 read from it.
const CACHE_USAGE = { input_tokens: 1500, cache_creation_input_tokens: 2400, cache_read_input_tokens: 12000 };

const root = mkdtempSync(join(tmpdir(), "csh-aider-usage-"));
const home = join(root, "home");
const csHome = join(root, "cs-home");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
// Prices for the cache model, the way a user prices a model Aider doesn't know: Aider then reports a cost.
const PRICE = { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 3e-7 };
writeFileSync(join(home, ".aider.model.metadata.json"), JSON.stringify({ [CACHE_MODEL]: { max_tokens: 8192, max_input_tokens: 200000, max_output_tokens: 8192, ...PRICE, litellm_provider: "anthropic", mode: "chat", supports_prompt_caching: true } }, null, 2));

const stub = await startStub({
  // Aider (no tools, whole edit format) always gets a reply that rewrites hello.txt; Anthropic replies carry cache usage.
  decide: (body) => (body.system !== undefined || /claude/.test(String(body.model)) ? { text: "Done.\n\nhello.txt\n```\nhello from stub\n```\n", usage: CACHE_USAGE } : undefined),
});

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(AIDER_|OPENAI_|ANTHROPIC_|CODING_SH)/i.test(k)) env[k] = v;
Object.assign(env, { HOME: home, USERPROFILE: home, CODING_SH_HOME: csHome, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_UI: "1", AIDER_CHECK_UPDATE: "false", PYTHONIOENCODING: "utf-8" });

const common = ["--edit-format", "whole", "--yes-always", "--no-auto-commits", "--no-stream", "--no-pretty", "--no-check-update", "--no-analytics", "--no-show-model-warnings", "--no-show-release-notes", "--no-gitignore", "--no-fancy-input"];

function repo(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  const git = (...a) => execFileSync("git", a, { cwd: dir, env, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

function wrapped(cwd, aiderArgs, { stdin = "", extraEnv = {} } = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, "run", "--", AIDER, ...aiderArgs], { cwd, env: { ...env, ...extraEnv, PWD: cwd }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(stdin);
    child.on("close", (code) => ok({ code, out }));
  });
}

function spool(agent) {
  const dir = join(csHome, "spool", agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean));
}

const port = new URL(stub.url).port;
const scrub = (s, cwd) =>
  s
    .split(cwd)
    .join("/work/demo")
    .split(home)
    .join("/home/user")
    .split(root)
    .join("/tmp/demo")
    .replaceAll(`127.0.0.1:${port}`, "127.0.0.1:8794")
    // Aider quotes its own argv[0] (the install path) at the top of the chat history.
    .replace(/(^|[\s"])\/[^\s"]*\/aider(?=\s)/g, "$1aider")
    .replace(/"user_id":\s*"[^"]*"/g, '"user_id": "00000000-0000-4000-8000-000000000000"')
    .replace(/"(os_platform|os_release|machine|python_version)":\s*"[^"]*"/g, '"$1": "scrubbed"');

const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) {
    failures.push(what);
    if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  }
};

mkdirSync(OUT, { recursive: true });
try {
  const anth = ["--model", CACHE_MODEL, ...common];
  const anthEnv = { ANTHROPIC_API_KEY: "stub", ANTHROPIC_API_BASE: stub.url, ANTHROPIC_BASE_URL: stub.url };

  // 1. Two replies, the tap's own temp log.
  const a = repo("work-cache");
  let r = await wrapped(a, anth, { stdin: "create hello.txt\nsay hello again in hello.txt\n", extraEnv: anthEnv });
  check(r.code === 0, "cache session exited 0", r.out.slice(-3000));
  let lines = spool("aider");
  const usage = lines.filter((l) => JSON.parse(l).event === "llm.usage");
  check(usage.length === 2, "cache session spooled two llm.usage lines", lines);
  check(usage.every((l) => JSON.parse(l).raw.usage.costUsd > 0 && JSON.parse(l).raw.usage.cacheReadTokens > 0), "each reply has a cost and cache reads", usage);
  writeFileSync(join(OUT, "cache.spool.jsonl"), lines.map((l) => scrub(l, a)).join("\n") + "\n");
  rmSync(join(csHome, "spool"), { recursive: true, force: true });

  // 2. No price, user-named log on argv.
  const b = repo("work-nocost");
  const named = join(root, "named-analytics.jsonl");
  r = await wrapped(b, ["--model", "openai/stub-model", "--openai-api-base", `${stub.url}/v1`, "--openai-api-key", "stub", "--analytics-log", named, ...common, "--message", "create hello.txt"]);
  check(r.code === 0, "nocost session exited 0", r.out.slice(-3000));
  lines = spool("aider");
  check(lines.filter((l) => JSON.parse(l).event === "llm.usage").length === 1, "nocost session spooled one llm.usage line", lines);
  check(existsSync(named) && readFileSync(named, "utf8").includes("message_send"), "the user's named analytics log still got its events");
  writeFileSync(join(OUT, "nocost.spool.jsonl"), lines.map((l) => scrub(l, b)).join("\n") + "\n");
  rmSync(join(csHome, "spool"), { recursive: true, force: true });

  // 3. The cache session again with a user log in env: keep the files the tap reads.
  const c = repo("work-replay");
  const log = join(root, "env-analytics.jsonl");
  r = await wrapped(c, anth, { stdin: "create hello.txt\nsay hello again in hello.txt\n", extraEnv: { ...anthEnv, AIDER_ANALYTICS_LOG: log } });
  check(r.code === 0, "replay session exited 0", r.out.slice(-3000));
  const sends = readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"message_send"'));
  check(sends.length === 2, "the env-named analytics log has two message_send events");
  writeFileSync(join(OUT, "cache.analytics.jsonl"), sends.map((l) => scrub(l, c)).join("\n") + "\n");
  const hist = readFileSync(join(c, ".aider.chat.history.md"), "utf8");
  check(/Tokens: .*cache write.*cache hit/.test(hist), "the chat history quotes the cache split", hist.slice(-2000));
  writeFileSync(join(OUT, "cache.history.md"), scrub(hist, c));
  console.log(`fixtures in ${OUT}`);
} finally {
  await stub.close();
  if (!args.includes("--keep")) rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
process.exit(failures.length ? 1 : 0);
