#!/usr/bin/env node
// Builds a deterministic coding.sh world for one CLI-effectiveness trial.
//
//   node make-home.mjs --out <trialRoot> [--seed 1] [--now <ms>] [--cli <dist/cli.mjs>] [--answers <file>]
//
// Layout under <trialRoot> (all paths realpath'd):
//   home/                fake $HOME for coding.sh (has .claude/settings.json with coding.sh hooks, .codex/)
//   home/.coding.sh/     CODING_SH_HOME: spool → ingested through the CLI under test
//   repos/<name>/        working dirs sessions ran in (calc, strings are git repos)
//   transcripts/         Claude Code transcripts the Stop hooks point at (model-call timing)
//   harness/{base,lean}  harness dirs snapshotted into bundles "base" and "lean"
//   fakebin/codex        stub so `doctor` sees Codex installed (and not hooked)
//   work/                the agent's working directory (empty)
// Answers go to <trialRoot>.hidden/answers.json (outside the agent's tree) unless --answers is given.
//
// Timestamps are rebased to --now (default: the current time), so "yesterday",
// "today", "this week" and "since Monday" are well defined. Every answer is
// computed from the generator's own spec, never from the CLI under test,
// except where noted (ids the CLI assigns: tasks, experiments, bundles).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
if (!flag("--out")) {
  process.stderr.write("usage: make-home.mjs --out <dir> [--seed n] [--now ms] [--cli path] [--answers file]\n");
  process.exit(2);
}
const SEED = Number(flag("--seed", "1"));
const NOW = Number(flag("--now", String(Date.now())));
const CLI = resolve(flag("--cli", join(HERE, "..", "..", "..", "packages", "coding.sh", "dist", "cli.mjs")));
mkdirSync(flag("--out"), { recursive: true });
const R = realpathSync(resolve(flag("--out")));
const ANSWERS = resolve(flag("--answers", `${R}.hidden/answers.json`));

const HOME = join(R, "home");
const DATA = join(HOME, ".coding.sh");
const SPOOL = join(DATA, "spool");
const FAKEBIN = join(R, "fakebin");
for (const d of [HOME, SPOOL, FAKEBIN, join(R, "work"), join(R, "transcripts"), dirname(ANSWERS)]) mkdirSync(d, { recursive: true });

