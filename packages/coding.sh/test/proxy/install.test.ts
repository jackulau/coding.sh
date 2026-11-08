// init --proxy / uninstall --proxy against a temp HOME: what each agent's config
// gets, conflicts refused, and uninstall leaving files byte-for-byte as before.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run as initRun } from "../../src/cli/commands/init.ts";
import { run as uninstallRun } from "../../src/cli/commands/uninstall.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { parseToml } from "../../src/core/toml.ts";
import { applyProxyInstall, applyProxyUninstall, planProxyInstall, planProxyUninstall, proxyRoutes, readProxyInstalls, type ProxyAgent } from "../../src/proxy/install.ts";
import { startProxy } from "../../src/proxy/server.ts";
import { writeProxyState } from "../../src/proxy/state.ts";
import { kickProxy, type KickSpawner } from "../../src/spool/kick.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

const URL = "http://127.0.0.1:4320";
let t: TmpEnv & { cleanup?: () => Promise<void> };
let claude = "";
let codex = "";
beforeEach(() => {
  t = tmpEnv();
  process.env.CLAUDE_CONFIG_DIR = join(t.home, ".claude");
  process.env.CODEX_HOME = join(t.home, ".codex");
  claude = join(t.home, ".claude", "settings.json");
  codex = join(t.home, ".codex", "config.toml");
});
afterEach(async () => {
  await t.cleanup?.();
  t.restore();
});

async function install(agent: ProxyAgent, opts: { url?: string; force?: boolean } = {}): Promise<void> {
  const c = planProxyInstall(agent, { url: opts.url ?? URL, env: process.env, force: opts.force });
  if (c) await applyProxyInstall(agent, c, opts.url ?? URL, process.env);
}

async function uninstall(agent: ProxyAgent): Promise<void> {
  await applyProxyUninstall(agent, planProxyUninstall(agent, process.env), process.env);
}

const CLAUDE_SETTINGS = `{
  // my settings
  "model": "opus",
  "env": { "FOO": "1" },
  "hooks": { "Stop": [] }
}
`;

const CODEX_CONFIG = `# my codex config
model = "gpt-5.5"
approval_policy = "on-request"

[mcp_servers.docs]
command = "docs-mcp"   # keep me

[profiles.fast]
model = "gpt-5.5-mini"
`;

describe("Claude Code", () => {
  test("sets env.ANTHROPIC_BASE_URL, keeps comments, and uninstall restores the exact bytes", async () => {
    writeFile(claude, CLAUDE_SETTINGS);
    await install("claude-code");
    const text = readFileSync(claude, "utf8");
    assert.match(text, /\/\/ my settings/);
    assert.match(text, /"ANTHROPIC_BASE_URL": "http:\/\/127\.0\.0\.1:4320"/);
    assert.equal(planProxyInstall("claude-code", { url: URL }), undefined, "idempotent");
    assert.deepEqual(proxyRoutes(process.env), [{ agent: "claude-code", file: claude, url: URL, expected: URL }]);
    await uninstall("claude-code");
    assert.equal(readFileSync(claude, "utf8"), CLAUDE_SETTINGS);
    assert.deepEqual(readProxyInstalls(process.env), {});
    assert.ok(!existsSync(join(t.dataHome, "proxy-installs.json")), "no record left for the hook to act on");
  });

  test("a file coding.sh created is deleted again", async () => {
    await install("claude-code");
    assert.deepEqual(JSON.parse(readFileSync(claude, "utf8")), { env: { ANTHROPIC_BASE_URL: URL } });
    await uninstall("claude-code");
    assert.ok(!existsSync(claude));
  });

  test("edited since: only our key goes, and a new env object goes with it", async () => {
    writeFile(claude, `{ "model": "opus" }\n`);
    await install("claude-code");
    const cfg = JSON.parse(readFileSync(claude, "utf8"));
    cfg.theme = "dark";
    writeFileSync(claude, JSON.stringify(cfg, null, 2) + "\n");
    await uninstall("claude-code");
    assert.deepEqual(JSON.parse(readFileSync(claude, "utf8")), { model: "opus", theme: "dark" });
  });

  test("refuses to replace a base URL the user set, unless --force; uninstall puts it back", async () => {
    writeFile(claude, `{ "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com" } }\n`);
    assert.throws(() => planProxyInstall("claude-code", { url: URL }), /anthropic_upstream = "https:\/\/gw\.example\.com"/);
    await install("claude-code", { force: true });
    assert.equal(readProxyInstalls(process.env)["claude-code"]?.previous, "https://gw.example.com");
    // Touch the file so the structural path (not the byte restore) runs.
    writeFileSync(claude, readFileSync(claude, "utf8").replace("{", '{ "model": "opus",'));
    await uninstall("claude-code");
    assert.deepEqual(JSON.parse(readFileSync(claude, "utf8")), { model: "opus", env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } });
  });

  test("a new port replaces our own URL without a conflict, and uninstall still restores the original", async () => {
    writeFile(claude, CLAUDE_SETTINGS);
    await install("claude-code");
    await install("claude-code", { url: "http://127.0.0.1:4999" });
    assert.match(readFileSync(claude, "utf8"), /4999/);
    await uninstall("claude-code");
    assert.equal(readFileSync(claude, "utf8"), CLAUDE_SETTINGS);
  });

  test("a URL changed by hand is no longer ours: left alone", async () => {
    writeFile(claude, `{}\n`);
    await install("claude-code");
    writeFileSync(claude, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://mine.example.com" } }));
    assert.equal(planProxyUninstall("claude-code"), undefined);
    assert.equal(proxyRoutes(process.env)[0]?.url, "https://mine.example.com");
  });
});

