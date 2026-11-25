// Lines that set an environment variable, as `coding.sh proxy env` prints them: `export` in sh,
// PowerShell's `$env:` in PowerShell or cmd, where an `export` line does not run. Run as printed,
// through `eval` in sh and `Invoke-Expression` in PowerShell, each sets the value as given.
// Messages name a variable the same way: `$NAME` in sh, `$env:NAME` in PowerShell or cmd.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { envLine, envRef } from "../../src/cli/next-steps.ts";
import { resolveWindowsCommand } from "../../src/core/spawn.ts";

describe("a line that sets an environment variable", () => {
  test("is export in sh: Linux, macOS, Git Bash and Cygwin", () => {
    for (const [env, platform] of [[{}, "linux"], [{}, "darwin"], [{ MSYSTEM: "MINGW64" }, "win32"], [{ SHELL: "/usr/bin/bash" }, "win32"]] as const) {
      assert.equal(envLine(env, "ANTHROPIC_BASE_URL", "http://127.0.0.1:4320", platform), "export ANTHROPIC_BASE_URL=http://127.0.0.1:4320");
      assert.equal(envLine(env, "X", "it's", platform), "export X='it'\\''s'");
    }
  });

  test("is PowerShell's $env: in PowerShell and cmd, in single quotes that keep $ and backticks", () => {
    assert.equal(envLine({}, "OPENAI_BASE_URL", "http://127.0.0.1:4320/v1", "win32"), "$env:OPENAI_BASE_URL = 'http://127.0.0.1:4320/v1'");
    assert.equal(envLine({}, "X", "it's $HOME `a`", "win32"), "$env:X = 'it''s $HOME `a`'");
    // PowerShell reads a curly single quote as a quote too.
    assert.equal(envLine({}, "X", "it’s", "win32"), "$env:X = 'it’’s'");
  });
});

describe("an environment variable a message names", () => {
  test("is $NAME in sh: Linux, macOS, Git Bash and Cygwin", () => {
    for (const [env, platform] of [[{}, "linux"], [{}, "darwin"], [{ MSYSTEM: "MINGW64" }, "win32"], [{ SHELL: "/usr/bin/bash" }, "win32"]] as const) assert.equal(envRef(env, "ANTHROPIC_API_KEY", platform), "$ANTHROPIC_API_KEY");
  });

  test("is $env:NAME in PowerShell and cmd, the name envLine sets", () => {
    assert.equal(envRef({}, "ANTHROPIC_API_KEY", "win32"), "$env:ANTHROPIC_API_KEY");
    assert.equal(envLine({}, "ANTHROPIC_API_KEY", "...", "win32"), `${envRef({}, "ANTHROPIC_API_KEY", "win32")} = '...'`);
  });
});

describe("lines that set environment variables, run as printed", () => {
  const win = process.platform === "win32";
  const vars = { CSH_URL: "http://127.0.0.1:4320/v1", CSH_ODD: "it's $HOME `a` & b" };
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "csh-envline-"));
    writeFileSync(join(dir, "print.mjs"), "console.log(JSON.stringify({ CSH_URL: process.env.CSH_URL, CSH_ODD: process.env.CSH_ODD }));\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const shells = [
    { name: "sh, through eval", platform: "linux", skip: win && "sh: Linux and macOS" },
    { name: "PowerShell, piped to Invoke-Expression", platform: "win32", skip: !(win && resolveWindowsCommand("powershell")) && "PowerShell: Windows" },
  ] as const;
  for (const sh of shells) {
    test(`in ${sh.name}, sets each value as given`, { skip: sh.skip }, () => {
      writeFileSync(join(dir, "lines.txt"), Object.entries(vars).map(([k, v]) => `${envLine({}, k, v, sh.platform)}\n`).join(""));
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of ["MSYSTEM", "SHELL", ...Object.keys(vars)]) delete env[k];
      const node = process.execPath;
      const r =
        sh.platform === "linux"
          ? spawnSync("/bin/sh", ["-c", `eval "$(cat lines.txt)"; "${node}" print.mjs`], { cwd: dir, env, encoding: "utf8", timeout: 60_000 })
          : // -EncodedCommand hands PowerShell the line as typed. Each line piped in is one string, as a command's output lines are.
            spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`Get-Content lines.txt | Invoke-Expression; & '${node}' print.mjs`, "utf16le").toString("base64")], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
      assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? ""), vars);
    });
  }
});