const ENV = {
  HOME,
  USERPROFILE: HOME,
  CODING_SH_HOME: DATA,
  CODEX_HOME: join(HOME, ".codex"),
  CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  XDG_CONFIG_HOME: join(HOME, ".config"),
  XDG_DATA_HOME: join(HOME, ".local", "share"),
  PATH: [FAKEBIN, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  TZ: process.env.TZ ?? "",
  LANG: "C",
  NO_COLOR: "1",
  CODING_SH_HOOK_SOURCE: join(dirname(CLI), "hook.mjs"),
};
if (!ENV.TZ) delete ENV.TZ;

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: ENV, cwd: opts.cwd ?? R, encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`fixture: coding.sh ${args.join(" ")} exited ${r.status}\n${r.stderr}`);
  return r;
}
function cliJson(args, opts) {
  return JSON.parse(cli([...args, "--json"], opts).stdout);
}
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env: { ...ENV, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture: ${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// ---------------------------------------------------------------- time

const DAY = 86400e3;
function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function at(day0, h, m = 0) {
  const d = new Date(day0);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const today0 = dayStart(NOW);
const yest0 = dayStart(today0 - 1);
const daysAgo = (n) => dayStart(today0 - n * DAY + DAY / 2);
const monday0 = dayStart(today0 - ((new Date(today0).getDay() + 6) % 7) * DAY + DAY / 2);
const week0 = NOW - 7 * DAY;

// ---------------------------------------------------------------- ids

function uuid(key) {
  const h = createHash("sha256").update(`${SEED}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------- repos

const REPOS = {};
for (const name of ["webapp", "api", "infra", "calc", "strings"]) {
  REPOS[name] = join(R, "repos", name);
  mkdirSync(REPOS[name], { recursive: true });
}
writeFileSync(join(REPOS.calc, "calc.mjs"), "export const add = (a, b) => a - b;\n");
// An assert call, so `eval validate` has an expected value to flip for its impossible variant.
// (With an `if` and a console.error("… should be 5") it flipped the message and called the verifier gameable.)
writeFileSync(join(REPOS.calc, "test.mjs"), 'import assert from "node:assert/strict";\nimport { add } from "./calc.mjs";\nassert.equal(add(2, 3), 5);\n');
writeFileSync(join(REPOS.strings, "slug.mjs"), 'export const slugify = (s) => s.trim().replace(/\\s+/g, "-");\n');
writeFileSync(join(REPOS.strings, "test.mjs"), 'import { slugify } from "./slug.mjs";\nif (slugify(" Hello World ") !== "hello-world") process.exit(1);\n');
for (const name of ["calc", "strings"]) {
  run("git", ["init", "-q", "-b", "main"], REPOS[name]);
  run("git", ["add", "-A"], REPOS[name]);
  run("git", ["commit", "-qm", "initial"], REPOS[name]);
}

// ---------------------------------------------------------------- session spec

/**
 * tools: { name, input, ms, ok=true, error? }
 * llm:   { ms, out, in }   (Claude Code only: written to a transcript the Stop hook reads)
 * subagents: { type, tools[] }
 */
const sessions = [];
function session(key, agent, repo, start, prompt, extra = {}) {
  const s = { key, id: uuid(key), agent, cwd: REPOS[repo], repo, start, prompt, tools: [], llm: [], subagents: [], compact: false, model: agent === "codex" ? "gpt-5.5" : "claude-sonnet-5", reply: "Done.", ...extra };
  sessions.push(s);
  return s;
}
const bash = (command, ms, ok = true, error) => ({ name: "Bash", input: { command }, ms, ok, error });
const read = (file_path, ms) => ({ name: "Read", input: { file_path }, ms, ok: true });
const shell = (command, ms, ok = true, error) => ({ name: "shell", input: { command }, ms, ok, error });

// Older than a week: distractors for every windowed question.
session("old1", "claude-code", "webapp", daysAgo(10) + 10 * 3600e3, "migrate the build from webpack to vite", {
  tools: [bash("npm run build", 95_000), read("vite.config.ts", 40)],
  llm: [{ ms: 9100, in: 4000, out: 900 }],
});
session("old2", "codex", "api", daysAgo(9) + 15 * 3600e3, "add an index on orders.created_at", { tools: [shell("psql -f migrate.sql", 1200)] });
session("oldcalc", "claude-code", "calc", daysAgo(12) + 9 * 3600e3, "explain how calc.mjs is tested", { tools: [read("test.mjs", 30)], llm: [{ ms: 1500, in: 900, out: 120 }] });

// The last week (days 2–6).
session("d2", "claude-code", "api", at(daysAgo(2), 11), "add rate limiting to the login endpoint", {
  tools: [read("src/routes/login.ts", 70), bash("npm run test:integration", 52_000), { name: "Edit", input: { file_path: "src/routes/login.ts" }, ms: 60, ok: true }],
  llm: [{ ms: 4200, in: 6000, out: 700 }, { ms: 2600, in: 6500, out: 300 }],
});
session("w1", "codex", "webapp", at(daysAgo(3), 10), "upgrade react-router to v7", { tools: [shell("npm install react-router@7", 14_000), shell("npm test", 6_000, false, "2 tests failed")] });
session("w2", "claude-code", "infra", at(daysAgo(4), 14), "split the terraform state per environment", {
  tools: [bash("terraform plan", 21_000), read("main.tf", 50)],
  compact: true,
  llm: [{ ms: 6100, in: 90_000, out: 1500 }, { ms: 3300, in: 30_000, out: 400 }],
});
session("w3", "codex", "api", at(daysAgo(5), 16), "document the webhook retry policy", { tools: [shell("rg retry src", 400)] });
session("w4", "claude-code", "webapp", at(daysAgo(6), 9), "update the button snapshots after the theme change", {
  tools: [bash("npm test -- -u", 8_000)],
  llm: [{ ms: 2100, in: 3000, out: 200 }],
});
for (let i = 0; i < 6; i++) {
  const agent = i % 3 === 2 ? "codex" : "claude-code";
  session(`f${i}`, agent, ["webapp", "api", "infra"][i % 3], at(daysAgo(2 + (i % 5)), 17, 5 * i), `small chore #${i + 1}: tidy imports`, {
    tools: [agent === "codex" ? shell("npm run lint -- --fix", 900 + 100 * i) : bash("npm run lint -- --fix", 900 + 100 * i)],
    llm: agent === "codex" ? [] : [{ ms: 800 + 150 * i, in: 1200, out: 60 + i }],
  });
}

// Yesterday.
session("y1", "claude-code", "webapp", at(yest0, 9, 30), "add pagination to the users table", {
  model: "claude-opus-5",
  tools: [read("src/users/Table.tsx", 120), { name: "Edit", input: { file_path: "src/users/Table.tsx" }, ms: 80, ok: true }, bash("npm test", 2100)],
  llm: [{ ms: 1800, in: 5000, out: 400 }, { ms: 2400, in: 5600, out: 650 }, { ms: 1200, in: 6000, out: 90 }],
});
session("y2", "claude-code", "api", at(yest0, 13, 10), "why is the snapshot test in api flaky? it fails about one run in five", {
  tools: [{ name: "Grep", input: { pattern: "toMatchSnapshot" }, ms: 300, ok: true }, bash("npm test -- snapshot.test.ts --runInBand", 47_300), read("test/snapshot.test.ts", 90)],
  llm: [{ ms: 3100, in: 7000, out: 500 }, { ms: 2900, in: 7500, out: 800 }],
  reply: "The snapshot includes Date.now(); freeze the clock in the test.",
});
session("y3", "claude-code", "webapp", at(yest0, 16), "review the auth module and write a short report", {
  tools: [read("src/auth/index.ts", 60)],
  subagents: [
    { type: "Explore", tools: [{ name: "Grep", input: { pattern: "session" }, ms: 200, ok: true }, read("src/auth/session.ts", 40)] },
    { type: "code-reviewer", tools: [read("src/auth/index.ts", 50)] },
    { type: "Explore", tools: [{ name: "Glob", input: { pattern: "src/auth/**" }, ms: 30, ok: true }] },
  ],
  llm: [{ ms: 2000, in: 8000, out: 300 }, { ms: 5200, in: 12_000, out: 1400 }],
});
session("y4", "codex", "infra", at(yest0, 11), "bump the terraform aws provider to v6", { tools: [shell("terraform init -upgrade", 8000), shell("terraform validate", 1500)] });
session("ycalc", "claude-code", "calc", at(yest0, 18), "why does calc.mjs have no default export?", { tools: [read("calc.mjs", 20)], llm: [{ ms: 1100, in: 800, out: 90 }] });
// An agent that edits a file, says "Done." and never runs a check: the no-verification issue in
// calc (wrapper sessions say nothing, so they are not counted for it).
session("ycalc2", "claude-code", "calc", at(yest0, 19), "make add return the sum", { tools: [read("calc.mjs", 20), { name: "Edit", input: { file_path: "calc.mjs" }, ms: 60, ok: true }], llm: [{ ms: 1300, in: 900, out: 110 }] });

// Today (relative to now so it is always in the past).
session("t1", "claude-code", "api", NOW - 50 * 60e3, "the integration tests fail on CI, fix them", {
  tools: [
    ...Array.from({ length: 5 }, (_, i) => bash("npm run test:integration", 3000 + 200 * i, false, "Error: connect ECONNREFUSED 127.0.0.1:5432")),
    read("docker-compose.yml", 40),
  ],
  llm: [{ ms: 2500, in: 9000, out: 300 }, { ms: 2700, in: 9500, out: 280 }, { ms: 3900, in: 10_000, out: 1100 }],
});
session("t2", "claude-code", "webapp", NOW - 35 * 60e3, "refactor the settings page into smaller components", {
  tools: [read("src/settings/Page.tsx", 90), bash("npm run typecheck", 4000, false, "TS2322: Type 'string' is not assignable to type 'number'."), bash("npm run typecheck", 4100, false, "TS2741: Property 'id' is missing"), bash("npm run typecheck", 3900)],
  compact: true,
  llm: [{ ms: 4400, in: 120_000, out: 2200 }, { ms: 1900, in: 40_000, out: 350 }],
});
session("t3", "codex", "api", NOW - 20 * 60e3, "write a changelog entry for 2.4.0", { tools: [shell("git log --oneline v2.3.0..HEAD", 300), shell("cat CHANGELOG.md", 50), shell("npx prettier --check CHANGELOG.md", 1200, false, "[warn] CHANGELOG.md")] });
session("t4", "claude-code", "infra", NOW - 8 * 60e3, "what does the deploy script do?", { tools: [read("scripts/deploy.sh", 30)], llm: [{ ms: 2300, in: 2000, out: 450 }] });

// ---------------------------------------------------------------- spool writing

let pid = 41000;
function spoolLine(agent, event, ts, cwd, raw, p) {
  const file = join(SPOOL, agent, `${new Date(ts).toISOString().slice(0, 10)}.${p}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ v: 0, agent, event, ts, pid: p, ppid: p - 1, cwd, raw: { hook_event_name: event, cwd, ...raw } }) + "\n");
}

function writeTranscript(s, t0) {
  const path = join(R, "transcripts", `${s.id}.jsonl`);
  const rows = [{ type: "user", uuid: uuid(`${s.key}:u0`), timestamp: new Date(t0).toISOString(), cwd: s.cwd, sessionId: s.id, version: "2.1.319", message: { role: "user", content: s.prompt } }];
  let t = t0;
  s.llm.forEach((c, i) => {
    t += c.ms;
    rows.push({ type: "assistant", uuid: uuid(`${s.key}:a${i}`), timestamp: new Date(t).toISOString(), cwd: s.cwd, sessionId: s.id, version: "2.1.319", message: { id: `msg_${uuid(`${s.key}:m${i}`).slice(0, 12)}`, role: "assistant", model: s.model, content: i === s.llm.length - 1 ? [{ type: "text", text: s.reply }] : [{ type: "text", text: "Working on it." }, { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: "true" } }], usage: { input_tokens: c.in, output_tokens: c.out } } });
    if (i < s.llm.length - 1) {
      t += 1;
      rows.push({ type: "user", uuid: uuid(`${s.key}:r${i}`), timestamp: new Date(t).toISOString(), cwd: s.cwd, sessionId: s.id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "ok" }] } });
    }
  });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { path, end: t };
}

function writeSession(s) {
  const p = pid++;
  const cc = s.agent === "claude-code";
  const base = cc ? { session_id: s.id, transcript_path: undefined } : { session_id: s.id, model: s.model };
  let t = s.start;
  const tr = cc && s.llm.length ? writeTranscript(s, s.start + 10) : undefined;
  if (tr) base.transcript_path = tr.path;
  const L = (event, ts, raw = {}) => spoolLine(s.agent, event, ts, s.cwd, { ...base, ...raw }, p);
  const turn = cc ? {} : { turn_id: uuid(`${s.key}:turn`) };
  L("SessionStart", t, { source: "startup" });
  L("UserPromptSubmit", t + 10, { prompt: s.prompt, ...turn });
  t += 200;
  s.toolTimes = [];
  const tool = (x, i, extra = {}) => {
    const id = `${cc ? "toolu" : "call"}_${uuid(`${s.key}:tool:${i}:${extra.agent_id ?? ""}`).slice(0, 12)}`;
    L("PreToolUse", t, { tool_name: x.name, tool_use_id: id, tool_input: x.input, ...turn, ...extra });
    const end = t + x.ms;
    if (cc) {
      if (x.ok) L("PostToolUse", end, { tool_name: x.name, tool_use_id: id, tool_input: x.input, tool_response: { stdout: "ok" }, duration_ms: x.ms, ...extra });
      else L("PostToolUseFailure", end, { tool_name: x.name, tool_use_id: id, tool_input: x.input, error: x.error ?? "failed", duration_ms: x.ms, ...extra });
    } else {
      L("PostToolUse", end, { tool_name: x.name, tool_use_id: id, tool_input: x.input, tool_response: { exit_code: x.ok ? 0 : 1, output: x.ok ? "ok" : (x.error ?? "failed") }, duration_ms: x.ms, ...turn, ...extra });
    }
    t = end + 300;
  };
  s.tools.forEach((x, i) => tool(x, i));
  s.subagents.forEach((sa, j) => {
    const agentId = `${cc ? "a" : ""}${uuid(`${s.key}:sub:${j}`).slice(0, 16)}`;
    sa.agentId = agentId;
    L("SubagentStart", t, { agent_id: agentId, agent_type: sa.type });
    t += 100;
    sa.tools.forEach((x, i) => tool(x, 1000 + j * 100 + i, { agent_id: agentId }));
    L("SubagentStop", t, { agent_id: agentId, agent_type: sa.type, last_assistant_message: `${sa.type} finished` });
    t += 200;
  });
  if (s.compact) {
    L("PreCompact", t, { trigger: "auto" });
    t += 500;
  }
  t = Math.max(t, (tr?.end ?? 0) + 100);
  L("Stop", t, { last_assistant_message: s.reply, ...turn });
  L("SessionEnd", t + 1000, { reason: "exit" });
  s.end = t + 1000;
}
for (const s of sessions) writeSession(s);

// ---------------------------------------------------------------- wrapper sessions (real `coding.sh run`, then rebased)

const wrapperSessions = [];
function wrapped(key, repo, at0, prompt, file, content) {
  const listing = () => new Set(["wrapper", "claude-code"].flatMap((a) => (existsSync(join(SPOOL, a)) ? readdirSync(join(SPOOL, a)).map((f) => `${a}/${f}`) : [])));
  const before = listing();
  const r = JSON.parse(cli(["run", "--json", "--", process.execPath, join(HERE, "fake-agent.mjs"), "--prompt", prompt, "--write", file, "--content", content], { cwd: REPOS[repo] }).stdout);
  const fresh = [...listing()].filter((f) => !before.has(f));
  // Rebase every line of this run to start at at0, and rename files to the rebased UTC day.
  let first = Infinity;
  const files = fresh.map((f) => ({ f, lines: readFileSync(join(SPOOL, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)) }));
  for (const { lines } of files) for (const l of lines) first = Math.min(first, l.ts);
  let end = at0;
  for (const { f, lines } of files) {
    for (const l of lines) {
      l.ts = at0 + (l.ts - first);
      end = Math.max(end, l.ts);
    }
    const [agent, name] = f.split("/");
    const newName = name.replace(/^\d{4}-\d{2}-\d{2}/, new Date(at0).toISOString().slice(0, 10));
    rmSync(join(SPOOL, f));
    // Append: the wrapper's file is per day (no pid), so two runs rebased to the same UTC day
    // share it (r3 and r2 on a Monday). Runs are created oldest first, so the file stays in order.
    appendFileSync(join(SPOOL, agent, newName), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
  }
  const s = { key, id: r.sessionId, agent: "wrapper", cwd: REPOS[repo], repo, start: at0, end, prompt, tools: [], llm: [], subagents: [], wrapper: true };
  wrapperSessions.push(s);
  return s;
}
wrapped("r3", "calc", at(dayStart(monday0 - DAY / 2), 10), "add a subtract function to calc.mjs", "calc.mjs", "export const add = (a, b) => a - b;\\nexport const sub = (a, b) => a - b;\\n");
run("git", ["checkout", "--", "calc.mjs"], REPOS.calc);
wrapped("r2", "strings", at(yest0, 15), "make slugify lowercase its output", "slug.mjs", 'export const slugify = (s) => s.trim().toLowerCase().replace(/\\s+/g, "-");\\n');
run("git", ["checkout", "--", "slug.mjs"], REPOS.strings);
wrapped("r1", "calc", NOW - 3 * 60e3, "fix the add function in calc.mjs so the tests pass", "calc.mjs", "export const add = (a, b) => a + b;\\n");
run("git", ["checkout", "--", "calc.mjs"], REPOS.calc);

// ---------------------------------------------------------------- ingest through the CLI under test

const ing = cliJson(["ingest"]);
if (ing.spool.errors.length) throw new Error(`fixture: ingest errors: ${JSON.stringify(ing.spool.errors.slice(0, 3))}`);

// ---------------------------------------------------------------- agent configs

writeFileSync(join(FAKEBIN, "codex"), '#!/bin/sh\ncase "$1" in --version|-V) echo "codex-cli 0.166.0";; *) echo "codex stub" >&2; exit 1;; esac\n');
chmodSync(join(FAKEBIN, "codex"), 0o755);
mkdirSync(ENV.CODEX_HOME, { recursive: true });
writeFileSync(join(ENV.CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n\n[features]\nhooks = false\n');
mkdirSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true });
writeFileSync(join(ENV.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2) + "\n");
cli(["init", "--agent", "claude-code", "--yes"]);
cli(["config", "set", "capture.maxInlineBytes", "65536"]);

// ---------------------------------------------------------------- datasets and experiments

cliJson(["dataset", "add", "smoke", "--case", JSON.stringify({ input: "hello", expected: "world" })]);
const arith = [];
for (let i = 0; i < 40; i++) {
  const a = 3 + ((i * 37 + SEED * 11) % 89);
  const b = 5 + ((i * 53 + SEED * 7) % 71);
  arith.push({ input: `${a}+${b}`, expected: String(a + b) });
}
const arithFile = join(R, "arith.jsonl");
writeFileSync(arithFile, arith.map((c) => JSON.stringify(c)).join("\n") + "\n");
cliJson(["dataset", "import", arithFile, "--name", "arith"]);
rmSync(arithFile);
const solver = join(HERE, "solver.mjs");
const accOf = (acc) => arith.filter((c) => createHash("sha256").update(c.input).digest().readUInt32BE(0) % 100 < Math.round(acc * 100)).length / arith.length;
const exps = {};
for (const [name, args] of [
  ["baseline", ["--acc", "0.55"]],
  ["candidate", ["--acc", "0.95"]],
  ["tweak", ["--acc", "0.6"]],
  ["nightly", ["--fail", "error: model endpoint returned 529 overloaded_error"]],
]) {
  // nightly fails on every case. The CLI reads "529 overloaded" as an infrastructure error:
  // without these flags it retries each case and stops the run after 5 in a row, so only 8 of
  // the 40 cases run. `exp run` exits 1 when every run errors, so that exit is expected here.
  const broken = name === "nightly";
  const r = JSON.parse(cli(["exp", "run", "--dataset", "arith", "--name", name, ...(broken ? ["--retries", "0", "--stop-after-infra", "0"] : []), "--task", JSON.stringify({ kind: "command", command: process.execPath, args: [solver, ...args], output: "text" }), "--grader", JSON.stringify({ kind: "exact" }), "--json"], { allowFail: broken }).stdout);
  if (broken && r.experiment.summary.errors !== arith.length) throw new Error(`fixture: nightly should fail on every case, got ${r.experiment.summary.errors} errors in ${arith.length} cases`);
  exps[name] = { id: r.experiment.id, passRate: broken ? 0 : accOf(Number(args[1])) };
}

// ---------------------------------------------------------------- harness bundles

const hb = join(R, "harness", "base");
const hl = join(R, "harness", "lean");
for (const [dir, files] of [
  [hb, { "CLAUDE.md": "# Project rules\n\nRun npm test before you finish.\n", ".claude/settings.json": '{ "permissions": { "allow": ["Bash(npm *)"] } }\n', ".claude/skills/review/SKILL.md": "---\nname: review\n---\nReview the diff.\n", ".claude/agents/reviewer.md": "---\nname: reviewer\n---\nYou review code.\n" }],
  [hl, { "CLAUDE.md": "# Rules\n\nBe brief.\n", ".claude/settings.json": '{ "permissions": { "allow": ["Bash(npm *)"] } }\n', ".mcp.json": '{ "mcpServers": { "docs": { "command": "docs-mcp" } } }\n' }],
]) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}
cliJson(["harness", "snapshot", "--agent", "claude-code", "--dir", hb, "--name", "base"]);
cliJson(["harness", "snapshot", "--agent", "claude-code", "--dir", hl, "--name", "lean"]);
// Bundle file counts come from the CLI (they include user-level files from the fake HOME).
const bundleFiles = Object.fromEntries(cliJson(["harness", "list"]).bundles.map((b) => [b.name, b.files.length]));

// ---------------------------------------------------------------- eval task from r1

const r1 = wrapperSessions.find((s) => s.key === "r1");
const draft = cliJson(["eval", "new", r1.id, "--name", "fix-add", "--verifier", "node test.mjs"]);

// ---------------------------------------------------------------- answers

const all = [...sessions, ...wrapperSessions];
const byKey = Object.fromEntries(all.map((s) => [s.key, s]));
const inRange = (s, from, to = NOW + 1) => s.start >= from && s.start < to;
const top = all; // every spec session is top-level; subagents are children
const nearest = (xs, p) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)] : null;
};
const toolsOf = (s) => [...s.tools, ...s.subagents.flatMap((x) => x.tools)];
const countBy = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});

const yesterday = top.filter((s) => inRange(s, yest0, today0));
const slowest = yesterday.flatMap((s) => toolsOf(s).map((t) => ({ s, t }))).sort((a, b) => b.t.ms - a.t.ms)[0];
const failed = top.map((s) => ({ s, n: toolsOf(s).filter((t) => !t.ok).length })).sort((a, b) => b.n - a.n);
const week = top.filter((s) => inRange(s, week0));
const ccWeekLlm = week.filter((s) => s.agent === "claude-code").flatMap((s) => s.llm.map((c) => c.ms));
const todays = top.filter((s) => inRange(s, today0));
const t1 = byKey.t1;
const sinceMonday = top.filter((s) => inRange(s, monday0) && s.cwd === REPOS.calc);
const subCalls = byKey.y3.subagents.reduce((n, x) => n + x.tools.length, 0);

const answers = {
  v: 1,
  seed: SEED,
  now: NOW,
  paths: { root: R, home: HOME, data: DATA, repos: REPOS, claudeSettings: join(ENV.CLAUDE_CONFIG_DIR, "settings.json"), codexConfig: join(ENV.CODEX_HOME, "config.toml"), work: join(R, "work") },
  env: ENV,
  ids: Object.fromEntries(all.map((s) => [s.key, s.id])),
  slowest: { sessionId: slowest.s.id, tool: slowest.t.name, ms: slowest.t.ms },
  sessionsByAgent7d: countBy(week, (s) => s.agent),
  sessions7d: week.length,
  sessionsYesterday: yesterday.length,
  mostFailed: { sessionId: failed[0].s.id, count: failed[0].n, runnerUp: failed[1].s.id },
  search: { flaky: byKey.y2.id, distractor: byKey.w4.id, changelog: byKey.t3.id },
  llmP95ClaudeWeekMs: nearest(ccWeekLlm, 95),
  llmCallsClaudeWeek: ccWeekLlm.length,
  subagentTypes: { sessionId: byKey.y3.id, types: [...new Set(byKey.y3.subagents.map((x) => x.type))].sort(), count: byKey.y3.subagents.length, toolCalls: subCalls },
  outputTokensToday: todays.reduce((n, s) => n + s.llm.reduce((m, c) => m + c.out, 0), 0),
  compacted: top.filter((s) => s.compact).map((s) => s.id).sort(),
  lastFailure: { sessionId: t1.id, error: "ECONNREFUSED 127.0.0.1:5432" },
  durationSec: { sessionId: byKey.y2.id, sec: Math.round((byKey.y2.end - byKey.y2.start) / 1000) },
  latest: { sessionId: [...top].sort((a, b) => b.start - a.start)[0].id, prompt: [...top].sort((a, b) => b.start - a.start)[0].prompt },
  repoSessions: { repo: REPOS.calc, since: new Date(monday0).toISOString(), ids: sinceMonday.map((s) => s.id).sort(), excluded: top.filter((s) => s.cwd === REPOS.calc && !inRange(s, monday0)).map((s) => s.id) },
  evalSource: byKey.r2.id,
  task: { id: draft.task.id, name: "fix-add", sourceSessionId: r1.id },
  experiments: exps,
  compare: { baseline: "baseline", candidate: "candidate", better: "candidate", significant: true, tweakSignificant: false },
  failedRun: { experiment: "nightly", id: exps.nightly.id, reason: "529 overloaded_error" },
  datasets: { arith: arith.length, smoke: 1 },
  bundles: { files: bundleFiles, onlyBase: [".claude/agents/reviewer.md", ".claude/skills/review/SKILL.md"], onlyLean: [".mcp.json"], both: [".claude/settings.json", "CLAUDE.md"] },
  otel: { endpoint: "http://127.0.0.1:4318", vars: ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "CLAUDE_CODE_ENABLE_TELEMETRY"] },
  config: { maxInlineBytes: 65536 },
  doctor: { agent: "codex", reason: "codex-not-hooked" },
  // Held-out helpers.
  failedByRepo7d: Object.entries(week.reduce((m, s) => ((m[s.repo] = (m[s.repo] ?? 0) + toolsOf(s).filter((t) => !t.ok).length), m), {})).sort((a, b) => b[1] - a[1])[0],
  slowestLlmYesterday: (() => {
    const c = yesterday.flatMap((s) => s.llm.map((x) => ({ s, ms: x.ms }))).sort((a, b) => b.ms - a.ms)[0];
    return { sessionId: c.s.id, ms: c.ms };
  })(),
  subagentsYesterday: yesterday.reduce((n, s) => n + s.subagents.length, 0),
  medianDurationWeek: Object.fromEntries(
    ["claude-code", "codex"].map((a) => {
      const d = week.filter((s) => s.agent === a).map((s) => s.end - s.start).sort((x, y) => x - y);
      const m = d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
      return [a, m];
    }),
  ),
  mostLlmTime: (() => {
    const s = [...top].sort((a, b) => b.llm.reduce((n, c) => n + c.ms, 0) - a.llm.reduce((n, c) => n + c.ms, 0))[0];
    return { sessionId: s.id, ms: s.llm.reduce((n, c) => n + c.ms, 0) };
  })(),
  failedFraction7d: (() => {
    const ts = week.flatMap(toolsOf);
    return ts.filter((t) => !t.ok).length / ts.length;
  })(),
  medianDurationClaudeWeekSec: null,
  repeatedFailureSessions: top.filter((s) => {
    let run = 0;
    for (const t of toolsOf(s)) {
      run = t.ok ? 0 : run + 1;
      if (run >= 3) return true;
    }
    return false;
  }).map((s) => s.id),
};
answers.medianDurationClaudeWeekSec = answers.medianDurationWeek["claude-code"] / 1000;
mkdirSync(dirname(ANSWERS), { recursive: true });
writeFileSync(ANSWERS, JSON.stringify(answers, null, 2) + "\n");
process.stdout.write(JSON.stringify({ ok: true, root: R, answers: ANSWERS, sessions: all.length, events: ing.spool.events }) + "\n");
