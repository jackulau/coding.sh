// `coding.sh tree` end to end under a throwaway home: a backfilled Claude Code
// session with one subagent (the parent transcript plus its subagents/ file).
// From the top-level session the command shows the whole run as one tree with
// rolled-up totals and points at the worst-flagged node to fix first; from the
// subagent it shows the subagent's part, and --all the whole run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeTestDir } from "../_rm.ts";
import { CLI } from "../_cli.ts";
import { fixFirstRole } from "../../src/cli/commands/tree.ts";

const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/config", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
const SUB = `${SID}:sub:abc123`;
/** What a tree line prints for SUB, whose id is over 40 characters: 8 characters of each part. */
const SUB_REF = "11111111:sub:abc123";
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
    // A read that runs past its budget (a loaded machine) starts a detached ingest in this home; on
    // Windows it would still hold the store when `after` removes it.
    CODING_SH_NO_AUTO_INGEST: "1",
    NO_COLOR: "1",
  };
  const r = run("ingest", "--backfill", "--agent", "claude-code");
  assert.equal(r.status, 0, r.stderr);
});

after(() => removeTestDir(root));

describe("coding.sh tree", () => {
  test("from a session, shows the whole run with rolled-up totals and the node to fix first", () => {
    const r = run("tree", SID);
    assert.equal(r.status, 0, r.stderr);
    // The top-level agent by full id and its subagent, nested, by the reference that opens it: its
    // id is over 40 characters.
    assert.match(r.stdout, new RegExp(`${SID}\\b`));
    assert.match(r.stdout, new RegExp(`^  └ ${SUB_REF}  `, "m"));
    // Rollup headline and the union of flags across the loop.
    assert.match(r.stdout, /1 subagent/);
    assert.match(r.stdout, /flags across the loop:.*premature-completion/);
    // Points at the worst-flagged node to fix first (the "Open it" hint is on stderr).
    assert.match(r.stdout, /Fix first/);
    assert.match(r.stdout, new RegExp(`the top-level agent ${SID}\\b`));
    assert.match(r.stderr, new RegExp(`coding\\.sh show ${SID}\\b`));
  });

  // `tree <subagent>` printed the whole run of its top-level agent: 688 lines for one subagent.
  test("from a subagent, shows the subagent's part and names the sessions above it", () => {
    const r = run("tree", SUB);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^in: 11111111 claude-code$/m, "one line names the top-level agent by short id");
    assert.match(r.stdout, new RegExp(`^${SUB_REF}  `, "m"), "the subagent is the tree's root line");
    assert.doesNotMatch(r.stdout, new RegExp(`^${SID}  `, "m"), "the top-level agent is not a node");
    assert.match(r.stdout, /0 subagents/);
    assert.match(r.stderr, new RegExp(`coding\\.sh tree ${SUB} --all`));

    const doc = json("tree", SUB);
    assert.deepEqual(doc.ancestors, [{ id: SID, agent: "claude-code", role: "root" }]);
    assert.equal((doc.totals as Record<string, unknown>).sessions, 1);
    const tree = doc.tree as Record<string, unknown>[];
    assert.deepEqual(tree.map((n) => [n.id, n.depth, (n.children as unknown[]).length]), [[SUB, 1, 0]], "depth counts from the top-level agent");
    assert.notEqual(tree[0]!.role, "root");
  });

  test("--all resolves the whole tree from the subagent's own id", () => {
    const doc = json("tree", SUB, "--all");
    assert.equal("ancestors" in doc, false);
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
    assert.equal(run("tree", SUB, "--all").stdout, run("tree", SID).stdout);
  });

  test("a top-level session shows its whole tree, with or without --all", () => {
    const r = run("tree", SID);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^in: /m);
    assert.equal(r.stdout, run("tree", SID, "--all").stdout);
    assert.doesNotMatch(r.stderr, /--all/);
    assert.equal("ancestors" in json("tree", SID), false);
  });

  test("an unknown id is a clean error, not a crash", () => {
    const r = run("tree", "no-such-session");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr + r.stdout, /no-such-session|not found|No session/i);
  });
});

// A subagent whose type is "subagent" (T3 Code delegates) was named "subagent subagent <id>".
test("the Fix first line names the role once", () => {
  assert.equal(fixFirstRole(0, "subagent"), "the top-level agent");
  assert.equal(fixFirstRole(1, "subagent"), "subagent");
  assert.equal(fixFirstRole(2, undefined), "subagent");
  assert.equal(fixFirstRole(1, "Explore"), "subagent Explore");
});
