// init, uninstall and update name the CLI as the user's shell runs it. Started with npx,
// `coding.sh` is not on PATH; in PowerShell or cmd on Windows it opens npm's sh shim, and
// sh lines such as `curl … | sh` do not run. Commands run in-process in a throwaway home.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { UsageError } from "../../src/cli/args.ts";
import * as init from "../../src/cli/commands/init.ts";
import * as uninstall from "../../src/cli/commands/uninstall.ts";
import { checkFailed, reinstallCommand, runUpdate, type UpdateDeps } from "../../src/cli/commands/update.ts";
import { CliError } from "../../src/cli/output.ts";
import type { CommandModule } from "../../src/cli/types.ts";
import type { UpdateCache } from "../../src/update/index.ts";
import { writeFile } from "../adapters/_helpers.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const CURL = "curl -fsSL https://coding.sh/install | sh";
/** The CLI under npx. On Windows npx runs the command through cmd, which needs the dotless bin. */
const NPX = process.platform === "win32" ? "npx -p coding.sh codingsh" : "npx coding.sh";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

/** A throwaway home, with a stand-in for dist/hook.mjs, which init installs. No agent on PATH. */
function box(extra: NodeJS.ProcessEnv = {}): Sandbox {
  const sb = sandbox({ PATH: dirname(process.execPath), ...extra });
  boxes.push(sb);
  const hook = join(sb.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  sb.env.CODING_SH_HOOK_SOURCE = hook;
  return sb;
}

/** npm sets npm_command=exec in the CLI it starts for npx. */
const npxBox = () => box({ npm_command: "exec" });

const update = (deps: UpdateDeps): CommandModule => ({ run: (c) => runUpdate(c, deps) });
const setup = { agent: ["claude-code"], mcp: false, import: false };

describe("started with npx", () => {
  test("init without a terminal names the npx command to rerun with --yes", async () => {
    const r = await runCmd(init, npxBox(), { flags: setup });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, `${NPX} init --yes`);
  });

  test("uninstall without a terminal names the npx command to rerun with --yes", async () => {
    const sb = npxBox();
    const set = await runCmd(init, sb, { flags: { ...setup, yes: true } });
    assert.equal(set.code, 0, String(set.error ?? set.stderr));
    const r = await runCmd(uninstall, sb, { flags: { agent: ["claude-code"] } });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, `${NPX} uninstall --yes`);
  });

  test("update names the npx command that installs the release, and the one that sets up capture", async () => {
    const sb = npxBox();
    const available: UpdateCache = { latest: "0.2.0", checkedAt: 1, url: "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0", install: "https://github.com/jackulau/coding.sh/releases/download/v0.2.0/coding.sh-0.2.0.tgz", source: "github" };
    const deps: UpdateDeps = { current: "0.1.0", check: async () => available };
    const check = await runCmd(update(deps), sb, { flags: { check: true } });
    assert.equal(check.code, 0, String(check.error));
    assert.match(check.stderr, new RegExp(`Install it:\\n {4}${esc(NPX)} update$`, "m"));
    const dry = await runCmd(update(deps), sb, { flags: { "dry-run": true } });
    assert.match(dry.stderr, new RegExp(`Run the command above, or ${esc(NPX)} update\\.`));
    // No hook installed yet: --refresh-bin points at init.
    const refresh = await runCmd(update({}), sb, { flags: { "refresh-bin": true } });
    assert.equal(refresh.code, 0, String(refresh.error));
    assert.match(refresh.stderr, new RegExp(`Nothing to refresh: run ${esc(NPX)} init to set up capture`));
  });
});

describe("reinstalling the latest release", () => {
  test("PowerShell and cmd get npm install -g; Git Bash, Cygwin, Linux and macOS get the installer", () => {
    assert.equal(reinstallCommand({}, "win32"), "npm install -g coding.sh");
    assert.equal(reinstallCommand({ PSModulePath: "C:/x" }, "win32"), "npm install -g coding.sh");
    assert.equal(reinstallCommand({ MSYSTEM: "MINGW64" }, "win32"), CURL);
    assert.equal(reinstallCommand({ SHELL: "/usr/bin/bash" }, "win32"), CURL);
    assert.equal(reinstallCommand({}, "linux"), CURL);
    assert.equal(reinstallCommand({}, "darwin"), CURL);
  });

  test("a failed check names the reinstall the user's shell can run", () => {
    const cache = { error: "GitHub: x; npm: y", errorKind: "network" } as UpdateCache;
    assert.equal(checkFailed(cache, "0.1.0", { MSYSTEM: "MINGW64" }).next[1], CURL);
    assert.equal(checkFailed(cache, "0.1.0", {}).next[1], process.platform === "win32" ? "npm install -g coding.sh" : CURL);
  });

  test("a release with no package names the reinstall the user's shell can run", async () => {
    // No SHELL or MSYSTEM in the sandbox: PowerShell or cmd on Windows.
    const r = await runCmd(update({ current: "0.1.0", check: async () => ({ latest: "0.2.0", checkedAt: 1, source: "github" }) }), box(), {});
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.reason, "no_install_target");
    assert.deepEqual(r.error.next, ["Reinstall the latest release:", process.platform === "win32" ? "npm install -g coding.sh" : CURL]);
  });
});
