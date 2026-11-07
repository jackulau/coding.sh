#!/usr/bin/env node
// Experiment sessions and `exp run --watch`, end to end against a local stub
// model: a command agent that asks the model (its system prompt is prompt.md)
// and an LLM judge, both answered by the stub. Under a throwaway HOME:
//
//   exp session new + note, then exp run twice (the second from a subfolder)
//     -> the second prints its delta: 0% -> 100%, fixed 4, equal to exp compare
//   exp run --watch
//     -> a rubric-only edit regrades the stored outputs: 0 agent calls
//     -> three rapid saves of prompt.md give one rerun
//     -> a save while a run is in flight aborts it, and nothing partial is stored
//     -> a broken spec is reported and watching goes on; Ctrl-C exits 0
//   exp session summary --json rebuilds the history, notes included
//
// The stub plays two parts:
//   the agent (system prompt starts "AGENT:"): answers the question in capitals
//     when the prompt says SHOUT, else as given; sleeps first when it says SLOW;
//   the judge ("You are a strict..."): passes an all-caps answer, and with
//     NO-BETA in the rubric fails an answer that says BETA.
//
//   node scripts/e2e/exp-session-watch.mjs [--keep]
//
// Runs coding.sh from source (Node 24 strips the types). No network. Never
// touches the real HOME. Exit 0 when every check passed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO, "packages", "coding.sh", "src", "cli", "main.ts");
const isWin = process.platform === "win32";
const keep = process.argv.includes("--keep");
const QUESTIONS = ["alpha", "beta", "gamma", "delta"];

const log = (...a) => console.log("[exp-session-watch]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

// ------------------------------------------------------------------ the stub's parts

const counts = { agent: 0, judge: 0 };
const systemText = (body) => (typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text ?? "").join("\n") : "");
const userText = (body) => body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function scenario(body) {
  if (!Array.isArray(body.messages)) return undefined;
  const sys = systemText(body);
  if (sys.startsWith("AGENT:")) {
    counts.agent++;
    const q = userText(body).trim();
    return { text: sys.includes("SHOUT") ? q.toUpperCase() : q };
  }
  if (sys.startsWith("You are a strict")) {
    counts.judge++;
    const prompt = userText(body);
    const output = (/<output>([\s\S]*?)<\/output>/.exec(prompt)?.[1] ?? "").trim();
    let pass = output.length > 0 && output === output.toUpperCase();
    if (prompt.includes("NO-BETA") && output.includes("BETA")) pass = false;
    return { text: JSON.stringify({ score: pass ? 1 : 0, pass, confidence: 0.9, reason: pass ? "all caps" : "not all caps", citations: [] }) };
  }
  return { text: "ok" };
}

// The agent: case input {q} on stdin, prompt.md as the system prompt, the model's text on stdout.
const AGENT = `import { readFileSync } from "node:fs";
let s = "";
for await (const c of process.stdin) s += c;
const q = JSON.parse(s).q;
const system = "AGENT: " + readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
if (system.includes("SLOW")) await new Promise((r) => setTimeout(r, 4000));
const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "sk-stub", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "stub-model", max_tokens: 64, system, messages: [{ role: "user", content: q }] }),
});
const j = await res.json();
process.stdout.write(j.content.map((c) => c.text ?? "").join(""));
`;

// ------------------------------------------------------------------ main

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-expsess-"));
const home = join(root, "home");
const proj = join(root, "proj");
mkdirSync(join(proj, "sub"), { recursive: true });
mkdirSync(home, { recursive: true });
const stub = await startStub({ decide: scenario });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODING_SH)/i.test(k)) env[k] = v;
Object.assign(env, { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1", ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-stub" });
// Async: the stub answers from this process, so a blocking spawnSync would starve it.
const cli = (args, cwd = proj) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
const json = (r, what) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}: not JSON (exit ${r.status}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
  }
};
const RUBRIC = "Pass when the answer is in capital letters.";
const spec = (rubric) => ({
  name: "shout",
  dataset: "qa",
  // absolute: the command runs where `exp run` runs, which is a subfolder once
  task: { kind: "command", command: process.execPath, args: [join(proj, "agent.mjs")], timeoutMs: 60_000 },
  graders: [{ kind: "llm", name: "caps", provider: "anthropic", model: "stub-model", baseURL: stub.url, rubric }],
  watch: ["prompt.md"],
});
const writeSpec = (rubric) => writeFileSync(join(proj, "spec.json"), `${JSON.stringify(spec(rubric), null, 2)}\n`);
const experiments = async () => json(await cli(["exp", "list", "--limit", "100", "--json"]), "exp list").experiments;

