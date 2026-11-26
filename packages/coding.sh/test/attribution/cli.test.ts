// `coding.sh attribution`, `attribution export` and `blame` end to end: the
// fixture repo's sessions stored in a throwaway home, the CLI run against it, and
// the same sessions under ids too long to print whole, and the next step when nothing can be matched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { validateAgentTrace } from "../../src/attribution/export.ts";
import { openContext } from "../../src/core/context.ts";
import { snapshot } from "../../src/core/snapshot.ts";
import { noSessionsNext } from "../../src/cli/first-session.ts";
import { cliCommand, nextStepBin } from "../../src/cli/next-steps.ts";
import type { Session } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { isolate, makeRepo, removeTmp, tmp } from "../capture/_helpers.ts";
import { buildFixture, HOUR, makeSession, ROOMY, type Fixture } from "./_fixture.ts";
import { CLI } from "../_cli.ts";

let fx: Fixture;
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: fx.root });
const json = (...args: string[]) => {
  const r = run(...args, "--json");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
};

/** The env that runs the CLI in a throwaway home whose store holds the fixture's sessions. */
async function homeFor(f: Fixture): Promise<NodeJS.ProcessEnv> {
  const home = tmp("csh-attr-home-");
  mkdirSync(join(home, "codex"), { recursive: true });
  const e = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  const ctx = await openContext({ env: e, cwd: f.root });
  try {
    for (const s of Object.values(f.sessions)) await ctx.index.upsertSession(s);
    for (const s of Object.values(f.sessions)) await ctx.index.putEvents(await f.index.listEvents(s.id));
  } finally {
    await ctx.close();
  }
  return e;
}

before(async () => {
  isolate();
  fx = await buildFixture();
  env = await homeFor(fx);
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

  test("the next steps name the CLI as the user's shell runs it", () => {
    // Under npx (npm_command=exec) they name the npx command, on every OS.
    const npxEnv = { ...env, npm_command: "exec" };
    const npx = nextStepBin(npxEnv);
    const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: npxEnv, encoding: "utf8", cwd });
    const next = (r: { stderr: string }) => (JSON.parse(r.stderr) as { next: string[] }).next;
    const outside = cli(tmp("csh-not-repo-"), "attribution", "--json");
    assert.equal(outside.status, 1, outside.stderr);
    assert.deepEqual(next(outside), ["Run it inside a git repository, or pass one:", `${npx} attribution --repo <dir>`]);
    const url = cli(fx.root, "attribution", "export", "--viewer-url", "ftp://x", "--json");
    assert.equal(url.status, 2, url.stderr);
    assert.deepEqual(next(url), ["Did you mean:", `${npx} attribution export --viewer-url http://127.0.0.1:4319`]);
    const list = cli(fx.root, "attribution");
    assert.equal(list.status, 0, list.stderr);
    assert.ok(list.stderr.includes(`${npx} blame <path>`), list.stderr);
    const blame = cli(fx.root, "blame", "src/util.ts");
    assert.equal(blame.status, 0, blame.stderr);
    assert.ok(blame.stderr.includes(`${npx} show s2-codex`), blame.stderr);
  });
});

// The same story with S1 named latest. `show latest` opens the newest session (S3), not S1.
describe("blame, when the session that wrote the most is named latest", () => {
  let fx2: Fixture;
  let env2: NodeJS.ProcessEnv;
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: env2, encoding: "utf8", cwd: fx2.root });
  before(async () => {
    isolate();
    fx2 = await buildFixture({ s1: "latest" });
    env2 = await homeFor(fx2);
  });

  test("its next step names the session by a reference that opens it", () => {
    const r = cli("blame", "README.md");
    assert.equal(r.status, 0, r.stderr);
    const show = `${nextStepBin(env2)} show `;
    const ref = r.stderr.split("\n").map((l) => l.trim()).find((l) => l.startsWith(show))?.slice(show.length);
    assert.ok(ref, r.stderr);
    const shown = cli("show", ref, "--json", "--fields", "session.id");
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).session.id, "latest", `${show}${ref}`);
  });
});

