// Child supervision across every spawn helper: settle on exit (EXP-5), abort
// through an explicit or ambient signal, and SIGKILL of live groups on
// process exit (EXP-2). The commands are node scripts, so the pids they report
// are real OS pids on Windows too (an MSYS shell's $$ and $! are not).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runHeadless } from "../../src/adapters/_shared/run.ts";
import { spawnAgent } from "../../src/adapters/more/_util.ts";
import { liveChildCount, withAbortSignal } from "../../src/core/children.ts";
import { runProcess } from "../../src/graders/proc.ts";
import { sh } from "../../src/runner/exec.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 20));
};
/**
 * Whether `pid` is gone within 15 s. A killed process is not gone at once: it still has to be
 * scheduled to die and be reaped, which the full suite's load can stretch to seconds. A process
 * that is gone returns at once, and one that was never killed lives for SLEEPER_MS.
 */
const gone = async (pid: number) => {
  const end = Date.now() + 15_000;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
};
/**
 * Script line that writes `pid` (a JS expression) to `pidFile` in one step. A plain
 * writeFileSync creates the file before it writes it: a kill in between leaves it empty,
 * Number("") is 0, and kill(0, 0) signals our own process group, so the sleeper looks alive.
 */
const writePid = (pidFile: string, pid: string) =>
  `require("node:fs").writeFileSync(${JSON.stringify(pidFile + ".tmp")}, String(${pid})); require("node:fs").renameSync(${JSON.stringify(pidFile + ".tmp")}, ${JSON.stringify(pidFile)});`;

