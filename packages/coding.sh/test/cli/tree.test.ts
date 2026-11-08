// `coding.sh tree` end to end under a throwaway home: a backfilled Claude Code
// session with one subagent (the parent transcript plus its subagents/ file).
// The command shows the whole run as one tree with rolled-up totals and points
// at the worst-flagged node to fix first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/config", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
const SUB = `${SID}:sub:abc123`;
let root = "";
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: root });
const json = (...args: string[]) => {
  const r = run(...args, "--json");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-tree-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: CONFIG,
    CODEX_HOME: join(root, "codex"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  const r = run("ingest", "--backfill", "--agent", "claude-code");
  assert.equal(r.status, 0, r.stderr);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("coding.sh tree", () => {
  test("from a session, shows the whole run with rolled-up totals and the node to fix first", () => {
    const r = run("tree", SID);
    assert.equal(r.status, 0, r.stderr);
    // The top-level agent and its subagent, nested, both by full id.
    assert.match(r.stdout, new RegExp(`${SID}\\b`));
    assert.match(r.stdout, new RegExp(`└ ${SUB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // Rollup headline and the union of flags across the loop.
    assert.match(r.stdout, /1 subagent/);
    assert.match(r.stdout, /flags across the loop:.*premature-completion/);
    // Points at the worst-flagged node to fix first (the "Open it" hint is on stderr).
    assert.match(r.stdout, /Fix first/);
    assert.match(r.stdout, new RegExp(`the top-level agent ${SID}\\b`));
    assert.match(r.stderr, new RegExp(`coding\\.sh show ${SID}\\b`));
  });

  test("resolves the same tree from the subagent's own id", () => {
    const doc = json("tree", SUB);
    const totals = doc.totals as Record<string, unknown>;
    assert.equal(totals.sessions, 2);
    assert.equal((doc.tree as unknown[]).length, 1, "one root");
    const rootNode = (doc.tree as Record<string, unknown>[])[0]!;
    assert.equal(rootNode.id, SID);
    assert.equal((rootNode.children as unknown[]).length, 1);
    assert.equal((rootNode.children as Record<string, unknown>[])[0]!.id, SUB);
    const worst = doc.worst as Record<string, unknown>;
    assert.equal(worst.id, SID);
    assert.ok((worst.flags as string[]).includes("premature-completion"));
  });

  test("an unknown id is a clean error, not a crash", () => {
    const r = run("tree", "no-such-session");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr + r.stdout, /no-such-session|not found|No session/i);
  });
});
