// Portable spawn (src/core/spawn.ts): one argv that works on POSIX and on
// Windows, where agent CLIs are mostly npm `.cmd` shims.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hookPathForCommand } from "../../src/adapters/_shared/hooks.ts";
import { cmdShimTarget, resolveSpawn, spawnSync } from "../../src/core/spawn.ts";
import { nodeBin, npmCmdShim, pathOf } from "../_bin.ts";

const win = process.platform === "win32";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-spawn-")));
after(() => rmSync(dir, { recursive: true, force: true }));

// Arguments a prompt or a JSON flag can carry: spaces, quotes, cmd.exe and sh metacharacters, a newline.
const NASTY = ["plain", "two words", 'say "hi"', "a&b|c<d>e^f", "100% %PATH% !x!", "back\\slash\\", "$HOME `x`", "line1\nline2", ""];

describe("resolveSpawn", () => {
  it("is the identity off Windows", { skip: win && "Windows resolves commands" }, () => {
    assert.deepEqual(resolveSpawn("claude", ["-p", "x"]), { file: "claude", args: ["-p", "x"] });
  });

  it("reads the script an npm cmd-shim runs, and ignores other batch files", () => {
    const shim = join(dir, "tool.cmd");
    writeFileSync(join(dir, "cli.js"), "");
    writeFileSync(shim, npmCmdShim("cli.js"));
    assert.equal(cmdShimTarget(shim), join(dir, "cli.js"));
    const bat = join(dir, "other.cmd");
    writeFileSync(bat, "@echo off\r\necho %*\r\n");
    assert.equal(cmdShimTarget(bat), undefined);
  });

  it("runs an npm shim as node <script> with every argument intact", () => {
    const bin = join(dir, "bin");
    const out = join(dir, "argv.json");
    nodeBin(bin, "fake-agent", `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
    const env = { ...process.env, PATH: pathOf(bin, process.env.PATH) };
    if (win) {
      const r = resolveSpawn("fake-agent", NASTY, env);
      assert.equal(r.file, process.execPath, "no cmd.exe in between");
      assert.equal(r.args[0], join(bin, "fake-agent"));
    }
    const r = spawnSync("fake-agent", NASTY, { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.error ?? ""}${r.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), NASTY);
  });

  it("runs any other .cmd through cmd.exe with its arguments escaped", { skip: !win && "cmd.exe is Windows only" }, () => {
    // A hand-written batch file that hands its arguments to node, the way vendor wrappers do.
    const out = join(dir, "bat-argv.json");
    const script = join(dir, "dump.js");
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
    writeFileSync(join(dir, "wrapped.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    // cmd.exe cannot pass a newline through a batch file's %*; everything else must survive.
    const args = NASTY.filter((a) => !a.includes("\n"));
    const r = spawnSync(join(dir, "wrapped"), args, { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.error ?? ""}${r.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), args);
  });
});

describe("hookPathForCommand", () => {
  it("writes Windows paths with forward slashes and leaves POSIX paths alone", () => {
    assert.equal(hookPathForCommand("C:\\Users\\First Last\\.coding.sh\\bin\\hook.mjs"), "C:/Users/First Last/.coding.sh/bin/hook.mjs");
    assert.equal(hookPathForCommand("/home/me/.coding.sh/bin/hook.mjs"), "/home/me/.coding.sh/bin/hook.mjs");
  });
});
