// init --proxy / uninstall --proxy against a temp HOME: what each agent's config
// gets, conflicts refused, and uninstall leaving files byte-for-byte as before.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run as initRun } from "../../src/cli/commands/init.ts";
import { run as uninstallRun } from "../../src/cli/commands/uninstall.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { parseToml } from "../../src/core/toml.ts";
import { applyProxyInstall, applyProxyUninstall, planProxyInstall, planProxyUninstall, proxyRoutes, readProxyInstalls, type ProxyAgent } from "../../src/proxy/install.ts";
import { joinUpstream, startProxy } from "../../src/proxy/server.ts";
import { proxySettings, writeProxyState } from "../../src/proxy/state.ts";
import { kickProxy, type KickSpawner } from "../../src/spool/kick.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

const URL = "http://127.0.0.1:4320";
let t: TmpEnv & { cleanup?: () => Promise<void> };
let claude = "";
let codex = "";
// Base URLs in the environment are chained through: keep the developer's own out of these tests.
const BASE_ENV = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const;
let savedBase: Record<string, string | undefined> = {};
beforeEach(() => {
  t = tmpEnv();
  savedBase = Object.fromEntries(BASE_ENV.map((k) => [k, process.env[k]]));
  for (const k of BASE_ENV) delete process.env[k];
  process.env.CLAUDE_CONFIG_DIR = join(t.home, ".claude");
  process.env.CODEX_HOME = join(t.home, ".codex");
  claude = join(t.home, ".claude", "settings.json");
  codex = join(t.home, ".codex", "config.toml");
});
afterEach(async () => {
  await t.cleanup?.();
  for (const k of BASE_ENV) {
    if (savedBase[k] === undefined) delete process.env[k];
    else process.env[k] = savedBase[k];
  }
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

  test("chains through a base URL the user set: the proxy takes its path, its origin becomes the upstream", async () => {
    const before = `{\n  "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com/anthropic/" },\n  "model": "opus"\n}\n`;
    writeFile(claude, before);
    const plan = planProxyInstall("claude-code", { url: URL });
    assert.match(plan?.summary ?? "", /calls go on to https:\/\/gw\.example\.com\/anthropic\//);
    await install("claude-code");
    assert.equal(JSON.parse(readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, `${URL}/anthropic`);
    const rec = readProxyInstalls(process.env)["claude-code"];
    assert.equal(rec?.chained, "https://gw.example.com/anthropic/");
    assert.equal(rec?.upstream, "https://gw.example.com");
    assert.equal(proxySettings(process.env).upstreams.anthropic, "https://gw.example.com");
    assert.equal(proxySettings(process.env).upstreams.openai, "https://api.openai.com", "Codex not chained");
    // What the agent sends now reaches the URL it reached before.
    assert.equal(joinUpstream(rec!.upstream!, "/anthropic/v1/messages").href, "https://gw.example.com/anthropic/v1/messages");
    assert.deepEqual(proxyRoutes(process.env), [{ agent: "claude-code", file: claude, url: `${URL}/anthropic`, expected: `${URL}/anthropic`, chained: "https://gw.example.com/anthropic/" }]);
    assert.equal(planProxyInstall("claude-code", { url: URL }), undefined, "idempotent");
    // A new port keeps the chain.
    await install("claude-code", { url: "http://127.0.0.1:4999" });
    assert.equal(JSON.parse(readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4999/anthropic");
    assert.equal(readProxyInstalls(process.env)["claude-code"]?.chained, "https://gw.example.com/anthropic/");
    await uninstall("claude-code");
    assert.equal(readFileSync(claude, "utf8"), before, "byte for byte");
    assert.equal(proxySettings(process.env).upstreams.anthropic, "https://api.anthropic.com", "the chain goes with the record");
  });

  test("chains through ANTHROPIC_BASE_URL from the environment, and uninstall drops only our key", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
    writeFile(claude, `{ "model": "opus" }\n`);
    await install("claude-code");
    assert.equal(JSON.parse(readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, URL);
    assert.equal(readProxyInstalls(process.env)["claude-code"]?.upstream, "http://127.0.0.1:8317");
    writeFileSync(claude, readFileSync(claude, "utf8").replace("{", '{ "theme": "dark",'));
    await uninstall("claude-code");
    assert.deepEqual(JSON.parse(readFileSync(claude, "utf8")), { theme: "dark", model: "opus" });
  });

  test("won't chain through a URL with credentials or a query", () => {
    writeFile(claude, `{ "env": { "ANTHROPIC_BASE_URL": "https://user:pw@gw.example.com" } }\n`);
    assert.throws(() => planProxyInstall("claude-code", { url: URL }), /not a plain http\(s\) URL[\s\S]*--force/);
    writeFile(claude, `{ "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com?key=1" } }\n`);
    assert.throws(() => planProxyInstall("claude-code", { url: URL }), /--force/);
  });

  test("--force replaces a base URL the user set; uninstall puts it back", async () => {
    writeFile(claude, `{ "env": { "ANTHROPIC_BASE_URL": "https://gw.example.com" } }\n`);
    await install("claude-code", { force: true });
    assert.equal(JSON.parse(readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, URL);
    assert.equal(readProxyInstalls(process.env)["claude-code"]?.upstream, undefined);
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

  test("model_provider = openai is replaced and restored", async () => {
    writeFile(codex, `model_provider = "openai"\n`);
    await install("codex");
    writeFileSync(codex, readFileSync(codex, "utf8") + "\n# note\n");
    await uninstall("codex");
    assert.equal(parseToml(readFileSync(codex, "utf8")).model_provider, "openai");
  });

  const CLIPROXY = `model = "gpt-5.5"
model_provider = "cliproxy"

[model_providers.cliproxy]
name = "CLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"
env_key = "CLIPROXY_KEY"
wire_api = "responses"

[mcp_servers.docs]
command = "docs-mcp"
`;

  test("chains through the user's own provider: only its base_url changes, and uninstall restores the exact bytes", async () => {
    writeFile(codex, CLIPROXY);
    await install("codex");
    const v = parseToml(readFileSync(codex, "utf8"));
    assert.equal(v.model_provider, "cliproxy", "still the user's provider");
    assert.deepEqual((v.model_providers as Record<string, unknown>).cliproxy, { name: "CLIProxyAPI", base_url: `${URL}/v1`, env_key: "CLIPROXY_KEY", wire_api: "responses" });
    assert.equal((v.model_providers as Record<string, unknown>)["coding-sh"], undefined);
    const rec = readProxyInstalls(process.env).codex;
    assert.deepEqual([rec?.provider, rec?.chained, rec?.upstream, rec?.target], ["cliproxy", "http://127.0.0.1:8317/v1", "http://127.0.0.1:8317", `${URL}/v1`]);
    assert.equal(proxySettings(process.env).upstreams.openai, "http://127.0.0.1:8317");
    assert.equal(joinUpstream(rec!.upstream!, "/v1/responses").href, "http://127.0.0.1:8317/v1/responses");
    assert.deepEqual(proxyRoutes(process.env), [{ agent: "codex", file: codex, url: `${URL}/v1`, expected: `${URL}/v1`, chained: "http://127.0.0.1:8317/v1" }]);
    assert.equal(planProxyInstall("codex", { url: URL }), undefined, "idempotent");
    await install("codex", { url: "http://127.0.0.1:4999" });
    assert.equal((parseToml(readFileSync(codex, "utf8")).model_providers as Record<string, Record<string, unknown>>).cliproxy!.base_url, "http://127.0.0.1:4999/v1");
    await uninstall("codex");
    assert.equal(readFileSync(codex, "utf8"), CLIPROXY, "byte for byte");
    assert.equal(proxySettings(process.env).upstreams.openai, "https://api.openai.com");
  });

  test("a chained provider edited since (Codex added a section, our tag gone) gets its base_url back", async () => {
    writeFile(codex, CLIPROXY);
    await install("codex");
    writeFileSync(codex, readFileSync(codex, "utf8").replace(/ # coding\.sh.*$/m, "") + `\n[projects."/work/demo"]\ntrust_level = "trusted"\n`);
    await uninstall("codex");
    const v = parseToml(readFileSync(codex, "utf8"));
    assert.equal((v.model_providers as Record<string, Record<string, unknown>>).cliproxy!.base_url, "http://127.0.0.1:8317/v1");
    assert.ok(v.projects, "the new section stays");
  });

  test("a provider path without /v1 (Azure) keeps its path through the proxy", async () => {
    writeFile(codex, `model_provider = "azure"\n\n[model_providers.azure]\nbase_url = "https://x.openai.azure.com/openai"\nquery_params = { api-version = "2025-04-01-preview" }\n`);
    await install("codex");
    const rec = readProxyInstalls(process.env).codex;
    assert.equal(rec?.target, `${URL}/openai`);
    assert.equal(joinUpstream(rec!.upstream!, "/openai/responses?api-version=2025-04-01-preview").href, "https://x.openai.azure.com/openai/responses?api-version=2025-04-01-preview");
  });

  test("openai_base_url or OPENAI_BASE_URL is chained through the coding-sh provider", async () => {
    const before = `openai_base_url = "https://gw.example.com/openai/v1"\n`;
    writeFile(codex, before);
    await install("codex");
    const v = parseToml(readFileSync(codex, "utf8"));
    assert.equal(v.model_provider, "coding-sh");
    assert.equal((v.model_providers as Record<string, Record<string, unknown>>)["coding-sh"]!.base_url, `${URL}/openai/v1`);
    assert.equal(readProxyInstalls(process.env).codex?.upstream, "https://gw.example.com");
    await uninstall("codex");
    assert.equal(readFileSync(codex, "utf8"), before);

    process.env.OPENAI_BASE_URL = "http://localhost:4000/v1";
    rmSync(codex);
    await install("codex");
    assert.equal(readProxyInstalls(process.env).codex?.upstream, "http://localhost:4000");
    assert.equal((parseToml(readFileSync(codex, "utf8")).model_providers as Record<string, Record<string, unknown>>)["coding-sh"]!.base_url, `${URL}/v1`);
  });

  test("--force switches a custom provider to OpenAI through the proxy; a provider with no base_url needs it", async () => {
    writeFile(codex, CLIPROXY);
    await install("codex", { force: true });
    assert.equal(parseToml(readFileSync(codex, "utf8")).model_provider, "coding-sh");
    assert.equal(readProxyInstalls(process.env).codex?.upstream, undefined);
    await uninstall("codex");
    assert.equal(readFileSync(codex, "utf8"), CLIPROXY);

    writeFileSync(codex, `model_provider = "local"\n\n[model_providers.local]\nname = "x"\n`);
    assert.throws(() => planProxyInstall("codex", { url: URL }), /no base_url to chain through[\s\S]*--force/);
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

  test("keeps a CLIProxyAPI both agents already used as the upstream, and uninstall leaves both files identical", async () => {
    process.env.PATH = join(t.root, "nobin");
    const hook = join(t.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    process.env.CODING_SH_HOOK_SOURCE = hook;
    try {
      const claudeBefore = `{\n  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317" }\n}\n`;
      const codexBefore = `model_provider = "cliproxy"\n\n[model_providers.cliproxy]\nname = "CLIProxyAPI"\nbase_url = "http://127.0.0.1:8317/v1"\nenv_key = "CLIPROXY_KEY"\n`;
      writeFile(claude, claudeBefore);
      writeFile(codex, codexBefore);
      // A proxy already running with the chained upstreams, so init neither starts nor restarts one.
      const running = await startProxy({ port: 0 });
      t.cleanup = () => running.close();
      await writeProxyState({ pid: process.pid, url: running.url, host: running.host, port: running.port, startedAt: Date.now(), upstreams: { anthropic: "http://127.0.0.1:8317", openai: "http://127.0.0.1:8317", chatgpt: "https://chatgpt.com/backend-api/codex" } }, process.env);

      const r = ctx({ agent: ["claude-code", "codex"], proxy: true });
      assert.equal(await initRun(r.c), 0);
      assert.match(r.err(), /Claude Code calls go on to http:\/\/127\.0\.0\.1:8317, the base URL it used before/);
      assert.match(r.err(), /Codex CLI calls go on to http:\/\/127\.0\.0\.1:8317\/v1/);
      assert.equal(JSON.parse(readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, URL);
      const v = parseToml(readFileSync(codex, "utf8"));
      assert.equal(v.model_provider, "cliproxy");
      assert.equal((v.model_providers as Record<string, Record<string, unknown>>).cliproxy!.base_url, `${URL}/v1`);
      assert.deepEqual(proxySettings(process.env).upstreams, { anthropic: "http://127.0.0.1:8317", openai: "http://127.0.0.1:8317", chatgpt: "https://chatgpt.com/backend-api/codex" });

      assert.equal(await uninstallRun(ctx({}).c), 0);
      assert.equal(readFileSync(claude, "utf8"), claudeBefore);
      assert.equal(readFileSync(codex, "utf8"), codexBefore);
    } finally {
      delete process.env.CODING_SH_HOOK_SOURCE;
    }
  });
});
