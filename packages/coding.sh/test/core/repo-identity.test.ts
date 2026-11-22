// A session in a worktree belongs to its main repo: RepoState.main at ingest, the repo key and
// facet in SQLite and the scan fallback, --repo and the MCP tools from inside a worktree, and
// usage --by repo. cwd and repo.root stay where the agent ran.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Adapter, IndexStore } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { isBare, mainWorktree, repoPath, worktreeRoots } from "../../src/core/git.ts";
import { checkoutRepo, currentByCwd, matchesPlace, parsePlace, pathKey, scanSessions, usage } from "../../src/mcp/data.ts";
import { parseWhere, repoGroup, windowsSpelling, worktreeRepo } from "../../src/query/where.ts";
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
    // A folder that is no checkout's root matches sessions at or under it only.
    const j = cli(base, ["sessions", "--repo", join(main, "sub"), "--json"]) as { sessions: unknown[] };
    assert.equal(j.sessions.length, 0);
  });

  it("sessions --repo and export --repo take a repo name: the main checkout and every worktree", () => {
    const j = cli(base, ["sessions", "--repo", "demo", "--json"]) as { sessions: { id: string }[] };
    assert.deepEqual(j.sessions.map((s) => s.id).sort(), ["in-main", "in-removed-t3", "in-worktree"]);
    const w = cli(base, ["sessions", "--repo", "demo-feature", "--json"]) as { sessions: { id: string }[] };
    assert.deepEqual(w.sessions.map((s) => s.id), ["in-worktree"]);
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "export", "sessions", "--repo", "demo"], { cwd: base, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const ids = r.stdout.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id).sort();
    assert.deepEqual(ids, ["in-main", "in-removed-t3", "in-worktree"]);
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

// ------------------------------------------------------------ one spelling per repo

describe("windowsSpelling: the spelling a typed repo: value gets without the disk", () => {
  it("an upper-case drive letter and backslashes; anything else as is", () => {
    assert.equal(windowsSpelling("c:/w/demo"), "C:\\w\\demo");
    assert.equal(windowsSpelling("d:\\w\\demo"), "D:\\w\\demo");
    assert.equal(windowsSpelling("c:"), "C:");
    assert.equal(windowsSpelling("/w/demo"), "/w/demo");
    assert.equal(windowsSpelling("coding-sh"), "coding-sh");
  });
  it("repo: compares a typed Windows path in the stored spelling", async () => {
    const index = new MemoryIndexStore();
    const s: Session = { id: "w1", agent: "fake", startedAt: T0, cwd: "C:\\w\\demo", repo: { root: "C:\\w\\demo", head: "" }, stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] };
    await index.upsertSession(s);
    for (const q of ['repo:"c:/w/demo"', "repo:c:/w/*", 'repo:"C:\\w\\demo"']) {
      const got = (await findSessions(index, parseWhere(q, { now: T0 }), {})).sessions.map((x) => x.id);
      assert.deepEqual(got, ["w1"], q);
    }
  });
});

