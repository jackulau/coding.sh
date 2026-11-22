// `show` is a read: it writes nothing into the store. A session's end-snapshot diff is read from
// the shadow repo that took the snapshots; a store without one (copied from another machine, or
// cleaned by gc) shows the session without the diff and gets no repos folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import { paths } from "../../src/core/paths.ts";
import { snapshot } from "../../src/core/snapshot.ts";
import type { Session } from "../../src/core/types.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const T0 = 1_700_000_000_000;
let taken: Sandbox; // the store whose shadow repo took the snapshots
let copied: Sandbox; // the same session in a store with no shadow repo
let session: Session | undefined;

before(async () => {
  taken = sandbox();
  copied = sandbox();
  const repo = join(taken.root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# demo\n");
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).status;
  if (git("init", "-q") !== 0) return; // snapshots need git
  assert.equal(git("add", "-A"), 0);
  assert.equal(git("commit", "-qm", "init"), 0);
  const start = await snapshot(repo, { env: taken.env });
  writeFileSync(join(repo, "hello.txt"), "hi\n"); // as a Bash tool would
  const end = await snapshot(repo, { env: taken.env });
  assert.ok(start?.snapshot && end?.snapshot && start.snapshot !== end.snapshot);
  session = mkSession("snap-1", T0, { repo: start, endSnapshot: end.snapshot });
  await taken.seed([session]);
  await copied.seed([session]);
});
after(() => {
  taken?.cleanup();
  copied?.cleanup();
});

test("show reads the end-snapshot diff from the shadow repo that took it", async (t) => {
  if (!session) return t.skip("no git");
  const r = await runCmd(show, taken, { positionals: ["snap-1"], json: true });
  assert.deepEqual(r.json.snapshot.files.map((f: { path: string; status: string }) => [f.path, f.status]), [["hello.txt", "add"]]);
});

test("show on a session with changes, in a store with no shadow repo, writes no repos folder", async (t) => {
  if (!session) return t.skip("no git");
  const repos = paths(copied.env).repos;
  assert.equal(existsSync(repos), false);
  const text = await runCmd(show, copied, { positionals: ["snap-1"] });
  assert.equal(text.code, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /Snapshot/);
  const json = await runCmd(show, copied, { positionals: ["snap-1"], json: true });
  assert.equal(json.json.snapshot, null);
  assert.equal(existsSync(repos), false, "no shadow repo created by a read");
});
