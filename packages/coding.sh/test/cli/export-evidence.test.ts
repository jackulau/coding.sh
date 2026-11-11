// export --evidence: the --force hint is one pasteable command, and --force replaces what an earlier run wrote.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as exportCmd from "../../src/cli/commands/export.ts";
import type { CliError } from "../../src/cli/output.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

let sb: Sandbox;
before(async () => {
  sb = sandbox();
  const now = Date.now();
  await sb.seed([mkSession("sess-a", now - 3000), mkSession("sess-b", now - 2000), mkSession("sess-c", now - 1000)]);
});
after(() => sb.cleanup());

const sessionDirs = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

test("the hint quotes a directory with a space and keeps the flags that were given", async () => {
  const dir = join(sb.root, "my traces");
  const first = await runCmd(exportCmd, sb, { flags: { evidence: dir } });
  assert.equal(first.error, undefined, String(first.error));
  const argv = ["export", "--evidence", dir, "--limit", "2"];
  const again = await runCmd(exportCmd, sb, { flags: { evidence: dir, limit: 2 }, argv });
  const err = again.error as CliError;
  assert.equal(err.reason, "target_exists");
  assert.equal(err.next.length, 2);
  assert.match(err.next[1]!, /^coding\.sh export --evidence '.*my traces' --limit 2 --force$/);
});

test("--force with --limit 1 leaves one session in the directory", async () => {
  const dir = join(sb.root, "ev");
  await runCmd(exportCmd, sb, { flags: { evidence: dir } });
  assert.equal(sessionDirs(dir).length, 3);
  const r = await runCmd(exportCmd, sb, { flags: { evidence: dir, limit: 1, force: true } });
  assert.equal(r.error, undefined, String(r.error));
  assert.deepEqual(sessionDirs(dir), ["sess-c"]);
  assert.ok(existsSync(join(dir, "index.md")));
});
