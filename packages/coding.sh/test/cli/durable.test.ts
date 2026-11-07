// Durable long runs, end to end: spawn the CLI with a stub agent, kill it mid-run
// (SIGKILL, SIGINT, SIGINT twice), resume, and compare with a run that was never
// interrupted. Also: a changed config refuses to resume, `exp status --json`
// shows progress and cost, infra errors are retried and task failures are not,
// and `bench run --resume` picks up after a SIGKILL.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let home = "";
let env: NodeJS.ProcessEnv = {};
const N = 8;

// Stub agent: logs its pid, sleeps DELAY ms, answers uppercase (wrong for every third input),
// reports a cost. With FLAKY_DIR, the first call per case-trial is rate limited; MODE=crash exits 3.
const AGENT = `import {appendFileSync, existsSync, writeFileSync} from "node:fs";
appendFileSync(process.env.PID_FILE, process.pid + "\\n");
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => setTimeout(() => {
  const q = JSON.parse(s).q;
  const mark = process.env.FLAKY_DIR && process.env.FLAKY_DIR + "/" + process.env.CODING_SH_CASE_ID + "-" + process.env.CODING_SH_TRIAL;
  if (mark && !existsSync(mark)) { writeFileSync(mark, "1"); process.stderr.write("HTTP 429 Too Many Requests\\n"); process.exit(1); }
  if (process.env.MODE === "crash") { process.stderr.write("boom\\n"); process.exit(3); }
  const wrong = Number(q.slice(1)) % 3 === 0;
  process.stdout.write(JSON.stringify({ answer: wrong ? "nope" : q.toUpperCase(), costUsd: 0.01 }));
}, Number(process.env.DELAY || 0)));
`;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-durable-")));
  home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "tmp"));
  env = {
    HOME: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_RETRY_BASE_MS: "0",
  };
  const cases = [];
  for (let i = 1; i <= N; i++) cases.push("--case", JSON.stringify({ input: { q: `q${i}` }, expected: `Q${i}` }));
  const add = cli(["dataset", "add", "ds", ...cases]);
  assert.equal(add.status, 0, add.stderr);
  writeFileSync(join(home, "agent.mjs"), AGENT);
});
after(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...env, ...extra }, cwd: home, encoding: "utf8", timeout: 120_000 });
}
const GRADER = '{"kind":"json-path","path":"$.answer"}';
const task = (o: { delay: number; pids: string; agent?: string; flaky?: string; mode?: string }) =>
  JSON.stringify({
    kind: "command",
    command: process.execPath,
    args: [o.agent ?? join(home, "agent.mjs")],
    env: { DELAY: String(o.delay), PID_FILE: o.pids, ...(o.flaky ? { FLAKY_DIR: o.flaky } : {}), ...(o.mode ? { MODE: o.mode } : {}) },
    timeoutMs: 0,
  });
/** The pid file is part of the task spec, so give every config its own and keep `pids` out of the comparison. */
const runArgs = (t: string, more: string[] = []) => ["exp", "run", "-d", "ds", "--task", t, "-g", GRADER, "--trials", "2", "--json", ...more];
const pidsIn = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
type Exp = { id: string; status?: string; runs: { caseId: string; trial: number; pass: boolean; output?: unknown; attempts?: number; error?: string }[]; summary: { passed: number; n: number; passRate: unknown } };
const shape = (e: Exp) => e.runs.map((r) => [r.caseId, r.trial, r.pass, JSON.stringify(r.output)]).sort();

