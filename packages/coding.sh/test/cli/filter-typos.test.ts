// export, search and usage find nothing because a --flag, flag: or --agent value was typed wrong: each
// names the value it meant and exits 2, as `sessions` does, and export --evidence --force leaves the
// directory as it was.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLI } from "../_cli.ts";
import { mkSession, sandbox, type Sandbox } from "./_cmd.ts";

let sb: Sandbox;
before(async () => {
  sb = sandbox();
  const t = Date.now() - 3_600_000;
  await sb.seed([mkSession("verified", t, { flags: ["no-verification"] }), mkSession("tagged", t - 60_000, { flags: ["my-own-tag"] }), mkSession("plain", t - 120_000)]);
});
after(() => sb.cleanup());

const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: sb.root, env: sb.env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
/** The error a --json run prints on stderr. */
const jsonError = (stderr: string) => JSON.parse(stderr.trim().split("\n").pop()!) as { reason: string; next?: string[] };
const sessionDirs = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

test("export sessions --flag no-verificaton names the flag it meant, exits 2 and prints no rows", () => {
  const r = cli(["export", "sessions", "--flag", "no-verificaton"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /Unknown session flag "no-verificaton"/);
  assert.match(r.stderr, /Did you mean --flag no-verification\?/);
  assert.equal(r.stdout, "");
});

test("a flag: term in --where, for events and labels too", () => {
  for (const kind of ["events", "labels"]) {
    const r = cli(["export", kind, "--where", "flag:no-verificaton"]);
    assert.equal(r.status, 2, `${kind}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Did you mean flag:no-verification\?/, kind);
  }
});

test("export sessions --agent claud-code names the agent it meant", () => {
  const r = cli(["export", "sessions", "--agent", "claud-code"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /Unknown agent "claud-code"/);
  assert.match(r.stderr, /Did you mean --agent claude-code\?/);
});

test("a flag coding.sh sets that no session has is an empty export, exit 0", () => {
  const r = cli(["export", "sessions", "--flag", "compaction"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /Exported 0 sessions/);
});

test("when something matched, the typo is not checked", () => {
  const r = cli(["export", "sessions", "--where", "flag:no-verificaton OR flag:my-own-tag"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id), ["tagged"]);
});

test("export --evidence --force with a typo refuses before it clears what an earlier export wrote", () => {
  const dir = join(sb.root, "ev");
  const first = cli(["export", "--evidence", dir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(sessionDirs(dir), ["plain", "tagged", "verified"]);
  const r = cli(["export", "--evidence", dir, "--force", "--flag", "no-verificaton", "--json"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const e = jsonError(r.stderr);
  assert.equal(e.reason, "unknown_flag");
  assert.ok(e.next?.includes("--flag no-verification"), r.stderr);
  assert.deepEqual(sessionDirs(dir), ["plain", "tagged", "verified"]);
});

test("search with an --agent or flag: typo names the one it meant, in --json too", () => {
  const agent = cli(["search", "deploy", "--agent", "claud-code"]);
  assert.equal(agent.status, 2, agent.stdout + agent.stderr);
  assert.match(agent.stderr, /Did you mean --agent claude-code\?/);
  const flag = cli(["search", "deploy", "--where", "flag:no-verificaton", "--json"]);
  assert.equal(flag.status, 2, flag.stdout + flag.stderr);
  const e = jsonError(flag.stderr);
  assert.equal(e.reason, "unknown_flag");
  assert.ok(e.next?.includes("flag:no-verification"), flag.stderr);
});

test("search with a real flag and no hits is still no matches, exit 0", () => {
  const r = cli(["search", "deploy", "--where", "flag:compaction"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /No matches for "deploy"/);
});

test("usage with a flag: typo names the flag it meant, by agent and by an attributed group", () => {
  for (const by of ["agent", "mcp"]) {
    const r = cli(["usage", "--by", by, "--where", "flag:no-verificaton"]);
    assert.equal(r.status, 2, `${by}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Unknown session flag "no-verificaton"/, by);
    assert.match(r.stderr, /Did you mean flag:no-verification\?/, by);
  }
  const real = cli(["usage", "--where", "flag:compaction"]);
  assert.equal(real.status, 0, real.stderr);
});