// T3 Code names a session after its thread: ids over 200 characters that hold % and share their
// first 8 characters. The same sessions under such ids, in a store of their own.
describe("coding.sh attribution / blame: session ids over 200 characters", () => {
  const SHARED = `t3code-thread%3Aproj%253Ademo%253A${"abcdefghij".repeat(17)}`;
  const LONG: Record<string, string> = { "s1-claude": `${SHARED}-first`, "s2-codex": `${SHARED}-second`, "s3-claude": `${SHARED}-third` };
  let longEnv: NodeJS.ProcessEnv;
  const runLong = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: longEnv, encoding: "utf8", cwd: fx.root });
  const jsonLong = (...args: string[]) => {
    const r = runLong(...args, "--json");
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  /** The session `show` opens for a reference: asked once per reference. */
  const opened = new Map<string, string>();
  const opens = (ref: string): string => {
    let id = opened.get(ref);
    if (id === undefined) {
      id = (jsonLong("show", ref, "--fields", "session").session as { id: string }).id;
      opened.set(ref, id);
    }
    return id;
  };
  /** A reference a person can paste back: short, with nothing a shell or URL would mangle. */
  const pasteable = (ref: string) => assert.ok(ref.length <= 40 && !ref.includes("%"), ref);
  /** Off a TTY a table is its header row, then one tab-separated row per line. */
  const tableRows = (stdout: string, header: string) => {
    const lines = stdout.split("\n");
    const at = lines.indexOf(header);
    assert.notEqual(at, -1, stdout);
    return lines.slice(at + 1).filter((l) => l.includes("\t")).map((l) => l.split("\t"));
  };

  before(async () => {
    const db = join(tmp("csh-attr-long-"), "index.db");
    const index = await SqliteIndexStore.open(db);
    try {
      await index.migrate();
      for (const s of Object.values(fx.sessions)) {
        const id = LONG[s.id]!;
        await index.upsertSession({ ...s, id });
        await index.putEvents((await fx.index.listEvents(s.id)).map((e) => ({ ...e, sessionId: id })));
      }
    } finally {
      await index.close();
    }
    longEnv = { ...env, CODING_SH_STORE_URL: `sqlite://${db}` };
  });

  test("blame names each line's session, and each session in its table, by a reference show opens", () => {
    const doc = jsonLong("blame", "src/math.ts");
    const wrote = new Map((doc.lines as { line: number; sessionId?: string }[]).flatMap((l) => (l.sessionId ? [[l.line, l.sessionId] as const] : [])));
    assert.deepEqual([...new Set(wrote.values())].sort(), Object.values(LONG).sort(), "each of the three sessions wrote lines of the file");
    const r = runLong("blame", "src/math.ts");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /t3code-thread/, "no line prints an id over 200 characters");
    const lines = [...r.stdout.matchAll(/^ *(\d+) {2}[0-9a-f]{8} {2}(\S+) /gm)].filter((m) => m[2] !== "-");
    assert.equal(lines.length, wrote.size, r.stdout);
    for (const [, line, ref] of lines) {
      pasteable(ref!);
      assert.equal(opens(ref!), wrote.get(Number(line)), `line ${line}`);
    }
    const table = tableRows(r.stdout, "SESSION\tAGENT\tMODEL\tLINES").map((row) => row[0]!);
    for (const ref of table) pasteable(ref);
    assert.deepEqual(table.map(opens), (doc.sessions as { id: string }[]).map((s) => s.id));
  });

  test("attribution names each commit's sessions by a reference show opens", () => {
    const doc = jsonLong("attribution");
    const r = runLong("attribution");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /t3code-thread/);
    const cells = tableRows(r.stdout, "COMMIT\tDATE\tAGENT LINES\tSESSIONS\tSUBJECT").map((row) => row[3]!.split(", ").map((x) => x.split(" ")[0]!));
    for (const ref of cells.flat()) pasteable(ref);
    const want = (doc.commits as { attributions: { sessionId: string }[] }[]).map((c) => [...new Set(c.attributions.map((a) => a.sessionId))]);
    assert.deepEqual(cells.map((refs) => refs.map(opens)), want);
    assert.deepEqual(want.flat().sort(), Object.values(LONG).sort(), "each of the three sessions wrote a commit");
  });
});

