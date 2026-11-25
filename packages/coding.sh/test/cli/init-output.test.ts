// What init prints around its plan: one outcome per agent, the one its plan row gave it, and
// commands to run next that keep every flag the user gave.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { nextStepBin } from "../../src/cli/next-steps.ts";
import { CLI } from "../_cli.ts";
import { fakeBin, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

describe("init's summary agrees with the plan rows above it", () => {
  let env: TmpEnv;
  let hook: string;
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: env.home, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stderr: r.stderr };
  };

  before(() => {
    env = tmpEnv();
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    process.env.CLAUDE_CONFIG_DIR = join(env.home, ".claude");
    fakeBin(env, "agy", "1.3.0");
    fakeBin(env, "claude", "2.1.319 (Claude Code)");
  });
  after(() => env.restore());

  test("an agent set up by an earlier run is already set up, whatever else this run writes", () => {
    const init = ["init", "--yes", "--no-mcp", "--no-import", "--agent", "antigravity"];
    assert.equal(run(init).status, 0);

    // Claude Code is new. Antigravity CLI was set up by the run above.
    const r = run([...init, "--agent", "claude-code"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^ {2}Antigravity CLI \(user scope\)\n {4}already set up$/m);
    assert.match(r.stderr, /^✓ Already set up: Antigravity CLI \(hooks\)\n✓ Set up Claude Code \(hooks\)\n {2}Recording starts with the next session: start a new Claude Code session\./m);
    assert.doesNotMatch(r.stderr, /Set up Antigravity|Antigravity CLI and Claude Code/);

    // Only coding.sh's own config is written again: no agent is set up by this run.
    rmSync(join(env.dataHome, "config.toml"));
    const again = run([...init, "--agent", "claude-code"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /^ {4}create {2}.*config\.toml$/m);
    assert.match(again.stderr, /^✓ Already set up: Antigravity CLI and Claude Code \(hooks\)$/m);
    assert.doesNotMatch(again.stderr, /^✓ Set up/m);
    assert.doesNotMatch(again.stderr, /Recording starts/);
  });
});

describe("init's commands to run next keep every flag", () => {
  // The ingest key the fake server takes, built in parts so it reads as no real key.
  const KEY = ["csh_ik_", "a".repeat(43)].join("");
  let env: TmpEnv;
  let server: Server;
  let url = "";
  let config = "";
  // The CLI as Git Bash starts it (MSYSTEM and SHELL set), and as PowerShell does (neither).
  const shellEnv = (shell: "Git Bash" | "PowerShell"): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, CODING_SH_HOOK_SOURCE: join(env.root, "dist", "hook.mjs"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
    delete e.MSYSTEM;
    delete e.SHELL;
    return shell === "Git Bash" ? { ...e, MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" } : e;
  };
  // Not spawnSync: the fake server answers init's key check from this process.
  const run = (args: string[], e: NodeJS.ProcessEnv) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { cwd: env.home, env: e, stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("close", (status) => resolve({ status, stderr }));
    });

  before(async () => {
    env = tmpEnv();
    writeFile(join(env.root, "dist", "hook.mjs"), "// hook\n");
    process.env.CLAUDE_CONFIG_DIR = join(env.home, ".claude");
    fakeBin(env, "agy", "1.3.0");
    fakeBin(env, "claude", "2.1.319 (Claude Code)");
    // Stands in for `coding.sh serve`: /v1/ingest takes KEY.
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const ok = req.url === "/v1/ingest" && req.method === "POST" && req.headers.authorization === `Bearer ${KEY}`;
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(ok ? '{"accepted":0,"inserted":0,"rejected":[]}' : '{"error":"no"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // --proxy plans a route only to a port the proxy can hold: a free one, not whatever holds 4320 here.
    // Found while the server above holds its port, so the two can't be the same.
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    config = `[proxy]\nport = ${(free.address() as AddressInfo).port}\n`;
    await new Promise<void>((r) => free.close(() => r()));
    writeFile(join(env.dataHome, "config.toml"), config);
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    env.restore();
  });

  for (const shell of ["Git Bash", "PowerShell"] as const) {
    test(`as ${shell} starts it: the consent hint adds --yes and the dry run's drops --dry-run and --diff`, async () => {
      const e = shellEnv(shell);
      const flags = ["init", "--agent", "antigravity", "-a", "claude-code", "--scope", "user", "--no-mcp", "--import", "--force", "--proxy", "--remote", url, "--key", KEY, "--remote-mode", "full"];
      const equals = ["init", "--agent=antigravity", "--scope=user", "--no-mcp", "--no-import", `--remote=${url}`, `--key=${KEY}`, "--remote-mode=full", "--no-color"];
      // The commands as given: no argument here needs quoting in either shell.
      const cmd = (args: string[]) => [nextStepBin(e), ...args].join(" ");
      // None of these runs has consent, so they write nothing. The --proxy runs take turns: each checks
      // the proxy's port by listening on it for a moment, and a check at the same time finds it in use.
      const proxyRuns = async () => [await run(flags, e), await run([...flags, "--json"], e), await run(["init", "--dry-run", ...flags.slice(1), "--diff"], e)] as const;
      const [[consent, json, dry], dryEquals] = await Promise.all([proxyRuns(), run([...equals, "--dry-run"], e)]);
      assert.equal(consent.status, 2, consent.stderr);
      assert.ok(consent.stderr.includes(`\n    With their approval: ${cmd([...flags, "--yes"])}\n`), consent.stderr);
      assert.equal(json.status, 2, json.stderr);
      assert.deepEqual(JSON.parse(json.stderr.trim().split("\n").at(-1)!).next, ["With their approval:", cmd([...flags, "--json", "--yes"])]);
      assert.equal(dry.status, 0, dry.stderr);
      assert.ok(dry.stderr.includes(`\n  Apply the plan:\n    ${cmd(flags)}\n`), dry.stderr);
      assert.equal(dryEquals.status, 0, dryEquals.stderr);
      assert.ok(dryEquals.stderr.includes(`\n  Apply the plan:\n    ${cmd(equals)}\n`), dryEquals.stderr);
      assert.equal(readFileSync(join(env.dataHome, "config.toml"), "utf8"), config, "nothing written");
    });
  }
});

describe("init on Windows, with a hook path cmd.exe or PowerShell would read differently", { skip: process.platform !== "win32" && "agents run hooks under cmd.exe or PowerShell only on Windows" }, () => {
  let env: TmpEnv;
  let home = "";
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: env.home, env: { ...process.env, CODING_SH_HOME: home, CODING_SH_HOOK_SOURCE: join(env.root, "dist", "hook.mjs"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  before(() => {
    env = tmpEnv();
    // The data folder, and so the hook path, is under a folder named a$b.
    home = join(env.root, "a$b", "coding.sh");
    writeFile(join(env.root, "dist", "hook.mjs"), "// hook\n");
    process.env.CLAUDE_CONFIG_DIR = join(env.home, ".claude");
    fakeBin(env, "agy", "1.3.0");
    fakeBin(env, "claude", "2.1.319 (Claude Code)");
  });
  after(() => env.restore());

  test("says why for that agent and how to move the folder, and still sets up Claude Code", () => {
    const init = ["init", "--no-mcp", "--no-import", "--agent", "antigravity", "--agent", "claude-code"];
    const reason = /^the hook path .*a\$b.*hook\.mjs has a \$, which cmd\.exe or PowerShell would read differently; set CODING_SH_HOME .*setx CODING_SH_HOME/;
    const dry = run([...init, "--dry-run", "--json"]);
    assert.equal(dry.status, 1, dry.stderr);
    const agents = (JSON.parse(dry.stdout) as { agents: { id: string; error: string | null; changes: unknown[] }[] }).agents;
    assert.match(agents.find((a) => a.id === "antigravity")?.error ?? "", reason);
    assert.equal(agents.find((a) => a.id === "claude-code")?.error, null);
    assert.ok(agents.find((a) => a.id === "claude-code")?.changes.length);

    const r = run([...init, "--yes"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /✗ can't install hooks: the hook path .*a\$b.*hook\.mjs has a \$, /);
    assert.match(r.stderr, /^✓ Set up Claude Code \(hooks\)$/m);
    assert.match(readFileSync(join(env.home, ".claude", "settings.json"), "utf8"), /hook\.mjs\\" claude-code /);
  });
});
