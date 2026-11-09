// ~/.coding.sh/bin after install and update.
// INS-6: `coding.sh update` left hook.mjs and cli-path from the old version,
//        and doctor still called the stale hook healthy.
// INS-7: the MCP entry pinned the node binary and cli.mjs that ran init (an
//        nvm version dir, the npx cache), which disappear on a node switch,
//        cache eviction or update.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { refreshAfterUpdate, runUpdate } from "../../src/cli/commands/update.ts";
import { checkMcpEntries } from "../../src/cli/commands/doctor.ts";
import { ensureHookBin, hookBinHealth, writeHookBin } from "../../src/cli/hookbin.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { mcpLaunchSpec, runningCli } from "../../src/mcp/launch.ts";
import { cursor } from "../../src/adapters/cursor.ts";
import { tmpEnv as adapterEnv } from "../adapters/_helpers.ts";
import { nodeBin, pathOf } from "../_bin.ts";

const MAIN = realpathSync(join(import.meta.dirname, "..", "..", "src", "cli", "main.ts"));
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv & { root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-hookbin-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const newHook = join(root, "new", "hook.mjs");
  mkdirSync(join(root, "new"));
  writeFileSync(newHook, "// hook v2\n");
  return { root, HOME: home, CODING_SH_HOME: join(home, ".coding.sh"), CODING_SH_HOOK_SOURCE: newHook, NO_UPDATE_NOTIFIER: "1", PATH: process.env.PATH };
}

function ctx(e: NodeJS.ProcessEnv, flags: Record<string, boolean> = {}): CommandContext {
  const sink = { write: () => true, isTTY: false };
  const out = new Output({ json: false, env: e, stdout: sink, stderr: sink, stdin: { isTTY: false } });
  return { flags, positionals: [], rest: [], out, env: e, cwd: e.HOME!, debug: false, signal: new AbortController().signal };
}

describe("MCP launch spec (INS-7)", () => {
  test("an npx/nvm install registers the stable launcher, not the transient node and cli.mjs", () => {
    const e = env();
    const npx = join(e.root, ".npm", "_npx", "9f1c", "node_modules", "coding.sh", "dist");
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "cli.mjs"), "");
    const spec = mcpLaunchSpec(runningCli(join(npx, "cli.mjs")), e);
    const all = [spec.command, ...spec.args].join(" ");
    assert.doesNotMatch(all, /_npx/);
    assert.doesNotMatch(all, /\.nvm|versions[\\/]node/);
    assert.equal(spec.command, "node");
    assert.deepEqual(spec.args, [join(e.CODING_SH_HOME!, "bin", "mcp.mjs")]);
  });

  test("the launcher starts the CLI named in cli-path with `mcp` and its arguments", async () => {
    const e = env();
    const cli = join(e.root, "pkg", "dist", "cli.mjs");
    mkdirSync(join(e.root, "pkg", "dist"), { recursive: true });
    writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
    await writeHookBin(e, cli);
    const launcher = join(e.CODING_SH_HOME!, "bin", "mcp.mjs");
    const argv = JSON.parse(execFileSync(process.execPath, [launcher, "--x"], { env: { ...process.env, ...e }, encoding: "utf8" })) as string[];
    assert.deepEqual(argv, [cli, "mcp", "--x"]);
  });

  test("with cli-path gone, the launcher runs the coding.sh on PATH (npm's .cmd shim on Windows, no shell)", async () => {
    const e = env();
    await writeHookBin(e, join(e.root, "gone", "cli.mjs"));
    const bin = join(e.root, "path bin");
    nodeBin(bin, "coding.sh", "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const launcher = join(e.CODING_SH_HOME!, "bin", "mcp.mjs");
    const args = ["--x", "two words", "a&b"];
    const argv = JSON.parse(execFileSync(process.execPath, [launcher, ...args], { env: { ...process.env, ...e, PATH: pathOf(bin, process.env.PATH) }, encoding: "utf8" })) as string[];
    assert.deepEqual(argv, ["mcp", ...args]);
  });

  test("doctor flags a registered MCP entry whose script is gone", async () => {
    const t = adapterEnv();
    try {
      await cursor.installMcp!({ server: { name: "coding-sh", command: process.execPath, args: [join(t.root, "gone", "cli.mjs"), "mcp"] }, dryRun: false });
      const [c] = checkMcpEntries([cursor], process.env);
      assert.equal(c!.ok, false);
      assert.match(c!.problem!, /gone[\\/]cli\.mjs not found/);
    } finally {
      t.restore();
    }
  });
});

