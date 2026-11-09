// Uninstall puts hook config files back exactly as the user had them (QA: init →
// uninstall re-serialized ~/.claude/settings.json and deleted a pre-existing "{}").
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { cursor } from "../../src/adapters/cursor.ts";
import { antigravityAdapter } from "../../src/adapters/more/antigravity.ts";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import type { Adapter } from "../../src/core/types.ts";
import { writeFile } from "./_helpers.ts";
import { moreEnv } from "./more/_helpers.ts";
import type { TmpEnv } from "./_helpers.ts";

const COMPACT = '{"model":"opus","hooks":{"PreToolUse":[{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo mine" } ] }]}}';

let env: TmpEnv;
beforeEach(() => {
  env = moreEnv();
  process.env.PATH = join(env.root, "nobin"); // no agent binaries
});
afterEach(() => env.restore());

const hookCommand = () => join(env.dataHome, "bin", "hook.mjs");
const installs = () => JSON.parse(readFileSync(join(env.dataHome, "installs.json"), "utf8")).files as Record<string, unknown>;

async function roundTrip(a: Adapter, file: string, original: string | undefined, withMcp = false): Promise<void> {
  if (original !== undefined) writeFile(file, original);
  const c = await a.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
  assert.equal(c.length, 1, `${a.id}: install changed the file`);
  if (withMcp) await a.installMcp!({ server: { name: "coding-sh", command: "node", args: ["mcp.mjs"] }, dryRun: false });
  assert.notEqual(readFileSync(file, "utf8"), original);
  assert.ok(file in installs(), `${a.id}: ${file} recorded in installs.json`);
  // Same order as `coding.sh uninstall`: MCP first, then hooks.
  if (withMcp) await a.uninstallMcp!({ name: "coding-sh", dryRun: false });
  await a.uninstall({ scope: "user", dryRun: false });
  if (original === undefined) assert.ok(!existsSync(file), `${a.id}: file coding.sh created is removed`);
  else assert.equal(readFileSync(file, "utf8"), original, `${a.id}: byte-for-byte restore`);
  assert.ok(!(file in installs()), `${a.id}: record dropped`);
}

describe("hook uninstall restores the user's file byte-for-byte", () => {
  it("claude-code: compact one-line settings.json", () => roundTrip(claudeCode, join(env.home, ".claude", "settings.json"), COMPACT));
  it("claude-code: a pre-existing '{}' is restored, not deleted", () => roundTrip(claudeCode, join(env.home, ".claude", "settings.json"), "{}"));
  it("claude-code: a file coding.sh created is deleted", () => roundTrip(claudeCode, join(env.home, ".claude", "settings.json"), undefined));
  it("codex: hooks.json", () => roundTrip(codex, join(env.home, ".codex", "hooks.json"), '{"hooks":{}}'));
  it("cursor: hooks.json with only {version:1}", () => roundTrip(cursor, join(env.home, ".cursor", "hooks.json"), '{"version":1}'));
  it("gemini-cli: settings.json shared by hooks and the MCP server", () =>
    roundTrip(geminiCliAdapter, join(env.home, ".gemini", "settings.json"), '// mine\n{"theme":"dark",\n "mcpServers":{}}', true));
  it("antigravity: ~/.gemini/config/hooks.json", () => roundTrip(antigravityAdapter, join(env.home, ".gemini", "config", "hooks.json"), "{}"));

  it("falls back to stripping our entries once the user edited the file, and never deletes a file that existed", async () => {
    const file = join(env.home, ".claude", "settings.json");
    writeFile(file, "{}");
    await claudeCode.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    writeFile(file, JSON.stringify(cfg)); // user/agent rewrote it (same content, new bytes)
    await claudeCode.uninstall({ scope: "user", dryRun: false });
    assert.ok(existsSync(file), "pre-existing file kept");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});

    writeFile(file, '{"model":"x"}');
    await claudeCode.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.model = "y";
    writeFile(file, JSON.stringify(edited, null, 2));
    await claudeCode.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "y" }, "the user's later edit survives");
  });

  it("leaves a file holding none of our hooks untouched", async () => {
    const file = join(env.home, ".claude", "settings.json");
    writeFile(file, '{"hooks":{}}');
    assert.deepEqual(await claudeCode.uninstall({ scope: "user", dryRun: false }), []);
    assert.equal(readFileSync(file, "utf8"), '{"hooks":{}}');
  });
});

describe("antigravity + gemini-cli detection", () => {
  it("an Antigravity install/uninstall cycle does not make Gemini CLI look installed", async () => {
    assert.equal((await geminiCliAdapter.detect()).installed, false);
    await antigravityAdapter.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    assert.equal((await geminiCliAdapter.detect()).installed, false, "~/.gemini/config alone is not Gemini CLI");
    await antigravityAdapter.uninstall({ scope: "user", dryRun: false });
    assert.ok(!existsSync(join(env.home, ".gemini")), "empty dirs the Antigravity hook needed are removed");
    assert.equal((await geminiCliAdapter.detect()).installed, false);
  });

  it("keeps ~/.gemini when it holds anything else; Gemini CLI settings.json still counts as installed", async () => {
    mkdirSync(join(env.home, ".gemini", "antigravity-cli"), { recursive: true });
    await antigravityAdapter.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    await antigravityAdapter.uninstall({ scope: "user", dryRun: false });
    assert.ok(!existsSync(join(env.home, ".gemini", "config")));
    assert.ok(existsSync(join(env.home, ".gemini", "antigravity-cli")));
    writeFile(join(env.home, ".gemini", "settings.json"), "{}");
    assert.equal((await geminiCliAdapter.detect()).installed, true);
  });
});

// INS-2: a symlinked config (stow-style dotfiles) stays a symlink; the writes
// land in the dotfiles target, and uninstall restores the target's bytes.
describe("symlinked agent configs stay symlinks", () => {
  async function linked(a: Adapter, file: string, original: string, withMcp = false): Promise<void> {
    const target = join(env.home, "dotfiles", `${a.id}-settings.json`);
    writeFile(target, original);
    mkdirSync(join(file, ".."), { recursive: true });
    symlinkSync(target, file);
    await a.install({ hookCommand: hookCommand(), scope: "user", dryRun: false });
    if (withMcp) await a.installMcp!({ server: { name: "coding-sh", command: "node", args: ["mcp.mjs"] }, dryRun: false });
    assert.ok(lstatSync(file).isSymbolicLink(), `${a.id}: still a symlink after install`);
    assert.equal(readlinkSync(file), target);
    assert.match(readFileSync(target, "utf8"), /hook\.(?:mjs|sh)/, `${a.id}: the dotfiles target holds the hooks`);
    assert.deepEqual(readdirSync(join(target, "..")).sort(), [`${a.id}-settings.json`], "no temp file left next to the target");
    if (withMcp) await a.uninstallMcp!({ name: "coding-sh", dryRun: false });
    await a.uninstall({ scope: "user", dryRun: false });
    assert.ok(lstatSync(file).isSymbolicLink(), `${a.id}: still a symlink after uninstall`);
    assert.equal(readFileSync(target, "utf8"), original, `${a.id}: target restored byte-for-byte`);
  }

  it("claude-code settings.json (shared atomicWrite)", () => linked(claudeCode, join(env.home, ".claude", "settings.json"), '{"model":"opus"}\n'));
  it("gemini-cli settings.json (more/_util applyWrites + MCP writer)", () => linked(geminiCliAdapter, join(env.home, ".gemini", "settings.json"), '{\n  "theme": "GitHub"\n}\n', true));
});

