// Hands-on QA, round 4: relative times never print "just now", blame and improve check outside a
// git repo name the fix with their own command, and config set takes the [proxy] keys proxy --help
// documents.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import * as blame from "../../src/cli/commands/blame.ts";
import * as config from "../../src/cli/commands/config.ts";
import * as improve from "../../src/cli/commands/improve.ts";
import { ago, CliError } from "../../src/cli/output.ts";
import { UsageError } from "../../src/cli/args.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));
function box(): Sandbox {
  const sb = sandbox();
  boxes.push(sb);
  return sb;
}

describe("relative times", () => {
  test("under a second reads 0s ago, never the word just", () => {
    const now = Date.now();
    assert.equal(ago(now, { now }), "0s ago");
    assert.doesNotMatch(ago(now - 10, { now }), /\bjust\b/);
  });
});

describe("outside a git repo", () => {
  test("blame names blame --repo, not attribution", async () => {
    const sb = box();
    const dir = join(sb.root, "plain");
    mkdirSync(dir);
    const r = await runCmd(blame, sb, { positionals: ["AGENTS.md"], cwd: dir, json: true });
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.reason, "not_a_repo");
    assert.deepEqual(r.error.next, ["Run it inside a git repository, or pass one:", "coding.sh blame <path> --repo <dir>"]);
  });

  test("improve check, with or without --repo all, is not_a_repo and names --repo <dir>", async () => {
    const sb = box();
    const dir = join(sb.root, "plain");
    mkdirSync(dir);
    for (const flags of [{}, { repo: "all" }]) {
      const r = await runCmd(improve, sb, { action: "check", flags, cwd: dir, json: true });
      assert.ok(r.error instanceof CliError && !(r.error instanceof UsageError), String(r.error));
      assert.equal(r.error.reason, "not_a_repo");
      assert.equal(r.error.exitCode, 1);
      assert.deepEqual(r.error.next, ["Run it inside a git repository, or pass one:", "coding.sh improve check --repo <dir>"]);
    }
  });
});

describe("config set", () => {
  test("takes the [proxy] keys proxy --help documents and refuses a bad value", async () => {
    const sb = box();
    const s = await runCmd(config, sb, { action: "set", positionals: ["proxy.port", "4400"], json: true });
    assert.equal(s.error, undefined, String(s.error));
    const g = await runCmd(config, sb, { action: "get", positionals: ["proxy.port"], json: true });
    assert.equal(g.json.value, 4400);
    assert.match(readFileSync(join(sb.env.CODING_SH_HOME!, "config.toml"), "utf8"), /\[proxy\]\r?\nport = 4400/);
    const h = await runCmd(config, sb, { action: "set", positionals: ["proxy.host", "0.0.0.0"], json: true });
    assert.equal(h.error, undefined, String(h.error));
    const bad = await runCmd(config, sb, { action: "set", positionals: ["proxy.port", "99999"] });
    assert.equal((bad.error as UsageError | undefined)?.reason, "invalid_value");
    const url = await runCmd(config, sb, { action: "set", positionals: ["proxy.anthropic_upstream", "ftp://x"] });
    assert.equal((url.error as UsageError | undefined)?.reason, "invalid_value");
  });

  test("a misspelled key gets a suggestion", async () => {
    const r = await runCmd(config, box(), { action: "set", positionals: ["retention.keepSpoolDay", "7"] });
    assert.ok(r.error instanceof UsageError);
    assert.equal(r.error.suggestion, "coding.sh config set retention.keepSpoolDays 7");
  });
});
