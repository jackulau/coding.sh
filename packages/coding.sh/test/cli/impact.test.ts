// End-to-end CLI tests for `coding.sh impact` in throwaway HOME and repo directories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ImpactReport } from "../../src/core/impact.ts";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { appendLedger, refineDir } from "../../src/refine/ledger.ts";
import type { Session } from "../../src/schema/index.ts";
import { CLI } from "../_cli.ts";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const APPLIED_AT_MS = NOW - 5 * DAY_MS;

const tempDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
  };
}

function runCli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function seededSession(
  id: string,
  opts: {
    agent: string;
    repoRoot: string;
    startedAt: number;
    flags?: string[];
    costUsd?: number;
    highRisk?: boolean;
    proof?: boolean;
    maxUnverifiedEdits?: number;
  },
): Session {
  const stats: Session["stats"] = {
    events: 12,
    turns: 3,
    toolCalls: 8,
    toolErrors: opts.flags?.includes("looping") ? 3 : 0,
    filesChanged: 2,
  };
  if (opts.costUsd !== undefined) stats.usage = { costUsd: opts.costUsd };
  if (opts.highRisk) stats.contextHygiene = { supervisionRisk: "high", riskReasons: ["dead-end-loop"] };
  if (opts.proof) {
    stats.verification = {
      checks: 3,
      passed: 1,
      failed: 2,
      maxUnverifiedEdits: opts.maxUnverifiedEdits ?? 6,
      proof: { langs: ["lean"], checks: 3, passed: 1, failed: 2, oscillatingChecks: 1, escapeRemaining: 1 },
    };
  } else if (opts.maxUnverifiedEdits !== undefined) {
    stats.verification = { checks: 1, passed: 1, failed: 0, maxUnverifiedEdits: opts.maxUnverifiedEdits };
  }
  return {
    id,
    agent: opts.agent,
    startedAt: opts.startedAt,
    endedAt: opts.startedAt + 60_000,
    cwd: opts.repoRoot,
    repo: { root: opts.repoRoot, head: "abc123" },
    title: `Task ${id}`,
    flags: opts.flags ?? [],
    stats,
  };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("coding.sh impact (empty store)", () => {
  it("reports zero sessions, store overhead, and empty-store next step", () => {
    const root = makeTmp("csh-cli-impact-empty-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const env = makeEnv(home);

    const text = runCli(repo, env, "impact");
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /Coverage & Overhead/);
    assert.match(text.stdout, /0 sessions/);
    assert.match(text.stderr, /No sessions captured yet/);

    const jsonRes = runCli(repo, env, "impact", "--json");
    assert.equal(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
    const doc = JSON.parse(jsonRes.stdout) as ImpactReport;
    assert.equal(doc.window.sessions, 0);
    assert.equal(doc.catches.flaggedSessions, 0);
    assert.equal(doc.overhead.spoolErrors, 0);
    assert.deepEqual(doc.refinements, []);
  });
});

describe("coding.sh impact (populated store)", () => {
  let root = "";
  let home = "";
  let repoA = "";
  let repoB = "";
  let env: NodeJS.ProcessEnv = {};

  before(async () => {
    root = makeTmp("csh-cli-impact-full-");
    home = join(root, "home");
    repoA = join(root, "repo-alpha");
    repoB = join(root, "repo-beta");
    mkdirSync(home, { recursive: true });
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    env = makeEnv(home);

    const { openContext } = await import("../../src/core/context.ts");
    const ctx = await openContext({ env, cwd: repoA });
    try {
      // 5 organic sessions BEFORE applied refinement in repo-alpha (4 flagged = 80%).
      for (let i = 0; i < 5; i++) {
        await ctx.index.upsertSession(
          seededSession(`alpha-before-${i}`, {
            agent: "claude-code",
            repoRoot: repoA,
            startedAt: APPLIED_AT_MS - (4 - i) * DAY_MS - 3_600_000,
            flags: i < 4 ? (i === 0 ? ["test-tamper", "looping"] : ["looping"]) : ["compaction"],
            costUsd: 2.0,
            highRisk: i === 0,
            proof: i === 0,
            maxUnverifiedEdits: i < 2 ? 6 : 1,
          }),
        );
      }

      // 5 organic sessions AFTER applied refinement in repo-alpha (1 flagged = 20%, cheaper).
      for (let i = 0; i < 5; i++) {
        await ctx.index.upsertSession(
          seededSession(`alpha-after-${i}`, {
            agent: "claude-code",
            repoRoot: repoA,
            startedAt: APPLIED_AT_MS + (i + 1) * 12 * 3_600_000,
            flags: i === 0 ? ["looping"] : ["skill:pdf"],
            costUsd: 1.0,
            maxUnverifiedEdits: 1,
          }),
        );
      }

      // 1 recent codex session in repo-beta (within last 12h).
      await ctx.index.upsertSession(
        seededSession("beta-codex-1", {
          agent: "codex",
          repoRoot: repoB,
          startedAt: NOW - 6 * 3_600_000,
          flags: [],
          costUsd: 0.5,
          maxUnverifiedEdits: 2,
        }),
      );

      // Seed one dataset and one experiment.
      const evalStore = new FileEvalStore({ root: ctx.paths.root, index: ctx.index });
      const ds = createDataset({
        name: "Impact DS",
        cases: [{ id: "c1", input: "hello", expected: "world" }],
      });
      await evalStore.putDataset(ds);
      await evalStore.putExperiment({
        id: "exp_01TESTIMPACT00000000000001",
        name: "baseline",
        dataset: { id: ds.id, name: ds.name, version: ds.version },
        task: { kind: "command", ref: "echo world" },
        graders: [{ id: "exact", version: "v1", kind: "exact" }],
        trials: 1,
        createdAt: NOW - DAY_MS,
        finishedAt: NOW - DAY_MS + 1000,
        status: "completed",
        runs: [],
        summary: {
          n: 1,
          cases: 1,
          passed: 1,
          errors: 0,
          passRate: { p: 1, lo: 0.2, hi: 1 },
          ciMethod: "wilson",
          graders: [],
          latencyMs: { mean: 10, median: 10, p90: 10, max: 10 },
        },
      });

      // Seed a spool file + one hook error line and one applied refinement in repo-alpha.
      mkdirSync(join(ctx.paths.spool, "claude-code"), { recursive: true });
      writeFileSync(join(ctx.paths.spool, "claude-code", "2026-10-15.jsonl"), '{"v":0}\n');
      writeFileSync(ctx.paths.spoolErrors, '{"err":"sample hook error"}\n');

      appendLedger(refineDir(env, repoA), {
        op: "apply",
        id: "a_impact_1",
        candidate: "r_1234567890",
        at: new Date(APPLIED_AT_MS).toISOString(),
        files: [{ path: "AGENTS.md", before: "aaaa", after: "bbbb" }],
      });
    } finally {
      await ctx.close();
    }
  });

  it("prints a scannable report and structured JSON with catches, overhead, artifacts, and improved refinement", () => {
    const text = runCli(repoA, env, "impact");
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /Coverage & Overhead/);
    assert.match(text.stdout, /Issues Surfaced/);
    assert.match(text.stdout, /Applied Refinements/);
    assert.match(text.stdout, /AGENTS\.md/);
    assert.match(text.stdout, /improved/);
    assert.match(text.stdout, /Spool errors\s+1/);
    assert.match(text.stderr, /test-tamper/);

    const jsonRes = runCli(repoA, env, "impact", "--json");
    assert.equal(jsonRes.status, 0, jsonRes.stdout + jsonRes.stderr);
    const doc = JSON.parse(jsonRes.stdout) as ImpactReport;
    assert.equal(doc.window.sessions, 11);
    assert.equal(doc.window.organicSessions, 11);
    assert.deepEqual(doc.window.agents, ["claude-code", "codex"]);
    assert.equal(doc.window.repos, 2);

    assert.equal(doc.catches.tamperFlags, 1);
    assert.equal(doc.catches.flaggedSessions, 5);
    assert.equal(doc.catches.highRiskSessions, 1);
    assert.equal(doc.catches.proofSessions, 1);
    assert.equal(doc.catches.proofOscillatingSessions, 1);
    assert.equal(doc.catches.proofWithEscapes, 1);
    assert.equal(doc.catches.unverifiedLongStreaks, 2);

    assert.deepEqual(doc.artifacts, { datasets: 1, experiments: 1, appliedRefinements: 1 });
    assert.ok(doc.overhead.indexBytes > 0);
    assert.ok(doc.overhead.spoolBytes > 0);
    assert.equal(doc.overhead.spoolErrors, 1);

    assert.equal(doc.refinements.length, 1);
    assert.equal(doc.refinements[0]!.status, "improved");
    assert.equal(doc.refinements[0]!.before.sessions, 5);
    assert.equal(doc.refinements[0]!.after.sessions, 6);
    assert.equal(doc.refinements[0]!.delta?.failureRatePp, -63.33);
    assert.equal(doc.refinements[0]!.delta?.medianCostUsd, -1);
  });

  it("filters by --repo, --agent, and --since", () => {
    const byRepo = runCli(repoA, env, "impact", "--repo", repoA, "--json");
    assert.equal(byRepo.status, 0, byRepo.stdout + byRepo.stderr);
    const repoDoc = JSON.parse(byRepo.stdout) as ImpactReport;
    assert.equal(repoDoc.window.sessions, 10);
    assert.equal(repoDoc.window.repos, 1);
    assert.equal(repoDoc.refinements.length, 1);
    assert.equal(repoDoc.refinements[0]!.before.sessions, 5);
    assert.equal(repoDoc.refinements[0]!.after.sessions, 5);
    assert.equal(repoDoc.refinements[0]!.delta?.failureRatePp, -60);
    assert.equal(repoDoc.refinements[0]!.delta?.medianCostUsd, -1);

    const byAgent = runCli(repoA, env, "impact", "--agent", "codex", "--json");
    assert.equal(byAgent.status, 0, byAgent.stdout + byAgent.stderr);
    const agentDoc = JSON.parse(byAgent.stdout) as ImpactReport;
    assert.equal(agentDoc.window.sessions, 1);
    assert.deepEqual(agentDoc.window.agents, ["codex"]);
    assert.equal(agentDoc.catches.flaggedSessions, 0);

    const bySince = runCli(repoA, env, "impact", "--since", "1d", "--json");
    assert.equal(bySince.status, 0, bySince.stdout + bySince.stderr);
    const sinceDoc = JSON.parse(bySince.stdout) as ImpactReport;
    assert.equal(sinceDoc.window.sessions, 1);
    assert.equal(sinceDoc.refinements.length, 1);
    assert.equal(sinceDoc.refinements[0]!.status, "improved");

    const emptyWindow = runCli(repoA, env, "impact", "--since", "1m");
    assert.equal(emptyWindow.status, 0, emptyWindow.stdout + emptyWindow.stderr);
    assert.match(emptyWindow.stderr, /No sessions matched this window or filter/);
  });
});