const root = mkdtempSync(join(tmpdir(), "codingsh-children-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
/** Writes a CommonJS node script and returns its path. */
function script(js: string): string {
  const p = join(root, `s${seq++}.cjs`);
  writeFileSync(p, js);
  return p;
}
/** How long a sleeper lives. The bugs these tests catch wait for a sleeper or a 60 s timeout, so they cost at least this long. */
const SLEEPER_MS = 60_000;
/** Script lines that start a sleeper sharing our stdout (`c`) and record its pid in `pidFile`. */
const sleeper = (pidFile: string) => `
const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${SLEEPER_MS})"], { stdio: ["ignore", "inherit", "inherit"] });
${writePid(pidFile, "c.pid")}
`;
/** `node <file>` as a sh command line. */
const nodeLine = (file: string) => `'${process.execPath}' '${file}'`;

type Run = (file: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>;
/**
 * The time a run may take to settle on exit or after an abort: 3x what the same helper takes to
 * run a script that only prints, measured just before (node's start on this machine, now), at
 * least 2.5 s and at most half a sleeper's life. Idle, that is the old fixed 2.5 s. Under the full
 * suite on Windows a node start alone can take a second or more, and the fixed 2.5 s failed once
 * per helper. The bugs wait for a sleeper or the timeout, so they still miss it by tens of seconds.
 */
const budgetFor = async (run: Run) => {
  const t0 = Date.now();
  const r = await run(script(`console.log("started");\n`), 0);
  assert.equal(r.exitCode, 0);
  return Math.min(SLEEPER_MS / 2, Math.max(2500, 3 * (Date.now() - t0)));
};
/**
 * Asserts a run settled within `budget` (from budgetFor, before the run), or within a budget
 * measured again now when it took longer: the load can rise while a test runs.
 */
const settledWithin = async (run: Run, ms: number, budget: number, what: string) => {
  const b = ms < budget ? budget : Math.max(budget, await budgetFor(run));
  assert.ok(ms < b, `${what} ${ms}ms, budget ${b}ms`);
};

/** Each helper runs `node <script>` (sh through the POSIX shell) and reports exit code, timeout and stdout. */
const helpers: Record<string, Run> = {
  sh: async (file, timeoutMs, signal) => {
    const r = await sh(nodeLine(file), { cwd: process.cwd(), timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdoutTail };
  },
  runProcess: async (file, timeoutMs, signal) => {
    const r = await runProcess({ command: process.execPath, args: [file], timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout };
  },
  runHeadless: async (file, timeoutMs, signal) => {
    const r = await runHeadless({ bin: process.execPath, args: [file], cwd: process.cwd(), env: process.env, timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdoutTail };
  },
  spawnAgent: async (file, timeoutMs, signal) => {
    const r = await spawnAgent({ bin: process.execPath, args: [file], cwd: process.cwd(), env: process.env, timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdoutTail };
  },
};

for (const [name, run] of Object.entries(helpers)) {
  describe(`${name} supervision`, () => {
    it("settles on exit with the real code when a background child holds stdout, and reaps it", async () => {
      for (const timeoutMs of [5000, 0]) {
        const pidFile = join(root, `bg-${seq++}`);
        const budget = await budgetFor(run);
        const t0 = Date.now();
        const r = await run(script(`${sleeper(pidFile)}c.unref();\nconsole.log("tests passed");\n`), timeoutMs);
        await settledWithin(run, Date.now() - t0, budget, `settled (timeoutMs ${timeoutMs}) in`);
        assert.equal(r.exitCode, 0);
        assert.equal(r.timedOut, false);
        assert.match(r.stdout, /tests passed/);
        // POSIX: the group kill on exit. Windows has no groups; there the sleeper, a node
        // child, dies with its parent through libuv's kill-on-close job object.
        assert.equal(await gone(Number(readFileSync(pidFile, "utf8"))), true, "background child reaped");
      }
    });

    it("an explicit abort kills the process group promptly", async () => {
      const pidFile = join(root, `abort-${seq++}`);
      const budget = await budgetFor(run);
      const ac = new AbortController();
      const p = run(script(sleeper(pidFile)), 60_000, ac.signal);
      await until(() => existsSync(pidFile));
      // Timed from the abort: how fast the kill lands, not how long node took to start.
      const t0 = Date.now();
      ac.abort();
      const r = await p;
      await settledWithin(run, Date.now() - t0, budget, "settled after the abort in");
      assert.equal(r.exitCode, null);
      assert.equal(r.timedOut, false);
      assert.equal(await gone(Number(readFileSync(pidFile, "utf8"))), true);
    });

    it("the ambient signal reaches spawns that take no signal", async () => {
      const budget = await budgetFor(run);
      const ac = new AbortController();
      let t0 = 0;
      const p = withAbortSignal(ac.signal, () => run(script(`setTimeout(() => {}, ${SLEEPER_MS});\n`), 60_000));
      setTimeout(() => {
        t0 = Date.now();
        ac.abort();
      }, 200);
      const r = await p;
      assert.ok(t0 > 0, `the run ended before the abort: exit ${r.exitCode}, stdout ${JSON.stringify(r.stdout)}`);
      await settledWithin(run, Date.now() - t0, budget, "settled after the abort in");
      assert.equal(r.exitCode, null);
      assert.equal(liveChildCount(), 0);
    });
  });
}

describe("live child registry", () => {
  const mod = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
  /** Module body that hard-exits with `code` once `pidFile` exists. */
  const exitOnceStarted = (pidFile: string, code: number) =>
    `const t = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); setTimeout(() => process.exit(${code}), 50); } }, 20);`;

  it("a hard process.exit SIGKILLs every live child group", async () => {
    // A child process starts an agent-like sleeper through sh(), records its pid, then hard-exits.
    const pidFile = join(root, `exit-${seq++}`);
    const code = `
      import { sh } from ${mod("../../src/runner/exec.ts")};
      import { existsSync } from "node:fs";
      sh(${JSON.stringify(nodeLine(script(sleeper(pidFile))))}, { cwd: process.cwd(), timeoutMs: 0 });
      ${exitOnceStarted(pidFile, 130)}
    `;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { stdio: "ignore" });
    const exit = await new Promise<number | null>((r) => child.on("close", r));
    assert.equal(exit, 130);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0);
    const left = !(await gone(pid));
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "sleeper killed on exit");
  });

  it("a hard exit also kills an MCP server spawned over stdio (tap upstream, relay)", async () => {
    const pidFile = join(root, `mcp-${seq++}`);
    const server = script(`${writePid(pidFile, "process.pid")}\nsetTimeout(() => {}, 30000);\n`);
    const code = `
      import { StdioTransport } from ${mod("../../src/toolevals/mcp/stdio.ts")};
      import { existsSync } from "node:fs";
      new StdioTransport(${JSON.stringify([process.execPath, server])});
      ${exitOnceStarted(pidFile, 143)}
    `;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { stdio: "ignore" });
    assert.equal(await new Promise<number | null>((r) => child.on("close", r)), 143);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0);
    const left = !(await gone(pid));
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "MCP server killed on exit");
  });
});
