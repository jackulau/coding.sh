// A session in a worktree belongs to its main repo: RepoState.main at ingest, the repo key and
// facet in SQLite and the scan fallback, --repo and the MCP tools from inside a worktree, and
// usage --by repo. cwd and repo.root stay where the agent ran.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Adapter, IndexStore } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { mainWorktree } from "../../src/core/git.ts";
import { currentByCwd, matchesPlace, parsePlace, pathKey, scanSessions } from "../../src/mcp/data.ts";
import { parseWhere, repoGroup, worktreeRepo } from "../../src/query/where.ts";
import { facetCounts, findSessions } from "../../src/query/run.ts";
import type { EventKind, Session } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { DAY_MS, groupKeys, loadMetricRows } from "../../src/viewer/metrics.ts";
import { CLI } from "../_cli.ts";
import { T0 } from "../query/_seed.ts";
import { RawClient } from "../mcp/helpers.ts";
import { WORKTREE_FACET, WORKTREE_QUERIES, worktreeSessions } from "../query/_where-fixture.ts";

describe("worktreeRepo: the repo an agent's worktree belongs to, from its path", () => {
  for (const [os, home, join_] of [["posix", "/home/user", posix.join], ["windows", "C:\\Users\\me", win32.join]] as const) {
    const cases: [string, ReturnType<typeof worktreeRepo>][] = [
      [join_(home, ".t3", "worktrees", "coding-sh", "t3-abc"), { name: "coding-sh" }],
      [join_(home, ".t3", "worktrees", "coding-sh", "t3-abc", "packages", "sdk"), { name: "coding-sh" }],
      [join_(home, ".t3", "worktrees", "coding-sh"), undefined],
      [join_(home, ".codex", "worktrees", "a1b2", "coding-sh"), { name: "coding-sh" }],
      [join_(home, ".codex", "worktrees", "a1b2", "coding-sh", "src"), { name: "coding-sh" }],
      [join_(home, ".codex", "worktrees", "a1b2"), undefined],
      [join_(home, "src", "coding-sh", ".claude", "worktrees", "fix-x"), { name: "coding-sh", path: join_(home, "src", "coding-sh") }],
      [join_(home, "src", "coding-sh", ".claude", "worktrees", "fix-x", "docs"), { name: "coding-sh", path: join_(home, "src", "coding-sh") }],
      [join_(home, "src", "coding-sh", ".claude", "worktrees"), undefined],
      [join_(home, "src", "coding-sh"), undefined],
      [join_(home, ".claude", "projects", "x"), undefined],
    ];
    for (const [path, want] of cases) {
      it(`${os}: ${path}`, () => assert.deepEqual(worktreeRepo(path), want));
    }
  }
  it("no path, no repo", () => assert.equal(worktreeRepo(undefined), undefined));

  it("repoGroup prefers RepoState.main, then the path, then the root or cwd", () => {
    assert.deepEqual(repoGroup({ repo: { root: "/w/demo-feature", main: "/w/demo" }, cwd: "/w/demo-feature" }), { name: "demo", path: "/w/demo" });
    assert.deepEqual(repoGroup({ cwd: "/home/user/.t3/worktrees/demo/t3-abc" }), { name: "demo" });
    assert.deepEqual(repoGroup({ repo: { root: "/w/demo" }, cwd: "/w/demo/sub" }), { name: "demo", path: "/w/demo" });
    assert.deepEqual(repoGroup({ cwd: "/w/notes" }), { name: "notes", path: "/w/notes" });
    assert.deepEqual(repoGroup({}), {});
  });
});

describe("mainWorktree: one git dir spelled two ways is a main checkout, not a worktree", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "csh-mainwt-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("compares real paths, as git's long names and a cwd's 8.3 short names (RUNNER~1 on CI) need", () => {
    const repo = join(dir, "demo");
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    const link = join(dir, "demo-link");
    symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(mainWorktree(join(repo, ".git"), join(link, ".git")), undefined, "the main checkout's .git through a link");
    assert.equal(mainWorktree(join(link, ".git", "worktrees", "wt"), join(repo, ".git")), repo, "a linked worktree still names its main checkout");
    assert.equal(mainWorktree(join(dir, "gone", ".git"), join(dir, "gone2", ".git")), join(dir, "gone2"), "paths that do not exist compare as written");
  });
});

