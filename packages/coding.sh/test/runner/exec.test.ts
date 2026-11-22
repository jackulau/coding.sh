// Commands the runner starts (workflow commands, setup and verifier commands) on Windows: each one
// gets a console of its own, so a Ctrl-C in the user's terminal reaches coding.sh alone, and the
// first Ctrl-C can let the runs in flight finish instead of killing them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const mod = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);

test("on Windows a command the runner starts does not share coding.sh's console", { skip: process.platform !== "win32" && "consoles are Windows-only" }, async () => {
  // The code page belongs to the console, not to a process: `chcp` run in a console changes it for
  // every process attached there. A stand-in for coding.sh, in a hidden console of its own (so the
  // test never changes the terminal it runs in), sets its console's code page, then runs `chcp`
  // through execFileTail. A command that shares the stand-in's console reports that code page.
  const code = `
    import { spawn } from "node:child_process";
    import { execFileTail } from ${mod("../../src/runner/exec.ts")};
    const cmd = process.env.ComSpec || "cmd.exe";
    const page = (text) => Number(/(\\d+)\\D*$/.exec(text.trim())?.[1]);
    const chcp = (args, windowsHide) => new Promise((resolve, reject) => {
      const c = spawn(cmd, ["/d", "/c", "chcp", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide });
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.on("error", reject);
      c.on("close", () => resolve(page(out)));
    });
    const own = await chcp([], false);
    const fresh = await chcp([], true);
    const mark = [437, 850, 852].find((p) => p !== own && p !== fresh);
    await chcp([String(mark)], false);
    const set = await chcp([], false);
    const r = await execFileTail(cmd, ["/d", "/c", "chcp"], { cwd: process.cwd(), timeoutMs: 30000 });
    process.stdout.write(JSON.stringify({ mark, set, child: page(r.stdoutTail), exit: r.exitCode, stderr: r.stderrTail }));
  `;
  const standIn = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  standIn.stdout.on("data", (b: Buffer) => (stdout += b));
  standIn.stderr.on("data", (b: Buffer) => (stderr += b));
  const exit = await new Promise<number | null>((resolve) => standIn.on("close", resolve));
  assert.equal(exit, 0, stderr);
  const r = JSON.parse(stdout) as { mark: number; set: number; child: number; exit: number | null; stderr: string };
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.set, r.mark, "the stand-in's console took the code page");
  assert.notEqual(r.child, r.mark, "the command shares coding.sh's console, so the user's Ctrl-C stops it too");
});