describe("Codex", () => {
  test("adds the coding-sh provider at the top level and as a table; uninstall restores the exact bytes", async () => {
    writeFile(codex, CODEX_CONFIG);
    await install("codex");
    const text = readFileSync(codex, "utf8");
    const v = parseToml(text);
    assert.equal(v.model_provider, "coding-sh");
    assert.deepEqual((v.model_providers as Record<string, unknown>)["coding-sh"], {
      name: "coding.sh proxy",
      base_url: `${URL}/v1`,
      wire_api: "responses",
      requires_openai_auth: true,
      supports_websockets: false,
    });
    assert.equal(v.model, "gpt-5.5", "other keys kept");
    assert.ok(text.indexOf("model_provider") < text.indexOf("[mcp_servers.docs]"), "a top-level key, before the first table");
    assert.match(text, /# keep me/);
    assert.equal(planProxyInstall("codex", { url: URL }), undefined, "idempotent");
    await uninstall("codex");
    assert.equal(readFileSync(codex, "utf8"), CODEX_CONFIG);
  });

  test("after a rewrite (comments dropped, keys added), only our provider goes", async () => {
    writeFile(codex, `model = "gpt-5.5"\n`);
    await install("codex");
    // What `codex` itself might write back: our tag comment gone, a new key added.
    const rewritten = readFileSync(codex, "utf8").replace(/ # coding\.sh.*$/m, "") + `\n[notice]\nhide = true\n`;
    writeFileSync(codex, rewritten);
    await uninstall("codex");
    const v = parseToml(readFileSync(codex, "utf8"));
    assert.deepEqual(v, { model: "gpt-5.5", notice: { hide: true } });
  });

  test("model_provider = openai is replaced and restored; a custom provider is refused without --force", async () => {
    writeFile(codex, `model_provider = "openai"\n`);
    await install("codex");
    writeFileSync(codex, readFileSync(codex, "utf8") + "\n# note\n");
    await uninstall("codex");
    assert.equal(parseToml(readFileSync(codex, "utf8")).model_provider, "openai");

    writeFileSync(codex, `model_provider = "azure"\n\n[model_providers.azure]\nbase_url = "https://x.openai.azure.com/openai"\n`);
    assert.throws(() => planProxyInstall("codex", { url: URL }), /model_provider = "azure"/);
  });

  test("a [model_providers.coding-sh] coding.sh never wrote is the user's", async () => {
    writeFile(codex, `[model_providers.coding-sh]\nbase_url = "http://elsewhere/v1"\n`);
    assert.throws(() => planProxyInstall("codex", { url: URL }), /not written by coding\.sh/);
  });
});

describe("hook restart", () => {
  test("starts `proxy --background` on a session start while an agent is routed and no proxy runs", async () => {
    const calls: string[][] = [];
    const spawn: KickSpawner = (_cmd, args) => (calls.push(args), { unref() {} });
    const cli = join(t.root, "cli.mjs");
    writeFile(cli, "");
    writeFile(join(t.dataHome, "bin", "cli-path"), `${cli}\n`);
    assert.equal(kickProxy("SessionStart", process.env, spawn), undefined, "nothing routed");
    await install("claude-code");
    assert.equal(kickProxy("UserPromptSubmit", process.env, spawn), undefined, "not a session start");
    assert.equal(kickProxy("SessionStart", { ...process.env, CODING_SH_NO_PROXY_AUTOSTART: "1" }, spawn), undefined);
    await writeProxyState({ pid: process.pid, url: URL, host: "127.0.0.1", port: 4320, startedAt: Date.now(), upstreams: { anthropic: "", openai: "", chatgpt: "" } }, process.env);
    assert.equal(kickProxy("SessionStart", process.env, spawn), undefined, "already running");
    await writeProxyState({ pid: 2 ** 22 + 77, url: URL, host: "127.0.0.1", port: 4320, startedAt: Date.now(), upstreams: { anthropic: "", openai: "", chatgpt: "" } }, process.env);
    assert.equal(kickProxy("SessionStart", process.env, spawn), cli);
    assert.deepEqual(calls, [[cli, "proxy", "--background"]]);
  });
});

describe("init --proxy and uninstall --proxy", () => {
  function ctx(flags: Record<string, unknown>): { c: CommandContext; err: () => string } {
    let stderr = "";
    const out = new Output({ json: false, env: process.env, stdout: { write: () => true, isTTY: false }, stderr: { write: (s: string) => ((stderr += s), true), isTTY: false }, stdin: { isTTY: false } });
    const c: CommandContext = { flags: { yes: true, mcp: false, ...flags }, positionals: [], rest: [], out, env: process.env, cwd: t.root, debug: false, signal: new AbortController().signal };
    return { c, err: () => stderr };
  }

  test("routes both agents next to their hooks, then removes only the routing", async () => {
    process.env.PATH = join(t.root, "nobin");
    const hook = join(t.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    process.env.CODING_SH_HOOK_SOURCE = hook;
    try {
      mkdirSync(join(t.home, ".claude"), { recursive: true });
      writeFile(codex, CODEX_CONFIG);
      // A proxy already running (in this process), so init does not start one.
      const running = await startProxy({ port: 0 });
      t.cleanup = () => running.close();
      await writeProxyState({ pid: process.pid, url: running.url, host: running.host, port: running.port, startedAt: Date.now(), upstreams: { anthropic: "", openai: "", chatgpt: "" } }, process.env);
      const dry = ctx({ agent: ["claude-code", "codex"], proxy: true, "dry-run": true });
      assert.equal(await initRun(dry.c), 0);
      assert.ok(!existsSync(claude), "dry run writes nothing");

      const r = ctx({ agent: ["claude-code", "codex", "cursor"], proxy: true });
      assert.equal(await initRun(r.c), 0);
      assert.match(r.err(), /Claude Code and Codex CLI → proxy at http:\/\/127\.0\.0\.1:4320/);
      assert.doesNotMatch(r.err(), /did not start/);
      assert.match(r.err(), /Cursor[\s\S]*init --proxy can't route this agent/);
      assert.equal(JSON.parse(readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, URL);
      assert.ok(JSON.parse(readFileSync(claude, "utf8")).hooks, "hooks installed alongside");
      assert.equal(parseToml(readFileSync(codex, "utf8")).model_provider, "coding-sh");

      const u = ctx({ proxy: true });
      assert.equal(await uninstallRun(u.c), 0);
      const settings = JSON.parse(readFileSync(claude, "utf8"));
      assert.equal(settings.env, undefined, "routing removed");
      assert.ok(settings.hooks, "hooks kept");
      assert.equal(parseToml(readFileSync(codex, "utf8")).model_provider, undefined);
      assert.deepEqual(readProxyInstalls(process.env), {});

      // A full uninstall after a full init leaves the user's files as they were.
      await initRun(ctx({ agent: ["claude-code", "codex"], proxy: true }).c);
      assert.equal(await uninstallRun(ctx({}).c), 0);
      assert.equal(readFileSync(codex, "utf8"), CODEX_CONFIG);
      assert.ok(!existsSync(claude), "coding.sh created settings.json, so it goes");

      const p = ctx({ agent: ["claude-code"], proxy: true, scope: "project" });
      await assert.rejects(initRun(p.c), /user config/);
    } finally {
      delete process.env.CODING_SH_HOOK_SOURCE;
    }
  });
});