/** Spawn `args`; once `pids` lists `afterAgents` agents, send each signal in `sigs` (`gapMs` apart); wait for exit. */
async function interrupt(args: string[], pids: string, sigs: NodeJS.Signals[], afterAgents: number, gapMs = 150, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...env, ...extra }, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exit = new Promise<number | null>((r) => child.on("close", (code, signal) => r(code ?? (signal ? -1 : null))));
  const deadline = Date.now() + 30_000;
  while (pidsIn(pids).length < afterAgents && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  for (const [i, s] of sigs.entries()) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    child.kill(s);
  }
  const code = await exit;
  return { code, stdout, stderr };
}
type Status = { id: string; kind: string; status: string; done: number; total: number; infra: number; retries: number; costUsd: number | null; etaMs: number | null; resume: string | null; records: string[] };
const statusOf = (ref: string) => {
  const r = cli(["exp", "status", ref, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as { run: Status }).run;
};

describe("durable exp run", { skip: process.platform === "win32" && "signals sent with process.kill can't be caught on Windows" }, () => {
  it("SIGKILL mid-run, then --resume: re-runs only the unfinished trials and matches an uninterrupted run", async () => {
    const fullPids = join(root, "full.pids");
    const full = cli(runArgs(task({ delay: 0, pids: fullPids })));
    assert.equal(full.status, 0, full.stderr);
    const want = JSON.parse(full.stdout).experiment as Exp;
    assert.equal(want.runs.length, 2 * N);

    const pids = join(root, "kill.pids");
    const t = task({ delay: 150, pids });
    const killed = await interrupt([...runArgs(t), "--concurrency", "2"], pids, ["SIGKILL"], 7);
    assert.equal(killed.code, -1, "killed outright: no handler ran");
    const list = JSON.parse(cli(["exp", "status", "--json"]).stdout) as { runs: Status[] };
    const job = list.runs.find((r) => r.kind === "exp run" && r.status === "interrupted")!;
    assert.ok(job, "the killed run is listed as interrupted");
    assert.ok(job.done >= 4 && job.done < 2 * N, `finished trials were checkpointed (${job.done})`);
    assert.equal(job.total, 2 * N);
    assert.match(job.resume!, /--resume exp_/);
    const before = pidsIn(pids).length;

    // The same command again offers the unfinished run (non-interactive: a note) and starts fresh unless --resume.
    const resumed = cli(runArgs(t, ["--resume"]));
    assert.equal(resumed.status, 0, resumed.stderr);
    const got = JSON.parse(resumed.stdout).experiment as Exp;
    assert.equal(got.id, job.id, "the resumed run keeps its id");
    assert.equal(pidsIn(pids).length - before, 2 * N - job.done, "only unfinished trials ran again");
    assert.deepEqual(shape(got), shape(want));
    assert.deepEqual(got.summary.passRate, want.summary.passRate);
    assert.equal(statusOf(job.id).status, "completed");
    const again = cli(runArgs(t, ["--resume", job.id]));
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already finished/);
  });

  it("first Ctrl-C lets the trials in flight finish and keeps them; --resume completes the run", async () => {
    const pids = join(root, "int.pids");
    const t = task({ delay: 700, pids });
    const r = await interrupt([...runArgs(t), "--concurrency", "2"], pids, ["SIGINT"], 2);
    assert.equal(r.code, 130);
    assert.match(r.stderr, /Finishing the trials in flight/);
    assert.equal(JSON.parse(r.stdout).outcome, "cancelled");
    const id = (JSON.parse(r.stdout).experiment as Exp).id;
    const st = statusOf(id);
    assert.equal(st.status, "interrupted");
    // Every agent that started finished and was kept: none was killed.
    assert.equal(st.done, pidsIn(pids).length, "in-flight trials finished and were saved");
    assert.match(JSON.parse(r.stdout).resume, new RegExp(`^coding\\.sh exp run .*--resume ${id}$`));
    const done = cli(runArgs(t, ["--resume", id]));
    assert.equal(done.status, 0, done.stderr);
    assert.equal((JSON.parse(done.stdout).experiment as Exp).runs.length, 2 * N);
  });

  it("a second Ctrl-C stops the trials in flight at once", async () => {
    const pids = join(root, "twice.pids");
    const t0 = Date.now();
    const r = await interrupt(runArgs(task({ delay: 30_000, pids }), ["--concurrency", "1"]), pids, ["SIGINT", "SIGINT"], 1);
    assert.equal(r.code, 130);
    assert.ok(Date.now() - t0 < 20_000, "did not wait for the 30 s agent");
    for (const pid of pidsIn(pids)) assert.equal(alive(pid), false, `agent ${pid} killed`);
    assert.equal(JSON.parse(r.stdout).outcome, "cancelled");
  });

  it("a changed config refuses to resume and says what changed", async () => {
    const agent = join(home, "agent-edit.mjs");
    writeFileSync(agent, AGENT);
    const pids = join(root, "edit.pids");
    const t = task({ delay: 300, pids, agent });
    const r = await interrupt(runArgs(t, ["--concurrency", "1"]), pids, ["SIGKILL"], 3);
    assert.equal(r.code, -1);
    const id = (JSON.parse(cli(["exp", "status", "--json"]).stdout) as { runs: Status[] }).runs.find((x) => x.status === "interrupted")!.id;
    writeFileSync(agent, AGENT + "\n// edited\n");
    const refused = cli(runArgs(t, ["--resume", id]));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`Can't resume ${id}: its config changed since it started \\(task\\)`));
    const trials = cli(runArgs(t, ["--resume", id, "--trials", "3"]));
    assert.match(trials.stderr, /config changed since it started \(task, trials\)/);
    const bare = cli(runArgs(t, ["--resume"]));
    assert.match(bare.stderr, /config changed since it started \(task\)/);
  });

  it("exp status --json: progress, cost so far and the resume command", async () => {
    const pids = join(root, "status.pids");
    const r = await interrupt(runArgs(task({ delay: 200, pids }), ["--concurrency", "2"]), pids, ["SIGINT"], 4);
    assert.equal(r.code, 130);
    const id = (JSON.parse(r.stdout).experiment as Exp).id;
    const st = statusOf(id);
    assert.equal(st.kind, "exp run");
    assert.equal(st.total, 2 * N);
    assert.ok(st.done > 0 && st.done < 2 * N);
    assert.ok(Math.abs(st.costUsd! - st.done * 0.01) < 1e-9, "cost so far: $0.01 per finished trial");
    assert.equal(st.etaMs, null, "no ETA while nothing runs");
    assert.deepEqual(st.records, [id]);
    assert.match(st.resume!, new RegExp(`--resume ${id}$`));
    const text = cli(["exp", "status"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`${id}\\texp run\\t.*\\tinterrupted\\t${st.done}/${2 * N}`));
  });

  it("rate limits are retried with backoff and counted; a crash is never retried", async () => {
    const flaky = join(root, "flaky");
    mkdirSync(flaky);
    const ok = cli(runArgs(task({ delay: 0, pids: join(root, "flaky.pids"), flaky })));
    assert.equal(ok.status, 0, ok.stderr);
    const e = JSON.parse(ok.stdout).experiment as Exp;
    assert.ok(e.runs.every((x) => x.attempts === 2 && !x.error), "each case-trial took one retry and then answered");
    assert.equal(e.summary.n, 2 * N);

    const crashPids = join(root, "crash.pids");
    const bad = cli(runArgs(task({ delay: 0, pids: crashPids, mode: "crash" })));
    const c = JSON.parse(bad.stdout).experiment as Exp;
    assert.equal(pidsIn(crashPids).length, 2 * N, "one call per case-trial: failures are not retried");
    assert.ok(c.runs.every((x) => x.attempts === undefined && /exited 3/.test(x.error ?? "")));

    // Retries exhausted: the trial is infra (outcome unknown), the job incomplete, and --resume runs it again.
    const down = join(root, "down.mjs");
    writeFileSync(down, `process.stderr.write("HTTP 503 Service Unavailable\\n"); process.exit(1);\n`);
    const out = cli(["exp", "run", "-d", "ds", "--task", JSON.stringify({ kind: "command", command: process.execPath, args: [down] }), "-g", GRADER, "--retries", "1", "--json"]);
    const d = JSON.parse(out.stdout).experiment as Exp & { summary: { infra?: number } };
    assert.equal(d.summary.infra, N);
    assert.ok(d.runs.every((x) => x.attempts === 2));
    const st = statusOf(d.id);
    assert.equal(st.status, "incomplete");
    assert.equal(st.infra, N);
    assert.match(JSON.parse(out.stdout).resume, new RegExp(`--resume ${d.id}$`));
    const text = cli(["exp", "run", "-d", "ds", "--task", JSON.stringify({ kind: "command", command: process.execPath, args: [down] }), "-g", GRADER, "--retries", "0"]);
    assert.match(text.stderr, /still hit infrastructure errors after retries; finished trials are saved\. Continue with: coding\.sh exp run .*--resume exp_/);
    assert.match(text.stdout, /infra \d+ run\(s\) still hit a rate limit, 5xx or network error after retries/);
  });
});

