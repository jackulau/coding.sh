// Session.stats.retrieval in the CLI: `show` prints one Retrieval line (on the real Claude Code
// capture under test/fixtures/adapters/claude-code/real, and its wording per case), and
// `stats --json` adds the window's totals, subagent sessions included, with no key when no
// session in the window read or searched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { retrievalRow } from "../../src/cli/commands/show.ts";
import type { RetrievalStats, Session } from "../../src/schema/index.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed, session } from "../query/_seed.ts";
import { CLI } from "../_cli.ts";

const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/real/config", import.meta.url));
const SID = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";

describe("the real Claude Code capture", () => {
  let root = "";
  let env: NodeJS.ProcessEnv;
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "csh-retrieval-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    env = {
      ...process.env,
      ["HO" + "ME"]: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      CLAUDE_CONFIG_DIR: CONFIG,
      CODEX_HOME: join(root, "codex"),
      T3CODE_HOME: join(root, "t3"),
      CODING_SH_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      TZ: "UTC",
    };
    cli("ingest", "--backfill", "--agent", "claude-code");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("show: five reads of three files, one later edited with `sed -i`, two before the first edit", () => {
    assert.match(cli("show", SID), /\n\s+Retrieval\s+5 reads of 3 files \(1 later edited\), first edit after 2 reads\n/);
    const j = JSON.parse(cli("show", SID, "--json")) as { session: { stats: { retrieval?: RetrievalStats } } };
    assert.deepEqual(j.session.stats.retrieval, { reads: 5, filesRead: 3, editedAfterRead: 1, searches: 0, beforeFirstEdit: 2 });
  });

  test("stats --json: the window's totals", () => {
    const j = JSON.parse(cli("stats", "--since", "2026-11-01", "--until", "2026-11-30", "--json")) as { retrieval?: unknown };
    assert.deepEqual(j.retrieval, { sessions: 1, reads: 5, filesRead: 3, editedAfterRead: 1, searches: 0, emptySearches: 0, web: 0, beforeFirstEdit: 2, editedSessions: 1 });
  });
});

describe("show's Retrieval line", () => {
  const line = (retrieval?: RetrievalStats) => retrievalRow(session("x", retrieval ? { stats: { ...session("x").stats, retrieval } } : {}))?.[1];

  test("each part only when it has something to say", () => {
    assert.equal(line(), undefined);
    assert.equal(line({ reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0 }), "1 read of 1 file");
    assert.equal(
      line({ reads: 4, filesRead: 3, editedAfterRead: 1, searches: 6, emptySearches: 2, web: 2, beforeFirstEdit: 5 }),
      "4 reads of 3 files (1 later edited), 6 searches (2 found nothing), 2 web calls, first edit after 5 reads and searches",
    );
    assert.equal(line({ reads: 0, filesRead: 0, editedAfterRead: 0, searches: 1, beforeFirstEdit: 1 }), "1 search, first edit after 1 search");
    assert.equal(line({ reads: 2, filesRead: 2, editedAfterRead: 0, searches: 1, beforeFirstEdit: 1 }), "2 reads of 2 files (0 later edited), 1 search, first edit after 1 read or search");
    // Reads that all failed read no file; a session that edited before it read anything.
    assert.equal(line({ reads: 1, filesRead: 0, editedAfterRead: 0, searches: 0, beforeFirstEdit: 0 }), "1 read, first edit before any read");
  });
});

describe("stats --json: retrieval totals over the window", () => {
  const DAY = 86_400_000;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const at = (daysAgo: number) => today - daysAgo * DAY + 3_600_000;
  const s = (id: string, daysAgo: number, retrieval?: RetrievalStats, over: Partial<Session> = {}): Session => {
    const base = session(id, { startedAt: at(daysAgo), endedAt: at(daysAgo) + 60_000, ...over });
    return retrieval ? { ...base, stats: { ...base.stats, retrieval } } : base;
  };
  let env: TmpEnv;

  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, {
      sessions: [
        s("a", 1, { reads: 4, filesRead: 3, editedAfterRead: 1, searches: 6, emptySearches: 2, beforeFirstEdit: 5 }),
        s("b", 1, { reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0, web: 2 }, { agent: "codex" }),
        s("c", 3, undefined, { agent: "codex" }),
        s("d", 3, { reads: 2, filesRead: 2, editedAfterRead: 0, searches: 1 }, { parent: { sessionId: "c", type: "Explore" } }),
        s("e", 40, { reads: 9, filesRead: 9, editedAfterRead: 9, searches: 9, beforeFirstEdit: 9 }),
      ],
    });
  });
  after(() => env.restore());

  test("sums every session in the window, a subagent's on its own", () => {
    const j = JSON.parse(ok(["stats", "--since", "7d", "--json"]).stdout);
    assert.deepEqual(j.retrieval, { sessions: 3, reads: 7, filesRead: 6, editedAfterRead: 1, searches: 7, emptySearches: 2, web: 2, beforeFirstEdit: 5, editedSessions: 1 });
  });

  test("--where narrows the sessions; no key when none in the window read or searched", () => {
    const j = JSON.parse(ok(["stats", "--since", "7d", "--where", "agent:codex", "--json"]).stdout);
    assert.deepEqual(j.retrieval, { sessions: 1, reads: 1, filesRead: 1, editedAfterRead: 0, searches: 0, emptySearches: 0, web: 2, beforeFirstEdit: 0, editedSessions: 0 });
    const none = JSON.parse(ok(["stats", "--since", "4d", "--until", "2d", "--where", "agent:codex", "--json"]).stdout);
    assert.equal(none.totals.sessions, 1);
    assert.equal("retrieval" in none, false);
  });
});