log(`temp root ${root}`);
log(`stub model on ${stub.url}`);
let exitCode = 0;
try {
  writeFileSync(join(proj, "agent.mjs"), AGENT);
  writeFileSync(join(proj, "prompt.md"), "Answer with the word you are given.\n");
  writeSpec(RUBRIC);
  const add = await cli(["dataset", "add", "qa", ...QUESTIONS.flatMap((q) => ["--case", JSON.stringify({ id: q, input: { q } })])]);
  check(add.status === 0, "dataset add qa", add.stderr);

  // 1. A session, a note, then two runs: the second (from a subfolder) prints its delta.
  const made = json(await cli(["exp", "session", "new", "--name", "shout", "--json"]), "session new");
  check(/^xs_/.test(made.session?.id ?? ""), "exp session new", made);
  check(readFileSync(join(proj, ".coding-sh", ".gitignore"), "utf8") === "*\n", "the session folder is kept out of git");
  check((await cli(["exp", "session", "note", "hypothesis: SHOUT in the prompt makes every answer pass"])).status === 0, "exp session note");
  const r1 = json(await cli(["exp", "run", "spec.json", "--json"]), "exp run 1");
  check(r1.experiment?.summary?.passed === 0 && r1.session?.id === made.session.id && r1.session.block.delta === undefined, "run 1: 0/4, joins the session, no delta yet", r1.session);
  writeFileSync(join(proj, "prompt.md"), "SHOUT: answer with the word you are given.\n");
  const r2 = await cli(["exp", "run", "../spec.json"], join(proj, "sub"));
  log(`exp run 2:\n${r2.stdout}`);
  check(r2.status === 0, "run 2 from a subfolder exits 0", r2.stderr);
  check(/^session shout: vs exp_\w+ {2}changed prompt\.md$/m.test(r2.stdout), "run 2: delta header names the change", r2.stdout);
  check(/^pass {4}0\.0% → 100\.0% {2}Δ \+100\.0pp \[/m.test(r2.stdout), "run 2: 0% -> 100%", r2.stdout);
  check(/^fixed {3}4: /m.test(r2.stdout) && /^broke {3}—$/m.test(r2.stdout), "run 2: fixed 4, broke none");
  const id2 = /^(exp_\w+)$/m.exec(r2.stdout)?.[1];
  const cmp = json(await cli(["exp", "compare", r1.experiment.id, id2, "--json"]), "exp compare").comparison;
  check(/Δ \+100\.0pp \[\+100\.0pp, \+100\.0pp\]/.test(r2.stdout) && cmp.diff.mean === 1 && cmp.diff.lo === 1, "run 2: the delta equals exp compare", cmp.diff);

  // 2. --watch (no SIGINT to a child on Windows).
  if (!isWin) {
    const child = spawn(process.execPath, ["--no-warnings", CLI, "exp", "run", "spec.json", "--watch"], { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const closed = new Promise((done) => child.on("close", done));
    const lines = (re) => out.split("\n").filter((l) => re.test(l));
    const until = async (cond, ms = 90_000) => {
      for (let t = 0; t < ms && !cond(); t += 100) await new Promise((r) => setTimeout(r, 100));
      return cond();
    };
    const runLine = /^\d\d:\d\d:\d\d {2}run {5}exp_\w+ {2}pass /;
    const regradeLine = /^\d\d:\d\d:\d\d {2}regrade exp_\w+ {2}pass /;
    check(await until(() => /Watching .*in session shout/.test(out)), "watch: starts in the session", out);
    check(await until(() => lines(runLine).length === 1), "watch: the first run", out);
    check(/pass 100\.0% \(4\/4\)/.test(lines(runLine)[0] ?? ""), "watch: first run 4/4", lines(runLine));

    // a. A rubric-only edit: regrade the stored outputs, no agent call.
    let agent = counts.agent;
    const judge = counts.judge;
    writeSpec(`${RUBRIC} NO-BETA: fail an answer that says BETA.`);
    check(await until(() => lines(regradeLine).length === 1), "watch: a rubric edit regrades", out);
    check(/pass 75\.0% \(3\/4\) {2}regrade of exp_\w+, 0 task calls/.test(lines(regradeLine)[0] ?? ""), "watch: regrade 3/4, 0 task calls", lines(regradeLine));
    check(counts.agent === agent && counts.judge - judge === 4, "watch: the regrade asked the judge 4 times and the agent never", { agent: counts.agent - agent, judge: counts.judge - judge });
    check(/broke {3}1: beta/.test(out), "watch: the regrade's delta names the flipped case");

    // b. Three rapid saves: one rerun.
    agent = counts.agent;
    for (const n of [1, 2, 3]) writeFileSync(join(proj, "prompt.md"), `SHOUT: answer with the word you are given (${n}).\n`);
    check(await until(() => lines(runLine).length === 2), "watch: three rapid saves rerun", out);
    await new Promise((r) => setTimeout(r, 1500));
    check(lines(runLine).length === 2 && counts.agent - agent === 4, "watch: exactly one rerun (4 agent calls)", { runs: lines(runLine).length, agent: counts.agent - agent });

    // c. A save while a run is in flight: it is aborted and not stored.
    const stored = (await experiments()).length;
    agent = counts.agent;
    writeFileSync(join(proj, "prompt.md"), "SHOUT SLOW: answer with the word you are given.\n");
    await new Promise((r) => setTimeout(r, 1500)); // past the debounce: the agents are asleep, mid-run
    writeFileSync(join(proj, "prompt.md"), "SHOUT: answer with the word you are given (final).\n");
    check(await until(() => lines(runLine).length === 3), "watch: the save after it reruns", out);
    await new Promise((r) => setTimeout(r, 4000)); // long enough for a surviving slow agent to call
    check(counts.agent - agent === 4, "watch: the aborted run's agents never reached the model", counts.agent - agent);
    const after = await experiments();
    check(after.length === stored + 1 && after.every((e) => e.status !== "cancelled"), "watch: only the finished run was stored, nothing partial", { before: stored, after: after.length });

    // d. A broken spec is reported, and watching goes on.
    writeFileSync(join(proj, "spec.json"), "{ not json");
    check(await until(() => /spec\.json/.test(out.split("\n").filter((l) => l.startsWith("!")).join("\n"))), "watch: a broken spec is reported", out.slice(-2000));
    writeSpec(`${RUBRIC} NO-BETA: fail an answer that says BETA.`);
    await new Promise((r) => setTimeout(r, 1000));
    check(child.exitCode === null, "watch: still watching after the broken spec");
    log(`exp run --watch:\n${out}`);
    child.kill("SIGINT");
    check((await closed) === 0, "watch: Ctrl-C exits 0", out.slice(-2000));
  }

  // 3. The summary rebuilds the history.
  const sum = json(await cli(["exp", "session", "summary", "--json"], join(proj, "sub")), "session summary");
  const modes = sum.blocks.filter((b) => b.kind === "experiment").map((b) => b.mode);
  log(`summary modes: ${modes.join(" ")}`);
  check(sum.session?.name === "shout" && sum.blocks[0]?.kind === "note", "summary: the session and the note first", sum.session);
  check(isWin ? modes.join(" ") === "run run" : modes.join(" ") === "run run run regrade run run", "summary: run run, then watch's run regrade run run", modes);
  const text = await cli(["exp", "session", "summary"]);
  log(`exp session summary:\n${text.stdout}`);
  check(/note {2}hypothesis: SHOUT/.test(text.stdout) && /fixed 4 broke 0/.test(text.stdout), "summary text: the note and the delta");
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