describe("durable bench run", { skip: process.platform === "win32" && "SIGKILL semantics differ on Windows" }, () => {
  it("SIGKILL mid-run, then bench run --resume: same cells as an uninterrupted run with the same seed", async () => {
    const dir = join(root, "bench-proj");
    mkdirSync(join(dir, "bench"), { recursive: true });
    writeFileSync(join(dir, "gen.mjs"), `for (let i = 0; i < 20; i++) console.log(JSON.stringify({ input: { a: i, b: 2 * i }, expected: 3 * i }));\n`);
    const slow = (off: number) =>
      `const i = JSON.parse(require("fs").readFileSync(0, "utf8")); require("fs").appendFileSync(process.env.BENCH_PIDS, process.pid + "\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BENCH_DELAY || 0)); process.stdout.write(JSON.stringify({ output: i.a + i.b + (i.a % ${off} === 0 ? 1 : 0), usage: { costUsd: 0.001 } }));\n`;
    writeFileSync(join(dir, "fast.cjs"), slow(1000));
    writeFileSync(join(dir, "big.cjs"), slow(3));
    writeFileSync(
      join(dir, "bench", "sums.toml"),
      `name = "sums"\ncases = 8\nconcurrency = 2\n[source]\nkind = "command"\ncommand = "node gen.mjs"\n[[contenders]]\nname = "fast"\ncommand = "node fast.cjs"\n[[contenders]]\nname = "big"\ncommand = "node big.cjs"\n[[graders]]\nkind = "exact"\n`,
    );
    const benv = { ...env, PATH: process.env.PATH };
    const run = (args: string[], extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...benv, ...extra }, cwd: dir, encoding: "utf8", timeout: 120_000 });
    const full = run(["bench", "run", "sums", "--seed", "s1", "--json"], { BENCH_PIDS: join(root, "bench-full.pids"), BENCH_DELAY: "0" });
    assert.equal(full.status, 0, full.stderr);
    type Cell = { caseId: string; contender: string; trial: number; pass: boolean; output?: string };
    // --json on run prints a cell count; show --cases has the cells.
    const cells = (j: string) => {
      const id = (JSON.parse(j) as { run: { id: string } }).run.id;
      const shown = run(["bench", "show", "sums", "--run", id, "--cases", "--json"], {});
      assert.equal(shown.status, 0, shown.stderr);
      return (JSON.parse(shown.stdout) as { run: { id: string; cells: Cell[] } }).run;
    };
    const want = cells(full.stdout).cells.map((x) => [x.caseId, x.contender, x.trial, x.pass, x.output]).sort();
    assert.equal(want.length, 16);

    const pids = join(root, "bench-kill.pids");
    const child = spawn(process.execPath, ["--no-warnings", CLI, "bench", "run", "sums", "--seed", "s1", "--json"], { env: { ...benv, BENCH_PIDS: pids, BENCH_DELAY: "250" }, cwd: dir, stdio: "ignore" });
    const closed = new Promise((r) => child.on("close", r));
    const deadline = Date.now() + 30_000;
    while (pidsIn(pids).length < 7 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    child.kill("SIGKILL");
    await closed;
    const before = pidsIn(pids).length;
    const resumed = run(["bench", "run", "sums", "--resume", "--json"], { BENCH_PIDS: pids, BENCH_DELAY: "0" });
    assert.equal(resumed.status, 0, resumed.stderr);
    const got = cells(resumed.stdout);
    assert.deepEqual(got.cells.map((x) => [x.caseId, x.contender, x.trial, x.pass, x.output]).sort(), want);
    assert.ok(pidsIn(pids).length - before <= 16 - 4, `only unfinished calls ran again (${pidsIn(pids).length - before})`);
    const st = statusOf(got.id);
    assert.equal(st.kind, "bench run");
    assert.equal(st.status, "completed");
  });
});