describe("hook bin after `coding.sh update` (INS-6)", () => {
  test("a successful update has the new CLI rewrite hook.mjs; doctor sees it current", async () => {
    const e = env();
    mkdirSync(join(e.CODING_SH_HOME!, "bin"), { recursive: true });
    const hook = join(e.CODING_SH_HOME!, "bin", "hook.mjs");
    writeFileSync(hook, "// hook v1\n");
    assert.equal(hookBinHealth(e).hookCurrent, false, "doctor: the old hook is stale");

    const code = await runUpdate(ctx(e), {
      current: "0.1.0",
      check: async () => ({ latest: "0.2.0", checkedAt: 1, install: "coding.sh-0.2.0.tgz", source: "github" }),
      install: async () => ({ code: 0, output: "" }),
      // Spawn the "new" CLI (this source tree) exactly as after a real npm install.
      refresh: (en, signal) => refreshAfterUpdate(en, signal, async () => MAIN),
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(hook, "utf8"), "// hook v2\n");
    assert.match(readFileSync(join(e.CODING_SH_HOME!, "bin", "mcp.mjs"), "utf8"), /coding\.sh MCP launcher/);
    assert.equal(hookBinHealth(e).hookCurrent, true);
  });

  test("an update does not install the bin for someone who never ran init", async () => {
    const e = env();
    assert.deepEqual(await refreshAfterUpdate(e, new AbortController().signal, async () => MAIN), { status: "not_installed" });
  });

  test("doctor: cli-path naming another install is stale", () => {
    const e = env();
    mkdirSync(join(e.CODING_SH_HOME!, "bin"), { recursive: true });
    writeFileSync(join(e.CODING_SH_HOME!, "bin", "cli-path"), "/old/prefix/coding.sh/dist/cli.mjs\n");
    const h = hookBinHealth(e, join(e.root, "new", "cli.mjs"));
    assert.equal(h.cliPathCurrent, false);
    assert.equal(h.cliPathExists, false);
  });
});

describe("the sh fast path in the bin (TE-12)", () => {
  const SH_SRC = join(import.meta.dirname, "..", "..", "src", "spool", "hook.sh");
  test("init writes hook.sh beside hook.mjs, executable; a bin from before it gets hook.sh alone; doctor counts it", async () => {
    const e = env();
    const bin = join(e.CODING_SH_HOME!, "bin");
    await writeHookBin(e, undefined);
    assert.equal(readFileSync(join(bin, "hook.sh"), "utf8"), readFileSync(SH_SRC, "utf8"));
    if (process.platform !== "win32") assert.equal(statSync(join(bin, "hook.sh")).mode & 0o777, 0o755);
    assert.equal(hookBinHealth(e).hookCurrent, true);
    writeFileSync(join(bin, "hook.sh"), "# old\n");
    assert.equal(hookBinHealth(e).hookCurrent, false, "a stale hook.sh is a stale hook");

    // A bin an older version installed: hook.mjs only.
    rmSync(join(bin, "hook.sh"));
    writeFileSync(join(bin, "hook.mjs"), "// hook v1\n");
    assert.equal(await ensureHookBin(e), "written");
    assert.ok(existsSync(join(bin, "hook.sh")));
    assert.equal(readFileSync(join(bin, "hook.mjs"), "utf8"), "// hook v1\n", "the installed hook.mjs is left as it is");
    assert.equal(await ensureHookBin(e), "present");
  });
});
