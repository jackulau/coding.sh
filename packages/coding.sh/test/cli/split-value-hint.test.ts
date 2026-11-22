// Windows PowerShell 5.1 passes a double quote inside an argument on unescaped, so the program
// splits that value at the quote and its pieces read as options or extra arguments. In PowerShell
// or cmd, such an error after a value with a space says how to write the quote; elsewhere, or with
// no value with a space before it, the error is as it was.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parseArgs, SPLIT_VALUE_HINT, UsageError, type ParseOptions } from "../../src/cli/args.ts";
import { main } from "../../src/cli/main.ts";
import { findCommand } from "../../src/cli/registry.ts";

const alertAdd = findCommand("alert")!.actions!.find((a) => a.name === "add")!;
const purge = findCommand("purge")!;

/** What `--notify "command:powershell -NoProfile -Command `"$input | Add-Content -Path C:\alerts\alerts.log`""` reaches the CLI as from Windows PowerShell 5.1. */
const SPLIT_NOTIFY = ["failures", "--measure", "failure-rate", "--over", "0.5", "--window", "1d", "--notify", "command:powershell -NoProfile -Command $input", "|", "Add-Content", "-Path", "C:\\alerts\\alerts.log"];

function usageError(argv: string[], specs = alertAdd.flags!, opts: ParseOptions = {}): UsageError {
  try {
    parseArgs(argv, specs, opts);
  } catch (e) {
    assert.ok(e instanceof UsageError, String(e));
    return e;
  }
  assert.fail(`parsed: ${argv.join(" ")}`);
}

describe("parseArgs in PowerShell or cmd", () => {
  test("an unknown option after a value with a space says how to write a double quote inside a value", () => {
    const e = usageError(SPLIT_NOTIFY, alertAdd.flags, { maxPositionals: 1, windowsShell: true });
    assert.equal(e.reason, "unknown_option");
    assert.equal(e.message, `Unknown option -Path. ${SPLIT_VALUE_HINT}`);
    assert.equal(e.suggestion, undefined);
  });

  test("an extra argument after a value with a space says it too, as does a piece that holds the space", () => {
    // `--notify "command:`"C:\Program Files\nodejs\node.exe`" C:\alerts\notify.mjs"` from Windows PowerShell 5.1.
    const e = usageError(["failures", "--notify", "command:C:\\Program", "Files\\nodejs\\node.exe C:\\alerts\\notify.mjs"], alertAdd.flags, { maxPositionals: 1, windowsShell: true });
    assert.equal(e.reason, "extra_argument");
    assert.equal(e.message, `Unexpected argument "Files\\\\nodejs\\\\node.exe C:\\\\alerts\\\\notify.mjs". ${SPLIT_VALUE_HINT}`);
  });

  test("with no value with a space before it, or as the first token, the error is as it was", () => {
    // A first token has no value before it to be part of: a quoted phrase a command does not take.
    assert.equal(usageError(["fix the bug"], alertAdd.flags, { maxPositionals: 0, windowsShell: true }).message, 'Unexpected argument "fix the bug"');
    assert.equal(usageError(["failures", "--notify", "webhook:https://example.com/hook", "-Path", "x"], alertAdd.flags, { maxPositionals: 1, windowsShell: true }).message, "Unknown option -Path");
    assert.equal(usageError(["failures", "extra"], alertAdd.flags, { maxPositionals: 1, windowsShell: true }).message, 'Unexpected argument "extra"');
    // A value with a space after the error does not count.
    assert.equal(usageError(["failures", "-x", "a b"], alertAdd.flags, { maxPositionals: 1, windowsShell: true }).message, "Unknown option -x");
  });

  test("a close flag name is the fix it names, alone", () => {
    const e = usageError(["failures", "--notify", "command:node a.mjs", "--ovr", "1"], alertAdd.flags, { maxPositionals: 1, windowsShell: true });
    assert.equal(e.message, "Unknown option --ovr");
    assert.equal(e.suggestion, "--over");
  });

  test("a sensitive command adds the hint and still shows no value", () => {
    const opt = usageError(["--literal", "my secrets.txt", "-Path"], purge.flags, { maxPositionals: 0, sensitive: true, windowsShell: true });
    assert.equal(opt.message, `Unknown option (value not shown). ${SPLIT_VALUE_HINT}`);
    const extra = usageError(["--literal", "my secrets.txt", "pasted-value"], purge.flags, { maxPositionals: 0, sensitive: true, windowsShell: true });
    assert.equal(extra.message, `Unexpected argument (value not shown): this command takes no values on the command line. ${SPLIT_VALUE_HINT}`);
    for (const e of [opt, extra]) assert.doesNotMatch(e.message, /secrets|pasted-value|-Path/);
  });
});

describe("parseArgs elsewhere", () => {
  test("the same split prints the error as it was", () => {
    assert.equal(usageError(SPLIT_NOTIFY, alertAdd.flags, { maxPositionals: 1 }).message, "Unknown option -Path");
    assert.equal(usageError(SPLIT_NOTIFY, alertAdd.flags, { maxPositionals: 1, windowsShell: false }).message, "Unknown option -Path");
  });
});

describe("main() knows the shell from the environment", () => {
  let root = "";
  let env: NodeJS.ProcessEnv;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "csh-splithint-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    env = { ...process.env, ["HO" + "ME"]: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), T3CODE_HOME: join(root, "t3"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** main() in this process with `--json`: the exit code and the error's message. */
  async function message(e: NodeJS.ProcessEnv): Promise<{ status: number; message: string }> {
    const write = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
    let status: number;
    try {
      status = await main(["alert", "add", ...SPLIT_NOTIFY, "--json"], e);
    } finally {
      process.stderr.write = write;
    }
    const line = stderr.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    assert.ok(line, stderr);
    const doc = JSON.parse(line) as { reason: string; message: string };
    assert.equal(doc.reason, "unknown_option");
    return { status, message: doc.message };
  }

  test("no MSYSTEM and no SHELL: the hint on Windows only", async () => {
    const ps = { ...env };
    delete ps.MSYSTEM;
    delete ps.SHELL;
    const r = await message(ps);
    assert.equal(r.status, 2);
    assert.equal(r.message, process.platform === "win32" ? `Unknown option -Path. ${SPLIT_VALUE_HINT}` : "Unknown option -Path");
  });

  test("a shell that sets SHELL (Git Bash, MSYS2, Cygwin, any Unix shell): no hint", async () => {
    const r = await message({ ...env, SHELL: "/usr/bin/bash" });
    assert.equal(r.status, 2);
    assert.equal(r.message, "Unknown option -Path");
  });
});