/** A git that reads no user or system config. */
function isolatedGit(base: string) {
  const cfg = join(base, "gitconfig-none");
  writeFileSync(cfg, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" };
  return (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
}

/** The 8.3 short spelling of an existing path, or undefined when the volume makes none. */
function shortName(p: string): string | undefined {
  const r = spawnSync("cmd.exe", [`/d /s /c "for %I in ("${p}") do @echo %~sI"`], { encoding: "utf8", windowsVerbatimArguments: true });
  const s = r.status === 0 ? r.stdout.trim() : "";
  return s && s.toLowerCase() !== p.toLowerCase() ? s : undefined;
}

describe("one repo, one spelling: a lower-case drive, an 8.3 short name and a junction name the long path's repo", { skip: process.platform !== "win32" && "drive letters, 8.3 short names and junctions are Windows spellings" }, () => {
  let base = "";
  let main = "";
  let wt = "";
  before(() => {
    // Under the temp dir: its volume makes 8.3 short names where any does (RUNNER~1 on CI).
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "csh-repo-spelling-")));
    const git = isolatedGit(base);
    main = join(base, "demo-checkout");
    wt = join(base, "demo-checkout-feature");
    mkdirSync(main);
    writeFileSync(join(main, "README.md"), "demo\n");
    git(main, "init", "-q");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    symlinkSync(base, join(base, "..", `${basename(base)}-link`), "junction");
  });
  after(() => {
    rmSync(join(base, "..", `${basename(base)}-link`), { recursive: false, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  const spellings = (p: string): [string, string | undefined][] => [
    ["lower-case drive", p[0]!.toLowerCase() + p.slice(1)],
    ["forward slashes", p.replace(/\\/g, "/")],
    ["junction", join(`${base}-link`, p.slice(base.length + 1))],
    ["8.3 short name", shortName(p)],
  ];

  it("usage by repo counts c:\\w and C:\\w as one repo (sessions stored before the one spelling)", async () => {
    const index = new MemoryIndexStore();
    for (const [id, root] of [["lower", "c:\\w\\demo"], ["upper", "C:\\w\\demo"]] as const) {
      await index.upsertSession({ id, agent: "fake", startedAt: T0, cwd: root, repo: { root, head: "" }, stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] });
    }
    const r = (await usage(index, { topLevel: false }, "repo", 10)) as { groups: { key: string; sessions: number }[] };
    assert.deepEqual(r.groups.map((g) => [g.key, g.sessions]), [["C:\\w\\demo", 2]]);
  });

  for (const which of ["main checkout", "linked worktree"] as const) {
    it(`${which}: worktreeRoots and checkoutRepo answer the long spelling`, async (t) => {
      const long = which === "main checkout" ? main : wt;
      const want = await worktreeRoots(long);
      assert.equal(want?.root, repoPath(long));
      assert.equal(want?.main, which === "main checkout" ? undefined : repoPath(main));
      assert.equal(checkoutRepo(long), repoPath(main));
      for (const [name, p] of spellings(long)) {
        if (p === undefined) {
          t.diagnostic(`${name}: this volume makes no 8.3 short names`);
          continue;
        }
        assert.deepEqual(await worktreeRoots(p), want, `${name}: ${p}`);
        assert.equal(checkoutRepo(p), repoPath(main), `${name}: ${p}`);
        assert.equal(parsePlace(p, base, base).repo, repoPath(main), `${name}: ${p}`);
      }
    });
  }
});

describe("a bare repo kept at proj/.git has no main checkout", () => {
  let base = "";
  let proj = "";
  let seed = "";
  before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "csh-repo-bare-")));
    const git = isolatedGit(base);
    seed = join(base, "seed");
    proj = join(base, "proj");
    mkdirSync(seed);
    writeFileSync(join(seed, "README.md"), "seed\n");
    git(seed, "init", "-q");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "init");
    git(base, "clone", "-q", "--bare", seed, join(proj, ".git"));
    git(join(proj, ".git"), "worktree", "add", "-q", join(proj, "m"));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it("isBare reads core.bare from the config file", () => {
    assert.equal(isBare(join(proj, ".git")), true);
    assert.equal(isBare(join(seed, ".git")), false);
    assert.equal(isBare(join(base, "nowhere")), false);
  });

  it("a worktree of it has a root and no main; proj is no checkout", async () => {
    const m = join(proj, "m");
    assert.deepEqual(await worktreeRoots(m), { root: repoPath(m) });
    assert.equal(checkoutRepo(m), undefined);
    assert.equal(checkoutRepo(proj), undefined);
    assert.equal(parsePlace(m, base, base).repo, undefined);
    // A plain checkout still stands for its repo.
    assert.equal(checkoutRepo(seed), repoPath(seed));
  });
});

// ------------------------------------------------------------ the child sessions a list leaves out

describe("sessions says how many child sessions it does not show", () => {
  let base = "";
  let env: Record<string, string> = {};
  const session = (id: string, cwd: string, parent?: string): Session => ({
    id,
    agent: "fake",
    startedAt: Date.now() - 60_000,
    cwd,
    title: id,
    stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
    flags: [],
    parent: parent ? { sessionId: parent } : undefined,
  });
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "sessions", ...args], { cwd: base, env, encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r;
  };
  const json = (args: string[]) => JSON.parse(run([...args, "--json"]).stdout) as { sessions: { id: string }[]; hiddenChildren?: number };
  const lastLine = (args: string[]) => run(args).stderr.trim().split("\n").at(-1)!.trim();
  const seed = async (sessions: Session[]) => {
    const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
    try {
      for (const s of sessions) await index.upsertSession(s);
    } finally {
      await index.close();
    }
  };

  before(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "csh-hidden-children-")));
    const home = join(base, "home");
    env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      NO_COLOR: "1",
      TZ: "UTC",
      CODING_SH_NO_UPDATE_CHECK: "1",
      CODING_SH_NO_AUTO_INGEST: "1",
    };
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    await seed([session("top-alpha", join(base, "alpha")), session("top-beta", join(base, "beta"))]);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it("nothing hidden: no hiddenChildren and no line", () => {
    const j = json([]);
    assert.deepEqual(j.sessions.map((s) => s.id).sort(), ["top-alpha", "top-beta"]);
    assert.equal("hiddenChildren" in j, false);
    assert.doesNotMatch(run([]).stderr, /child session/);
  });

  it("child sessions hidden: counted in hiddenChildren and named on the last line, for the same filters", async () => {
    await seed([session("kid-alpha-1", join(base, "alpha"), "top-alpha"), session("kid-alpha-2", join(base, "alpha"), "top-alpha")]);
    assert.equal(json([]).hiddenChildren, 2);
    assert.equal(lastLine([]), "2 child sessions not shown (--subagents)");
    assert.equal(json(["--repo", "alpha"]).hiddenChildren, 2);
    assert.equal(lastLine(["--repo", "alpha"]), "2 child sessions not shown (--subagents)");
    // Filters the children do not match: nothing is hidden from this list.
    for (const args of [["--repo", "beta"], ["--repo", join(base, "beta")], ["--agent", "codex"]]) {
      const j = json(args);
      assert.equal("hiddenChildren" in j, false, args.join(" "));
    }
    // --subagents shows them, and --where is:child picks them itself.
    const all = json(["--subagents"]);
    assert.equal("hiddenChildren" in all, false);
    assert.equal(all.sessions.length, 4);
    assert.equal("hiddenChildren" in json(["--where", "is:child"]), false);
    // No match at all still says what was left out.
    assert.equal(lastLine(["--where", "title:kid"]), "2 child sessions not shown (--subagents)");
  });
});