describe("the repo key groups worktrees under their repo, in SQLite and the scan alike", () => {
  const p = (q: string) => parseWhere(q, { now: Date.now() });
  for (const [name, open] of [["sqlite", () => SqliteIndexStore.open(":memory:")], ["scan", async () => new MemoryIndexStore()]] as const) {
    it(name, async () => {
      const index: IndexStore = await open();
      for (const s of worktreeSessions()) await index.upsertSession(s);
      for (const [q, want] of WORKTREE_QUERIES) {
        const got = (await findSessions(index, p(q), {})).sessions.map((s) => s.id).sort();
        assert.deepEqual(got, want, q);
      }
      const facet = (await facetCounts(index, p(""), ["repo"])).repo!.map((f): [string, number] => [f.value, f.count]).sort();
      assert.deepEqual(facet, WORKTREE_FACET);
      // The viewer's repo group counts them the same way.
      const { rows } = await loadMetricRows(index, { since: T0 - DAY_MS, until: T0 + DAY_MS });
      const byRepo = new Map<string, number>();
      for (const r of rows) for (const k of groupKeys(r, "repo")) byRepo.set(k, (byRepo.get(k) ?? 0) + 1);
      assert.deepEqual([...byRepo].sort(), WORKTREE_FACET);
      // cwd and repo.root stay where the agent ran.
      const linked = (await index.getSession("wt-linked"))!;
      assert.deepEqual([linked.cwd, linked.repo?.root], ["/work/demo-feature/src", "/work/demo-feature"]);
      await index.close?.();
    });
  }
});

// ------------------------------------------------------------ real git worktrees

const stub = {
  displayName: "Fake",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
};
/** Hook-style adapter: raw = { session, kind, text? } → one event at the line's ts and cwd. */
const hookAdapter: Adapter = {
  ...stub,
  id: "fake",
  tier: "A",
  async normalize(line, ctx) {
    const { session, kind, ...payload } = line.raw as Record<string, unknown>;
    return [{ id: ctx.id(line.agent, String(session), line.ts, String(kind)), v: 0, sessionId: String(session), ts: line.ts, agent: line.agent, kind: kind as EventKind, cwd: line.cwd, payload }];
  },
};
const spoolLine = (ts: number, cwd: string, raw: Record<string, unknown>) => JSON.stringify({ v: 0, agent: "fake", event: String(raw.kind), ts, pid: 1, cwd, raw }) + "\n";

