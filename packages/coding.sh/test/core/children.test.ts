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
const settle = () => new Promise((r) => setTimeout(r, 100));
const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 20));
};

const root = mkdtempSync(join(tmpdir(), "codingsh-children-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
/** Writes a CommonJS node script and returns its path. */
function script(js: string): string {
  const p = join(root, `s${seq++}.cjs`);
  writeFileSync(p, js);
  return p;
}
/** Script lines that start a 30 s sleeper sharing our stdout (`c`) and record its pid in `pidFile`. */
const sleeper = (pidFile: string) => `
const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"] });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
`;
/** `node <file>` as a sh command line. */
const nodeLine = (file: string) => `'${process.execPath}' '${file}'`;

/** Each helper runs `node <script>` (sh through the POSIX shell) and reports exit code, timeout and stdout. */
const helpers: Record<string, (file: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>> = {
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
        const t0 = Date.now();
        const r = await run(script(`${sleeper(pidFile)}c.unref();\nconsole.log("tests passed");\n`), timeoutMs);
        assert.ok(Date.now() - t0 < 2500, `settled in ${Date.now() - t0}ms (timeoutMs ${timeoutMs})`);
        assert.equal(r.exitCode, 0);
        assert.equal(r.timedOut, false);
        assert.match(r.stdout, /tests passed/);
        await settle();
        // POSIX: the group kill on exit. Windows has no groups; there the sleeper, a node
        // child, dies with its parent through libuv's kill-on-close job object.
        assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "background child reaped");
      }
    });

    it("an explicit abort kills the process group promptly", async () => {
      const pidFile = join(root, `abort-${seq++}`);
      const ac = new AbortController();
      const t0 = Date.now();
      const p = run(script(sleeper(pidFile)), 60_000, ac.signal);
      await until(() => existsSync(pidFile));
      ac.abort();
      const r = await p;
      assert.ok(Date.now() - t0 < 5000, `aborted in ${Date.now() - t0}ms`);
      assert.equal(r.exitCode, null);
      assert.equal(r.timedOut, false);
      await settle();
      assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
    });

    it("the ambient signal reaches spawns that take no signal", async () => {
      const ac = new AbortController();
      const t0 = Date.now();
      const p = withAbortSignal(ac.signal, () => run(script("setTimeout(() => {}, 30000);\n"), 60_000));
      setTimeout(() => ac.abort(), 200);
      const r = await p;
      assert.ok(Date.now() - t0 < 5000, `aborted in ${Date.now() - t0}ms`);
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
    await settle();
    const left = alive(pid);
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "sleeper killed on exit");
  });

  it("a hard exit also kills an MCP server spawned over stdio (tap upstream, relay)", async () => {
    const pidFile = join(root, `mcp-${seq++}`);
    const server = script(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`);
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
    await settle();
    const left = alive(pid);
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "MCP server killed on exit");
  });
});
