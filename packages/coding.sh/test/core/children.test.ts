// Child supervision across every spawn helper: settle on exit (EXP-5), abort
// through an explicit or ambient signal, and SIGKILL of live groups on
// process exit (EXP-2).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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

/** Each helper runs a shell line and reports exit code, timeout and stdout. */
const helpers: Record<string, (line: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }>> = {
  sh: async (line, timeoutMs, signal) => {
    const r = await sh(line, { cwd: process.cwd(), timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdoutTail };
  },
  runProcess: async (line, timeoutMs, signal) => {
    const r = await runProcess({ command: "/bin/sh", args: ["-c", line], timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout };
  },
  runHeadless: async (line, timeoutMs, signal) => {
    const r = await runHeadless({ bin: "/bin/sh", args: ["-c", line], cwd: process.cwd(), env: process.env, timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdoutTail };
  },
  spawnAgent: async (line, timeoutMs, signal) => {
    const r = await spawnAgent({ bin: "/bin/sh", args: ["-c", line], cwd: process.cwd(), env: process.env, timeoutMs, ...(signal ? { signal } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdoutTail };
  },
};

for (const [name, run] of Object.entries(helpers)) {
  describe(`${name} supervision`, () => {
    it("settles on exit with the real code when a background child holds stdout, and reaps it", async () => {
      for (const timeoutMs of [5000, 0]) {
        const t0 = Date.now();
        const r = await run("sleep 30 & echo $!; echo tests passed; exit 0", timeoutMs);
        assert.ok(Date.now() - t0 < 2500, `settled in ${Date.now() - t0}ms (timeoutMs ${timeoutMs})`);
        assert.equal(r.exitCode, 0);
        assert.equal(r.timedOut, false);
        assert.match(r.stdout, /tests passed/);
        await settle();
        assert.equal(alive(Number(r.stdout.split("\n")[0])), false, "background child reaped");
      }
    });

    it("an explicit abort kills the process group promptly", async () => {
      const ac = new AbortController();
      const t0 = Date.now();
      const p = run("sleep 30 & echo $!; wait", 60_000, ac.signal);
      setTimeout(() => ac.abort(), 200);
      const r = await p;
      assert.ok(Date.now() - t0 < 5000, `aborted in ${Date.now() - t0}ms`);
      assert.equal(r.exitCode, null);
      assert.equal(r.timedOut, false);
      await settle();
      assert.equal(alive(Number(r.stdout.split("\n")[0])), false);
    });

    it("the ambient signal reaches spawns that take no signal", async () => {
      const ac = new AbortController();
      const t0 = Date.now();
      const p = withAbortSignal(ac.signal, () => run("sleep 30", 60_000));
      setTimeout(() => ac.abort(), 200);
      const r = await p;
      assert.ok(Date.now() - t0 < 5000, `aborted in ${Date.now() - t0}ms`);
      assert.equal(r.exitCode, null);
      assert.equal(liveChildCount(), 0);
    });
  });
}

describe("live child registry", () => {
  it("a hard process.exit SIGKILLs every live child group", async () => {
    // A child process starts an agent-like sleeper through sh(), records its pid, then hard-exits.
    const dir = mkdtempSync(join(tmpdir(), "codingsh-children-"));
    const pidFile = join(dir, "pid");
    try {
      const code = `
        import { sh } from ${JSON.stringify(new URL("../../src/runner/exec.ts", import.meta.url).pathname)};
        sh("sleep 30 & echo $! > ${pidFile}; wait", { cwd: process.cwd(), timeoutMs: 0 });
        setTimeout(() => process.exit(130), 300);
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hard exit also kills an MCP server spawned over stdio (tap upstream, relay)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codingsh-children-"));
    const pidFile = join(dir, "pid");
    try {
      const code = `
        import { StdioTransport } from ${JSON.stringify(new URL("../../src/toolevals/mcp/stdio.ts", import.meta.url).pathname)};
        new StdioTransport(["sh", "-c", "echo $$ > ${pidFile}; exec sleep 30"]);
        setTimeout(() => process.exit(143), 300);
      `;
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { stdio: "ignore" });
      assert.equal(await new Promise<number | null>((r) => child.on("close", r)), 143);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(pid > 0);
      await settle();
      const left = alive(pid);
      if (left) process.kill(pid, "SIGKILL");
      assert.equal(left, false, "MCP server killed on exit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