// Nothing in the repo can be matched: what the list says, and a next step that fits what the store holds.
describe("coding.sh attribution: the next step when nothing can be matched", () => {
  let other: string;
  const cliIn = (e: NodeJS.ProcessEnv, cwd: string, ...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: e, encoding: "utf8", cwd });
  /** What follows a next step's label on stderr: its command first. */
  const afterStep = (stderr: string, label: string): string => {
    const at = stderr.indexOf(`  ${label}:`);
    assert.notEqual(at, -1, `no step "${label}" in: ${stderr}`);
    return stderr.slice(at + label.length + 3).trimStart();
  };
  /** A throwaway home whose store holds only these sessions. */
  async function storeWith(sessions: Session[]): Promise<NodeJS.ProcessEnv> {
    const home = tmp("csh-attr-home-");
    mkdirSync(join(home, "codex"), { recursive: true });
    const e = { ...env, ["HO" + "ME"]: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), CODING_SH_HOME: join(home, "csh") };
    const ctx = await openContext({ env: e, cwd: other });
    try {
      for (const s of sessions) await ctx.index.upsertSession(s);
    } finally {
      await ctx.close();
    }
    return e;
  }

  before(() => {
    // A repo with one commit a person made today, where no captured session ran.
    other = makeRepo({ "notes.txt": "a line a person wrote" });
  });

  test("sessions ran in other repos: it says none ran here, and the step shows where they ran", () => {
    const r = cliIn(env, other, "attribution");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("No captured session ran in this repo."), r.stdout);
    assert.ok(afterStep(r.stderr, "See which repos your sessions ran in").startsWith(cliCommand(env, ["sessions", "--facets", "repo"])), r.stderr);
    assert.ok(!r.stderr.includes("check capture:"), r.stderr);
    // The step runs, and names the repo the stored sessions ran in.
    const facets = cliIn(env, other, "sessions", "--facets", "repo");
    assert.equal(facets.status, 0, facets.stderr);
    assert.ok(facets.stdout.toLowerCase().includes(basename(fx.root).toLowerCase()), facets.stdout);
  });

  test("with --since, it says none ran here since then, and looks further back with the --repo given", () => {
    const r = cliIn(env, fx.root, "attribution", "--since", "7d", "--repo", other);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No captured session ran in this repo since /);
    assert.ok(afterStep(r.stderr, "Look further back").startsWith(cliCommand(env, ["attribution", "--since", "90d", "--repo", other])), r.stderr);
  });

  test("a store with no session at all: the step is how the first one gets there", async () => {
    const empty = await storeWith([]);
    const r = cliIn(empty, other, "attribution");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("No captured session ran in this repo."), r.stdout);
    const first = noSessionsNext(empty);
    assert.ok(afterStep(r.stderr, first.label).startsWith(first.command), r.stderr);
  });

  test("a session ran here with no lines to match: the step checks capture", async () => {
    const here = makeSession("s-here", "claude-code", "claude-sonnet-4-5", Date.now() - HOUR, (await snapshot(other, { env, ...ROOMY }))!);
    const one = await storeWith([here]);
    const r = cliIn(one, other, "attribution");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("No captured session ran"), r.stdout);
    assert.ok(afterStep(r.stderr, "Sessions in this repo need an end snapshot or edit tool calls; check capture").startsWith(`${nextStepBin(one)} doctor`), r.stderr);
  });

  test("no commit in the window: the step looks further back, with the --rev given", () => {
    const r = cliIn(env, fx.root, "attribution", "--since", "1d", "--rev", "main");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /No commits since .* on [0-9a-f]{8}/);
    assert.ok(afterStep(r.stderr, "Look further back").startsWith(cliCommand(env, ["attribution", "--since", "90d", "--rev", "main"])), r.stderr);
  });
});
