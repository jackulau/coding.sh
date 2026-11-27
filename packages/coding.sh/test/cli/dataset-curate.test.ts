// End-to-end CLI tests for `coding.sh dataset mine|stats|filter`.
// Uses throwaway temp HOME / USERPROFILE / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Dataset } from "../../src/datasets/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { CLI as MAIN } from "../_cli.ts";

let root = "";
let env: Record<string, string> = {};

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runJson<T = Record<string, unknown>>(args: string[]): T {
  const r = runCli([...args, "--json"]);
  assert.equal(r.status, 0, `coding.sh ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout) as T;
}

async function readDataset(id: string, version = "latest"): Promise<Dataset | undefined> {
  const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
  try {
    return await new FileEvalStore({ env, index }).getDataset(id, version);
  } finally {
    await index.close();
  }
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-ds-curate-")));
  const home = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(home);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, "tmp"),
    PATH: dirname(process.execPath),
    NO_COLOR: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
  };
  mkdirSync(env.CODING_SH_HOME!, { recursive: true });

  const now = Date.now();
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
  try {
    const fixtures: { session: Session; prompt: string; reply: string; quality?: number; helpful?: boolean }[] = [
      {
        session: {
          id: "sess-1000-note-flags",
          agent: "claude-code",
          cwd: repoA,
          repo: { root: repoA, head: "aaa111" },
          startedAt: now - 60_000,
          stats: { events: 8, turns: 4, toolCalls: 7, toolErrors: 0, filesChanged: 2 },
          flags: ["compaction", "step-retried", "resumed", "gateway:vercel"],
        },
        prompt: "Refactor the retry queue worker so expired jobs move to dead-letter storage",
        reply: "Updated retry queue worker with dead-letter handling.",
        quality: 0.92,
        helpful: true,
      },
      {
        session: {
          id: "sess-2000-near-dup",
          agent: "claude-code",
          cwd: repoA,
          repo: { root: repoA, head: "aaa111" },
          startedAt: now - 120_000,
          stats: { events: 8, turns: 4, toolCalls: 6, toolErrors: 0, filesChanged: 2 },
          flags: [],
        },
        prompt: "Refactor the retry queue worker so expired jobs move to dead-letter storages",
        reply: "Done with dead-letter storage.",
        quality: 0.95,
        helpful: true,
      },
      {
        session: {
          id: "sess-3000-hard",
          agent: "claude-code",
          cwd: repoA,
          repo: { root: repoA, head: "aaa111" },
          startedAt: now - 180_000,
          stats: { events: 30, turns: 7, toolCalls: 18, toolErrors: 0, filesChanged: 6 },
          flags: ["skill:sql"],
        },
        prompt: "Implement streaming JSONL ingestion with checkpoint cursors and atomic WAL flush",
        reply: "Implemented streaming JSONL ingestion.",
        quality: 0.88,
        helpful: true,
      },
      {
        session: {
          id: "sess-4000-flagged",
          agent: "claude-code",
          cwd: repoA,
          repo: { root: repoA, head: "aaa111" },
          startedAt: now - 240_000,
          stats: { events: 10, turns: 3, toolCalls: 8, toolErrors: 3, filesChanged: 1 },
          flags: ["no-verification", "compaction"],
        },
        prompt: "Fix the race condition in the background lock release path",
        reply: "Claimed done without running tests.",
        quality: 0.9,
        helpful: true,
      },
      {
        session: {
          id: "sess-5000-low-score",
          agent: "claude-code",
          cwd: repoA,
          repo: { root: repoA, head: "aaa111" },
          startedAt: now - 300_000,
          stats: { events: 6, turns: 3, toolCalls: 3, toolErrors: 0, filesChanged: 1 },
          flags: [],
        },
        prompt: "Draft release notes for the upcoming CLI patch version",
        reply: "Drafted notes.",
        quality: 0.35,
        helpful: false,
      },
      {
        session: {
          id: "sess-6000-short-codex",
          agent: "codex",
          cwd: repoB,
          repo: { root: repoB, head: "bbb222" },
          startedAt: now - 360_000,
          stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
          flags: [],
        },
        prompt: "Ping",
        reply: "Pong",
        quality: 0.99,
        helpful: true,
      },
    ];

    for (const f of fixtures) {
      await index.upsertSession(f.session);
      const evs: AgentEvent[] = [
        { id: `${f.session.id}-u`, v: 0, sessionId: f.session.id, ts: f.session.startedAt + 1, agent: f.session.agent, kind: "user.message", payload: { text: f.prompt } },
        { id: `${f.session.id}-a`, v: 0, sessionId: f.session.id, ts: f.session.startedAt + 2, agent: f.session.agent, kind: "assistant.message", payload: { text: f.reply } },
      ];
      await index.putEvents(evs);
      if (f.quality !== undefined) {
        await index.putScore!({
          id: `sc-q-${f.session.id}`,
          target: "session",
          targetId: f.session.id,
          sessionId: f.session.id,
          name: "quality",
          dataType: "numeric",
          value: f.quality,
          source: "judge",
          by: "tester",
          ts: f.session.startedAt + 10,
        });
      }
      if (f.helpful !== undefined) {
        await index.putScore!({
          id: `sc-h-${f.session.id}`,
          target: "session",
          targetId: f.session.id,
          sessionId: f.session.id,
          name: "helpful",
          dataType: "boolean",
          value: f.helpful,
          source: "human",
          by: "tester",
          ts: f.session.startedAt + 11,
        });
      }
    }
  } finally {
    await index.close();
  }
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("coding.sh dataset mine", () => {
  it("supports --dry-run without writing and reports matched/kept/dropped breakdown", async () => {
    const doc = runJson<{
      outcome: string;
      matched: number;
      kept: number;
      dropped: number;
      droppedBy: Record<string, number>;
    }>([
      "dataset",
      "mine",
      "dry-only",
      "--where",
      "agent:claude-code",
      "--min-turns",
      "2",
      "--min-score",
      "quality>=0.8",
      "--min-score",
      "helpful=1",
      "--exclude-flagged",
      "--dedupe-near",
      "0.8",
      "--dry-run",
    ]);

    assert.equal(doc.outcome, "dry-run");
    assert.equal(doc.matched, 5);
    assert.equal(doc.kept, 2);
    assert.equal(doc.dropped, 3);
    assert.deepEqual(doc.droppedBy, {
      "near-duplicate": 1,
      flagged: 1,
      "min-score": 1,
    });
    assert.equal(await readDataset("dry-only"), undefined);
  });

  it("mines sessions into a versioned dataset with deterministic difficulty metadata and keeps note flags", async () => {
    const doc = runJson<{
      outcome: string;
      dataset: { id: string; version: string; cases: number };
      kept: number;
      dropped: number;
    }>([
      "dataset",
      "mine",
      "curated",
      "--where",
      "agent:claude-code",
      "--min-turns",
      "2",
      "--min-score",
      "quality=0.8",
      "--exclude-flagged",
      "--dedupe-near",
      "0.8",
      "--tag",
      "magpie",
    ]);

    assert.equal(doc.outcome, "created");
    assert.equal(doc.kept, 2);
    assert.equal(doc.dataset.cases, 2);

    const ds = await readDataset("curated");
    assert.ok(ds);
    const bySession = new Map(ds.cases.map((c) => [c.sourceSessionId, c]));
    assert.ok(bySession.has("sess-1000-note-flags"), "compaction/step-retried/resumed/colon tags are not failure flags");
    assert.ok(bySession.has("sess-3000-hard"));
    assert.equal(bySession.has("sess-4000-flagged"), false);
    assert.equal(bySession.has("sess-2000-near-dup"), false);

    const med = bySession.get("sess-1000-note-flags")!;
    assert.equal(med.metadata?.difficulty, "medium");
    assert.equal(med.metadata?.turns, 4);
    assert.equal(med.metadata?.toolCalls, 7);
    assert.equal(med.metadata?.filesChanged, 2);
    assert.ok(med.tags?.includes("magpie"));
    assert.ok(med.tags?.includes("difficulty:medium"));
    assert.ok(med.split, "mined case gets a split");

    const hard = bySession.get("sess-3000-hard")!;
    assert.equal(hard.metadata?.difficulty, "hard");
    assert.equal(hard.metadata?.filesChanged, 6);

    // Incremental mine with --dedupe-near skips sessions already covered by existing dataset cases.
    const repeat = runJson<{ outcome: string; kept: number; droppedBy: Record<string, number> }>([
      "dataset",
      "mine",
      "curated",
      "--where",
      "agent:claude-code",
      "--min-turns",
      "2",
      "--min-score",
      "quality=0.8",
      "--exclude-flagged",
      "--dedupe-near",
      "0.8",
    ]);
    assert.equal(repeat.outcome, "unchanged");
    assert.equal(repeat.kept, 0);
    assert.equal(repeat.droppedBy["exact-duplicate"], 2);
    assert.equal(repeat.droppedBy["near-duplicate"], 1);
  });

  it("supports --agent, --repo, --since, --limit, and --split flags", async () => {
    const doc = runJson<{ outcome: string; matched: number; kept: number; dataset: { id: string; cases: number } }>([
      "dataset",
      "mine",
      "scoped",
      "--agent",
      "codex",
      "--repo",
      join(root, "repo-b"),
      "--since",
      "1h",
      "--split",
      "test",
      "--limit",
      "1",
    ]);
    assert.equal(doc.outcome, "created");
    assert.equal(doc.matched, 1);
    assert.equal(doc.kept, 1);
    const ds = await readDataset("scoped");
    assert.equal(ds?.cases.length, 1);
    assert.equal(ds?.cases[0]?.sourceSessionId, "sess-6000-short-codex");
    assert.equal(ds?.cases[0]?.split, "test");
    assert.equal(ds?.cases[0]?.metadata?.difficulty, "easy");
  });

  it("rejects invalid --dedupe-near and --min-score values with exit 2", () => {
    const badThresh = runCli(["dataset", "mine", "bad", "--dedupe-near", "1.5"]);
    assert.equal(badThresh.status, 2);
    assert.match(badThresh.stderr, /--dedupe-near/);

    const badScore = runCli(["dataset", "mine", "bad", "--min-score", "quality>0.8"]);
    assert.equal(badScore.status, 2);
    assert.match(badScore.stderr, /--min-score/);
  });
});

describe("coding.sh dataset stats", () => {
  it("reports composition, splits, tags, difficulty, input chars, and near-duplicate pairs", () => {
    // Mine all sessions without near-dedup so stats sees the near-duplicate pair and all difficulties.
    runJson(["dataset", "mine", "raw-all"]);

    const stats = runJson<{
      id: string;
      version: string;
      total: number;
      splits: { train: number; dev: number; test: number };
      tags: Record<string, number>;
      difficulty: { easy?: number; medium?: number; hard?: number };
      inputChars: { min: number; median: number; max: number };
      nearDuplicates: { threshold: number; pairs: number };
    }>(["dataset", "stats", "raw-all"]);

    assert.equal(stats.id, "raw-all");
    assert.equal(stats.total, 6);
    assert.equal(stats.splits.train + stats.splits.dev + stats.splits.test, 6);
    assert.equal(stats.difficulty.easy, 1);
    assert.equal(stats.difficulty.medium, 4);
    assert.equal(stats.difficulty.hard, 1);
    assert.equal(stats.inputChars.min, 4);
    assert.ok(stats.inputChars.max >= stats.inputChars.median);
    assert.equal(stats.nearDuplicates.threshold, 0.8);
    assert.equal(stats.nearDuplicates.pairs, 1);

    const text = runCli(["dataset", "stats", "raw-all"]);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /Near-dupes/);
    assert.match(text.stdout, /1 pair/);
  });

  it("rejects invalid --near-threshold with exit 2 and missing dataset with exit 1", () => {
    assert.equal(runCli(["dataset", "stats", "raw-all", "--near-threshold", "0"]).status, 2);
    assert.equal(runCli(["dataset", "stats", "does-not-exist"]).status, 1);
  });
});

describe("coding.sh dataset filter", () => {
  it("supports --dry-run and materializes a filtered immutable child dataset", async () => {
    const dry = runJson<{
      outcome: string;
      total: number;
      kept: number;
      dropped: number;
      droppedBy: Record<string, number>;
    }>([
      "dataset",
      "filter",
      "raw-all",
      "--out",
      "child-dry",
      "--difficulty",
      "medium,hard",
      "--min-chars",
      "10",
      "--dedupe-near",
      "0.8",
      "--dry-run",
    ]);
    assert.equal(dry.outcome, "dry-run");
    assert.equal(dry.total, 6);
    assert.equal(dry.kept, 4);
    assert.equal(dry.dropped, 2);
    assert.equal(dry.droppedBy.difficulty, 1);
    assert.equal(dry.droppedBy["near-duplicate"], 1);
    assert.equal(await readDataset("child-dry"), undefined);

    const created = runJson<{
      outcome: string;
      dataset: { id: string; version: string; cases: number };
      kept: number;
    }>([
      "dataset",
      "filter",
      "raw-all",
      "--out",
      "clean-child",
      "--difficulty",
      "hard",
      "--tag",
      "agent:claude-code",
      "--min-chars",
      "20",
      "--max-chars",
      "200",
      "--limit",
      "5",
    ]);
    assert.equal(created.outcome, "created");
    assert.equal(created.kept, 1);
    assert.equal(created.dataset.cases, 1);

    const child = await readDataset("clean-child");
    assert.ok(child);
    assert.equal(child.cases.length, 1);
    assert.equal(child.cases[0]?.sourceSessionId, "sess-3000-hard");

    // Source dataset stays untouched.
    const src = await readDataset("raw-all");
    assert.equal(src?.cases.length, 6);

    // Filtering by --split keeps only cases in that split and supports --version.
    const v1 = src!.version;
    runJson(["dataset", "add", "raw-all", "--split", "test", "--case", '{"input":"extra case added in v2"}']);
    const statsV1 = runJson<{ total: number; version: string }>(["dataset", "stats", "raw-all", "--version", v1]);
    assert.equal(statsV1.version, v1);
    assert.equal(statsV1.total, 6);

    const bySplit = runJson<{ outcome: string; kept: number }>(["dataset", "filter", "raw-all", "--out", "only-test", "--split", "test"]);
    assert.equal(bySplit.outcome, "created");
    const onlyTest = await readDataset("only-test");
    assert.ok(onlyTest && onlyTest.cases.length === bySplit.kept);
    assert.ok(onlyTest.cases.every((c) => c.split === "test"));
  });

  it("rejects missing --out and inverted char bounds with exit 2", () => {
    assert.equal(runCli(["dataset", "filter", "raw-all"]).status, 2);
    assert.equal(runCli(["dataset", "filter", "raw-all", "--out", "x", "--min-chars", "100", "--max-chars", "10"]).status, 2);
  });
});