describe("a git worktree's sessions belong to its main repo", () => {
  let base = "";
  let home = "";
  let data = "";
  let main = "";
  let wt = "";
  let t3 = "";
  let env: Record<string, string> = {};
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const cli = (cwd: string, args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  const same = (a: string | undefined, b: string) => assert.equal(pathKey(realpathSync.native(a ?? "")), pathKey(realpathSync.native(b)));

  before(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "csh-repo-identity-")));
    home = join(base, "home");
    data = join(home, ".coding.sh");
    main = join(base, "demo");
    wt = join(base, "demo-feature");
    t3 = join(home, ".t3", "worktrees", "demo", "t3-abc");
    mkdirSync(main, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(base, "gitconfig-none"), "");
    process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig-none");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      CODING_SH_HOME: data,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      NO_COLOR: "1",
      TZ: "UTC",
      CODING_SH_NO_UPDATE_CHECK: "1",
      CODING_SH_NO_AUTO_INGEST: "1",
      GIT_CONFIG_GLOBAL: join(base, "gitconfig-none"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    writeFileSync(join(main, "README.md"), "demo\n");
    git(main, "init", "-q");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);

    // One hook-captured session in each checkout, ingested into the store the CLI reads.
    const spoolDir = join(base, "spool");
    mkdirSync(join(spoolDir, "fake"), { recursive: true });
    const t0 = Date.now() - 60_000;
    writeFileSync(
      join(spoolDir, "fake", "s.jsonl"),
      spoolLine(t0, main, { session: "in-main", kind: "session.start" }) +
        spoolLine(t0 + 10, main, { session: "in-main", kind: "user.message", text: "fix it" }) +
        spoolLine(t0 + 20, wt, { session: "in-worktree", kind: "session.start" }) +
        spoolLine(t0 + 30, wt, { session: "in-worktree", kind: "user.message", text: "fix it there" }),
    );
    const index = await SqliteIndexStore.open(join(data, "index.db"));
    try {
      const ingestEnv = { ...process.env, HOME: join(spoolDir, "user"), CODING_SH_NO_AUTO_INGEST: "1" };
      const r = await ingest({ config: defaultConfig(ingestEnv), index, blobs: new MemoryBlobStore(), adapters: new Map([["fake", hookAdapter]]), env: ingestEnv, spoolDir, lock: false, now: () => t0 + 1000 });
      assert.deepEqual(r.errors, []);
      // A session from a T3 Code worktree that has since been removed: git can't say whose it was.
      const at = t0 + 40;
      const removed: Session = { id: "in-removed-t3", agent: "t3code", startedAt: at, endedAt: at + 1000, cwd: t3, title: "old task", stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] };
      await index.upsertSession(removed);
    } finally {
      await index.close();
    }
  });
  after(() => {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(base, { recursive: true, force: true });
  });

  const withIndex = async <T>(f: (index: IndexStore) => Promise<T>): Promise<T> => {
    const index = await SqliteIndexStore.open(join(data, "index.db"));
    try {
      return await f(index);
    } finally {
      await index.close();
    }
  };

  it("records the main worktree's root on a worktree's session, and nothing on the main checkout's", async () => {
    await withIndex(async (index) => {
      const m = (await index.getSession("in-main"))!;
      const w = (await index.getSession("in-worktree"))!;
      same(m.repo?.root, main);
      assert.equal(m.repo?.main, undefined);
      same(w.repo?.root, wt);
      same(w.repo?.main, main);
      same(w.cwd, wt);
    });
  });

  it("repo:<name> matches both checkouts and the removed worktree, in SQLite and the scan", async () => {
    const sessions = await withIndex(async (index) => (await index.listSessions({ limit: 10 })));
    const memory = new MemoryIndexStore();
    for (const s of sessions) await memory.upsertSession(s);
    await withIndex(async (sqlite) => {
      for (const index of [sqlite, memory] as IndexStore[]) {
        const ids = async (q: string) => (await findSessions(index, parseWhere(q, { now: Date.now() }), {})).sessions.map((s) => s.id).sort();
        assert.deepEqual(await ids("repo:demo"), ["in-main", "in-removed-t3", "in-worktree"], index.kind);
        assert.deepEqual(await ids(`repo:"${main}"`), ["in-main", "in-worktree"], index.kind);
        assert.deepEqual(await ids("repo:demo-feature"), ["in-worktree"], index.kind);
        const facet = (await facetCounts(index, parseWhere("", { now: Date.now() }), ["repo"])).repo!.map((f) => [f.value, f.count]);
        assert.deepEqual(facet, [["demo", 3]], index.kind);
      }
    });
  });

  it("sessions --repo, from the main checkout or the worktree, lists both", () => {
    for (const [cwd, repo] of [[base, main], [base, wt], [wt, "."], [main, "."]] as const) {
      const j = cli(cwd, ["sessions", "--repo", repo, "--json"]) as { sessions: { id: string }[] };
      assert.deepEqual(j.sessions.map((s) => s.id).sort(), ["in-main", "in-worktree"], `--repo ${repo} from ${cwd}`);
    }
    // A folder that is no checkout's root keeps the exact match.
    const j = cli(base, ["sessions", "--repo", join(main, "sub"), "--json"]) as { sessions: unknown[] };
    assert.equal(j.sessions.length, 0);
  });

  it("usage --by repo counts the worktree and the removed worktree under the main repo", () => {
    const j = cli(base, ["usage", "--by", "repo", "--since", "1d", "--json"]) as { groups: { key: string; sessions: number }[] };
    assert.equal(j.groups.length, 1, JSON.stringify(j.groups));
    same(j.groups[0]!.key, main);
    assert.equal(j.groups[0]!.sessions, 3);
  });

  it("improve from the worktree reads the whole repo and names it", () => {
    const j = cli(wt, ["improve", "--json", "--headless"]) as { scope: { repo: string; sessions: number } };
    assert.equal(j.scope.sessions, 3);
    same(j.scope.repo, main);
  });

  it("a place in the worktree is its repo; session_current keeps the exact folder", async () => {
    const place = parsePlace(".", wt, home);
    same(place.path, wt);
    same(place.repo, main);
    assert.equal(parsePlace(".", join(main), home).repo !== undefined, true, "a main checkout's root stands for the repo");
    await withIndex(async (index) => {
      const found: string[] = [];
      const it = scanSessions(index, { place, topLevel: false }, 100);
      for (let n = await it.next(); !n.done; n = await it.next()) found.push(n.value.id);
      assert.deepEqual(found.sort(), ["in-main", "in-removed-t3", "in-worktree"]);
      const other = (await index.getSession("in-main"))!;
      assert.equal(matchesPlace(other, parsePlace(join(base, "elsewhere"), base, home)), false);
      const cur = await currentByCwd(index, wt);
      assert.equal(cur?.session.id, "in-worktree");
    });
  });

  it("the MCP tools see the whole repo from the worktree", async () => {
    const c = new RawClient(env, wt);
    try {
      await c.initialize();
      const list = await c.call("sessions_list", { repo: "." });
      assert.notEqual(list.isError, true, list.content[0]?.text);
      const rows = (list.structuredContent as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort();
      assert.deepEqual(rows, ["in-main", "in-removed-t3", "in-worktree"]);
      const imp = await c.call("improve", { headless: true });
      assert.notEqual(imp.isError, true, imp.content[0]?.text);
      const scope = (imp.structuredContent as { scope: { repo: string; sessions: number } }).scope;
      assert.equal(scope.sessions, 3);
      same(scope.repo, main);
      const cand = await c.call("eval_candidates", { includeRejected: true });
      assert.notEqual(cand.isError, true, cand.content[0]?.text);
      assert.equal((cand.structuredContent as { considered: number }).considered, 2, "both checkouts' sessions (the removed worktree is known by name only)");
      const cur = await c.call("session_current", {});
      assert.notEqual(cur.isError, true, cur.content[0]?.text);
      assert.equal((cur.structuredContent as { session: { id: string } }).session.id, "in-worktree");
    } finally {
      await c.close();
    }
  });
});
