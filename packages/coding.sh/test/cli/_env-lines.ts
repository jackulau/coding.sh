// Runs printed lines that set environment variables as a user runs them: through `eval` in sh,
// piped to `Invoke-Expression` in PowerShell (as test/cli/next-steps-env.test.ts does), and
// returns what each named variable then holds.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWindowsCommand } from "../../src/core/spawn.ts";

/**
 * The shell the lines printed for an env with no MSYSTEM or SHELL are for: PowerShell on Windows,
 * sh elsewhere. A test that runs them skips with this reason when there is none to run them in.
 */
export const NO_USER_SHELL: string | false = process.platform === "win32" ? !resolveWindowsCommand("powershell") && "PowerShell: Windows" : false;

/** The lines run as printed in that shell: each named variable's value afterwards (undefined: not set). */
export function runEnvLines(lines: readonly string[], names: readonly string[]): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "csh-envlines-"));
  try {
    writeFileSync(join(dir, "lines.txt"), lines.map((l) => `${l}\n`).join(""));
    writeFileSync(join(dir, "print.mjs"), `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]))));\n`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["MSYSTEM", "SHELL", ...names]) delete env[k];
    const node = process.execPath;
    const r =
      process.platform === "win32"
        ? // -EncodedCommand hands PowerShell the line as typed. Each line piped in is one string, as a command's output lines are.
          spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`Get-Content lines.txt | Invoke-Expression; & '${node}' print.mjs`, "utf16le").toString("base64")], { cwd: dir, env, encoding: "utf8", timeout: 60_000 })
        : spawnSync("/bin/sh", ["-c", `eval "$(cat lines.txt)"; "${node}" print.mjs`], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(`the lines did not run (exit ${r.status}): ${r.stderr}${r.stdout}`);
    const values = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "") as Record<string, string | null>;
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? undefined]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
