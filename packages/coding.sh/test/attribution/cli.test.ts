// `coding.sh attribution`, `attribution export` and `blame` end to end: the
// fixture repo's sessions stored in a throwaway home, the CLI run from source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateAgentTrace } from "../../src/attribution/export.ts";
import { openContext } from "../../src/core/context.ts";
import { isolate, removeTmp, tmp } from "../capture/_helpers.ts";
import { buildFixture, type Fixture } from "./_fixture.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let fx: Fixture;
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: fx.root });
const json = (...args: string[]) => {
  const r = run(...args, "--json");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
};

before(async () => {
  isolate();
  fx = await buildFixture();
  const home = tmp("csh-attr-home-");
  mkdirSync(join(home, "codex"), { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  const ctx = await openContext({ env, cwd: fx.root });
  try {
    for (const s of Object.values(fx.sessions)) await ctx.index.upsertSession(s);
    for (const s of Object.values(fx.sessions)) await ctx.index.putEvents(await fx.index.listEvents(s.id));
  } finally {
    await ctx.close();
  }
});
after(() => removeTmp());

describe("coding.sh attribution / blame", () => {
  test("attribution --json: per commit, agent lines and the sessions that wrote them", () => {
    const doc = json("attribution");
    const commits = doc.commits as { commit: string; attributed: number; added: number; attributions: { sessionId: string }[] }[];
    // Newest first, commits with agent lines only: C3', C2, C1 (the human commit is left out).
    assert.deepEqual(commits.map((c) => c.commit), [fx.commits.c3Rebased, fx.commits.c2, fx.commits.c1]);
    assert.deepEqual(commits.map((c) => [...new Set(c.attributions.map((a) => a.sessionId))]), [["s3-claude"], ["s2-codex"], ["s1-claude"]]);
    const all = json("attribution", "--all").commits as { commit: string; attributed: number }[];
    assert.equal(all.find((c) => c.commit === fx.commits.h)!.attributed, 0);
  });

  test("attribution prints a table on stdout, progress on stderr", () => {
    const r = run("attribution");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /4 commits since .*: \d+ of \d+ added lines by 3 sessions/);
    assert.match(r.stdout, new RegExp(fx.commits.c3Rebased.slice(0, 8)));
    assert.doesNotMatch(r.stdout, new RegExp(fx.commits.h.slice(0, 8)));
  });

  test("blame path:range --json names the session per line; human lines have none", () => {
    const doc = json("blame", "src/math.ts:1-21");
    const lines = doc.lines as { line: number; sessionId?: string }[];
    const want = fx.expected["src/math.ts"]!;
    for (const l of lines) if (want[l.line - 1] !== undefined) assert.equal(l.sessionId ?? null, want[l.line - 1], `line ${l.line}`);
    assert.deepEqual((doc.sessions as { id: string }[]).map((s) => s.id).sort(), ["s1-claude", "s2-codex", "s3-claude"]);
    const r = run("blame", "src/util.ts");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /src\/util\.ts at [0-9a-f]{8}: 8 of 11 lines by 1 agent session/);
    assert.match(r.stdout, /coding\.sh show s2-codex|SESSION/);
  });

  test("attribution export writes schema-valid Agent Trace JSONL", () => {
    const r = run("attribution", "export");
    assert.equal(r.status, 0, r.stderr);
    const records = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { vcs: { revision: string } });
    assert.deepEqual(records.map((x) => x.vcs.revision), [fx.commits.c1, fx.commits.c2, fx.commits.c3Rebased]);
    for (const x of records) assert.deepEqual(validateAgentTrace(x), []);
    const out = join(tmp("csh-attr-out-"), "trace.jsonl");
    const w = run("attribution", "export", "--out", out, "--viewer-url", "https://csh.example.invalid");
    assert.equal(w.status, 0, w.stderr);
    assert.equal(w.stdout.trim(), out);
    const saved = readFileSync(out, "utf8").trim().split("\n");
    assert.equal(saved.length, 3);
    assert.match(saved[0]!, /https:\/\/csh\.example\.invalid\/#\/s\/s1-claude/);
    const doc = json("attribution", "export");
    assert.equal(doc.version, "0.1");
    assert.equal((doc.records as unknown[]).length, 3);
  });

  test("errors carry a reason and the next step", () => {
    const bad = run("attribution", "--rev", "no-such-branch", "--json");
    assert.equal(bad.status, 1);
    const err = JSON.parse(bad.stderr) as { status: string; reason: string; next: string[] };
    assert.equal(err.reason, "unknown_rev");
    assert.ok(err.next.length > 0);
    const outside = spawnSync(process.execPath, ["--no-warnings", CLI, "attribution", "--json"], { env, encoding: "utf8", cwd: tmp("csh-not-repo-") });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /"reason":"not_a_repo"/);
    const fmt = run("attribution", "export", "--format", "csv");
    assert.equal(fmt.status, 2);
  });
});
