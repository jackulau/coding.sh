// MCP server registration through each adapter's installMcp/uninstallMcp:
// plans, backups, idempotency, and uninstall that restores the original bytes
// (or removes only our entry once the agent has edited the file since).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claudeCode, codex, cursor, opencode } from "../../src/adapters/index.ts";
import { geminiCliAdapter as geminiCli } from "../../src/adapters/more/gemini-cli.ts";
import { tomlBody } from "../../src/adapters/_shared/mcp.ts";
import { parseToml } from "../../src/core/toml.ts";
import type { Adapter, McpServerSpec } from "../../src/core/types.ts";
import { tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const SERVER: McpServerSpec = { name: "coding-sh", command: "/opt/node/bin/node", args: ["/opt/coding.sh/dist/cli.mjs", "mcp"] };
const MOVED: McpServerSpec = { ...SERVER, command: "/usr/local/bin/node" };

let t: TmpEnv;
let savedGemini: string | undefined;
beforeEach(() => {
  t = tmpEnv();
  savedGemini = process.env.GEMINI_CLI_HOME;
  delete process.env.GEMINI_CLI_HOME;
});
afterEach(() => {
  if (savedGemini !== undefined) process.env.GEMINI_CLI_HOME = savedGemini;
  t.restore();
});

interface Case {
  adapter: Adapter;
  file: () => string;
  /** Existing content written in the agent's own style (not what JSON.stringify would produce). */
  original: string;
  /** Reads our server entry back from the file text. */
  entry: (text: string) => unknown;
}

const json = (text: string) => JSON.parse(text) as Record<string, Record<string, unknown>>;

const CASES: Case[] = [
  {
    adapter: claudeCode,
    file: () => join(t.home, ".claude.json"),
    original: '{\n  "numStartups": 12,\n  "projects": {"/x": {"allowedTools": []}}\n}\n',
    entry: (s) => json(s).mcpServers?.["coding-sh"],
  },
  {
    adapter: codex,
    file: () => join(t.home, ".codex", "config.toml"),
    original: '# my settings\nmodel = "gpt-5"   # pinned\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n\n',
    entry: (s) => (parseToml(s).mcp_servers as Record<string, unknown>)["coding-sh"],
  },
  {
    adapter: cursor,
    file: () => join(t.home, ".cursor", "mcp.json"),
    original: '{"mcpServers": {"foo": {"command": "foo", "args": ["a", "b"]}}}',
    entry: (s) => json(s).mcpServers?.["coding-sh"],
  },
  {
    adapter: opencode,
    file: () => join(t.home, ".config", "opencode", "opencode.json"),
    original: '{\n\t"$schema": "https://opencode.ai/config.json",\n\t"theme": "tokyonight"\n}\n',
    entry: (s) => json(s).mcp?.["coding-sh"],
  },
  {
    adapter: geminiCli,
    file: () => join(t.home, ".gemini", "settings.json"),
    original: '{\n    "theme": "GitHub",\n    "mcpServers": {}\n}',
    entry: (s) => json(s).mcpServers?.["coding-sh"],
  },
];

describe("adapter MCP registration", () => {
  for (const c of CASES) {
    describe(c.adapter.id, () => {
      it("plans without writing, installs once, and uninstall restores the file byte-for-byte", async () => {
        const file = c.file();
        writeFile(file, c.original);
        const plan = await c.adapter.installMcp!({ server: SERVER, dryRun: true });
        assert.equal(plan.length, 1);
        assert.equal(plan[0]!.path, file);
        assert.equal(readFileSync(file, "utf8"), c.original, "dry run writes nothing");

        const done = await c.adapter.installMcp!({ server: SERVER, dryRun: false });
        assert.match(done[0]!.summary, /backup: /);
        const text = readFileSync(file, "utf8");
        assert.ok(c.entry(text), "entry present");
        assert.ok(readdirSync(join(t.dataHome, "backups", c.adapter.id)).length >= 1, "backed up");
        assert.deepEqual(await c.adapter.installMcp!({ server: SERVER, dryRun: false }), [], "idempotent");

        // The launch path changed (node upgrade): re-register, then uninstall still gets the original back.
        assert.equal((await c.adapter.installMcp!({ server: MOVED, dryRun: false })).length, 1);
        const u = await c.adapter.uninstallMcp!({ name: SERVER.name, dryRun: false });
        assert.equal(u.length, 1);
        assert.equal(readFileSync(file, "utf8"), c.original);
        assert.deepEqual(await c.adapter.uninstallMcp!({ name: SERVER.name, dryRun: false }), [], "nothing left to remove");
      });

      it("deletes a config file it created", async () => {
        await c.adapter.installMcp!({ server: SERVER, dryRun: false });
        assert.ok(existsSync(c.file()));
        await c.adapter.uninstallMcp!({ name: SERVER.name, dryRun: false });
        assert.equal(existsSync(c.file()), false);
      });

      it("removes only its entry once the file was edited after install", async () => {
        const file = c.file();
        writeFile(file, c.original);
        await c.adapter.installMcp!({ server: SERVER, dryRun: false });
        // The agent (or the user) rewrites the file afterwards.
        const edited = readFileSync(file, "utf8").replace(c.adapter.id === "codex" ? 'model = "gpt-5"' : /^\{/, c.adapter.id === "codex" ? 'model = "gpt-6"' : '{"edited": true,');
        writeFileSync(file, edited);
        await c.adapter.uninstallMcp!({ name: SERVER.name, dryRun: false });
        const after = readFileSync(file, "utf8");
        assert.equal(c.entry(after), undefined, "our entry is gone");
        assert.match(after, c.adapter.id === "codex" ? /gpt-6/ : /"edited": true/, "their edit is kept");
      });
    });
  }

  it("codex: writes a marked [mcp_servers.coding-sh] block and leaves a hand-written entry alone", async () => {
    const file = join(t.home, ".codex", "config.toml");
    await codex.installMcp!({ server: SERVER, dryRun: false });
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(tomlBody(SERVER)));
    assert.match(text, /# >>> coding\.sh:mcp-server/);
    assert.deepEqual(parseToml(text).mcp_servers, { "coding-sh": { command: SERVER.command, args: SERVER.args } });

    const mine = '[mcp_servers.coding-sh]\ncommand = "coding.sh"\nargs = ["mcp"]\n';
    writeFileSync(file, mine);
    assert.deepEqual(await codex.installMcp!({ server: SERVER, dryRun: false }), []);
    assert.deepEqual(await codex.uninstallMcp!({ name: SERVER.name, dryRun: false }), []);
    assert.equal(readFileSync(file, "utf8"), mine);
  });

  it("refuses to modify a config it cannot parse", async () => {
    writeFile(join(t.home, ".cursor", "mcp.json"), "{ not json");
    await assert.rejects(cursor.installMcp!({ server: SERVER, dryRun: true }), /refusing to modify/);
    writeFile(join(t.home, ".claude.json"), '{"mcpServers": []}');
    await assert.rejects(claudeCode.installMcp!({ server: SERVER, dryRun: true }), /not an object/);
  });

  it("uses each agent's entry shape", async () => {
    await claudeCode.installMcp!({ server: SERVER, dryRun: false });
    await opencode.installMcp!({ server: SERVER, dryRun: false });
    await geminiCli.installMcp!({ server: SERVER, dryRun: false });
    assert.deepEqual(json(readFileSync(join(t.home, ".claude.json"), "utf8")).mcpServers!["coding-sh"], { type: "stdio", command: SERVER.command, args: SERVER.args, env: {} });
    assert.deepEqual(json(readFileSync(join(t.home, ".config", "opencode", "opencode.json"), "utf8")).mcp!["coding-sh"], { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true });
    assert.deepEqual(json(readFileSync(join(t.home, ".gemini", "settings.json"), "utf8")).mcpServers!["coding-sh"], { command: SERVER.command, args: SERVER.args });
  });

  it("honors CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(t.root, "claude-dir");
    process.env.CODEX_HOME = join(t.root, "codex-home");
    const [a] = await claudeCode.installMcp!({ server: SERVER, dryRun: true });
    const [b] = await codex.installMcp!({ server: SERVER, dryRun: true });
    assert.equal(a!.path, join(t.root, "claude-dir", ".claude.json"));
    assert.equal(b!.path, join(t.root, "codex-home", "config.toml"));
  });
});
