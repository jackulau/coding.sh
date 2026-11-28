// Unit tests for the pure workflow impact engine and store overhead helper.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  computeImpact,
  measureStoreOverhead,
  type StoreOverhead,
} from "../../src/core/impact.ts";
import type { ApplyEntry, LedgerEntry, RollbackEntry } from "../../src/refine/ledger.ts";
import type { Session } from "../../src/schema/index.ts";

const DAY_MS = 86_400_000;
const BASE_TS = Date.UTC(2026, 9, 15, 12, 0, 0);
const ZERO_OVERHEAD: StoreOverhead = {
  indexBytes: 0,
  blobsBytes: 0,
  spoolBytes: 0,
  totalBytes: 0,
  spoolErrors: 0,
};

const tempDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeSession(id: string, overrides: Omit<Partial<Session>, "stats"> & { stats?: Partial<Session["stats"]> } = {}): Session {
  const baseStats: Session["stats"] = {
    events: 10,
    turns: 2,
    toolCalls: 10,
    toolErrors: 0,
    filesChanged: 1,
  };
  const { stats, ...rest } = overrides;
  return {
    id,
    agent: "claude-code",
    startedAt: BASE_TS,
    flags: [],
    repo: { root: "/work/demo", head: "abc123" },
    ...rest,
    stats: { ...baseStats, ...stats },
  };
}

function makeApply(id: string, candidate: string, at: string, paths: string[] = ["AGENTS.md"]): ApplyEntry {
  return {
    op: "apply",
    id,
    candidate,
    at,
    files: paths.map((p) => ({ path: p, before: "1111", after: "2222" })),
  };
}

describe("computeImpact catches and window", () => {
  it("counts tamper, supervision risk, proof issues, unverified streaks, and excludes context/tag flags", () => {
    const sessions: Session[] = [
      makeSession("s-tamper", {
        agent: "claude-code",
        flags: ["test-tamper", "skill:pdf"],
        stats: {
          usage: { costUsd: 1.5 },
          cacheBreaks: { count: 1, lostTokens: 1000, extraUsd: 0.4, byCause: { other: { count: 1, lostTokens: 1000, extraUsd: 0.4 } } },
          contextHygiene: { supervisionRisk: "high", riskReasons: ["dead-end-loop"] },
          verification: {
            checks: 4,
            passed: 1,
            failed: 3,
            maxUnverifiedEdits: 6,
            proof: { langs: ["lean"], checks: 4, passed: 1, failed: 3, oscillatingChecks: 2, escapeRemaining: 1 },
          },
        },
      }),
      makeSession("s-context-only", {
        agent: "codex",
        repo: { root: "/work/other", head: "def456" },
        flags: ["compaction", "step-retried", "resumed", "gateway:vercel", "skill:docs"],
        stats: {
          usage: { costUsd: 2.0 },
          cacheBreaks: { count: 1, lostTokens: 2000, extraUsd: 0.25, byCause: { idle: { count: 1, lostTokens: 2000, extraUsd: 0.25 } } },
          contextHygiene: { supervisionRisk: "medium", riskReasons: ["compaction-churn"] },
          verification: {
            checks: 2,
            passed: 2,
            failed: 0,
            maxUnverifiedEdits: 4,
            proof: { langs: ["rocq"], checks: 2, passed: 2, failed: 0 },
          },
        },
      }),
      makeSession("s-run-clean", {
        agent: "claude-code",
        runId: "run_eval_1",
        flags: [],
        stats: {
          usage: { costUsd: 0.5 },
          verification: { checks: 1, passed: 1, failed: 0, maxUnverifiedEdits: 5 },
        },
      }),
    ];

    const report = computeImpact({
      since: BASE_TS - DAY_MS,
      until: BASE_TS + DAY_MS,
      sessions,
      datasets: 3,
      experiments: 7,
      overhead: { indexBytes: 100, blobsBytes: 200, spoolBytes: 50, totalBytes: 350, spoolErrors: 0 },
    });

    assert.equal(report.window.sessions, 3);
    assert.equal(report.window.organicSessions, 2);
    assert.deepEqual(report.window.agents, ["claude-code", "codex"]);
    assert.equal(report.window.repos, 2);

    assert.equal(report.catches.tamperFlags, 1);
    assert.equal(report.catches.flaggedSessions, 1);
    assert.equal(report.catches.failureRate, 0.3333);
    assert.equal(report.catches.highRiskSessions, 1);
    assert.equal(report.catches.mediumRiskSessions, 1);
    assert.equal(report.catches.proofSessions, 2);
    assert.equal(report.catches.proofOscillatingSessions, 1);
    assert.equal(report.catches.proofWithEscapes, 1);
    assert.equal(report.catches.unverifiedLongStreaks, 2);

    // Flagged session s-tamper ($1.50) counted once + unflagged s-context-only cache waste ($0.25).
    assert.equal(report.catches.totalCostUsd, 4);
    assert.equal(report.catches.wastedSpendUsd, 1.75);

    assert.deepEqual(report.artifacts, { datasets: 3, experiments: 7, appliedRefinements: 0 });
    assert.equal(report.overhead.totalBytes, 350);
  });

  it("omits totalCostUsd and wastedSpendUsd when no session carries cost or cache waste", () => {
    const report = computeImpact({
      since: BASE_TS - DAY_MS,
      until: BASE_TS + DAY_MS,
      sessions: [makeSession("s-unpriced")],
      overhead: ZERO_OVERHEAD,
    });
    assert.equal(report.catches.totalCostUsd, undefined);
    assert.equal(report.catches.wastedSpendUsd, undefined);
  });
});

describe("computeImpact applied refinements", () => {
  const appliedAt = new Date(BASE_TS).toISOString();

  function batch(prefix: string, offsetDays: number, specs: { fail?: boolean; cost?: number; unverified?: number; pushback?: number; replied?: number; toolErrors?: number; runId?: string }[]): Session[] {
    return specs.map((sp, i) =>
      makeSession(`${prefix}-${i}`, {
        startedAt: BASE_TS + offsetDays * DAY_MS + i * 3_600_000,
        flags: sp.fail ? ["looping"] : [],
        runId: sp.runId,
        stats: {
          toolCalls: 10,
          toolErrors: sp.toolErrors ?? 0,
          usage: sp.cost !== undefined ? { costUsd: sp.cost } : undefined,
          verification: sp.unverified !== undefined ? { checks: 1, passed: 1, failed: 0, maxUnverifiedEdits: sp.unverified } : undefined,
          turnsByModel:
            sp.replied !== undefined
              ? { "claude-sonnet": { turns: sp.replied + 1, replied: sp.replied, pushback: sp.pushback ? { broken: sp.pushback } : undefined } }
              : undefined,
        },
      }),
    );
  }

  it("marks a refinement improved when >=5 organic sessions on each side show a clear failure-rate drop", () => {
    const before = batch("b", -5, [
      { fail: true, cost: 2.0, unverified: 6, replied: 2, pushback: 1, toolErrors: 3 },
      { fail: true, cost: 2.0, unverified: 6, replied: 2, pushback: 1, toolErrors: 2 },
      { fail: true, cost: 2.0, unverified: 5, replied: 2, pushback: 1, toolErrors: 2 },
      { fail: true, cost: 2.0, unverified: 2, replied: 2, pushback: 0, toolErrors: 1 },
      { fail: false, cost: 2.0, unverified: 1, replied: 2, pushback: 0, toolErrors: 0 },
    ]);
    const after = batch("a", 3, [
      { fail: true, cost: 1.0, unverified: 1, replied: 2, pushback: 0, toolErrors: 0 },
      { fail: false, cost: 1.0, unverified: 1, replied: 2, pushback: 0, toolErrors: 0 },
      { fail: false, cost: 1.0, unverified: 2, replied: 2, pushback: 0, toolErrors: 0 },
      { fail: false, cost: 1.0, unverified: 1, replied: 2, pushback: 0, toolErrors: 0 },
      { fail: false, cost: 1.0, unverified: 1, replied: 2, pushback: 0, toolErrors: 0 },
    ]);
    const ledger: LedgerEntry[] = [makeApply("a_imp1", "r_1111111111", appliedAt, ["AGENTS.md"])];

    const report = computeImpact({
      since: BASE_TS - 14 * DAY_MS,
      until: BASE_TS + 14 * DAY_MS,
      sessions: [...before, ...after],
      ledgerEntries: ledger,
      overhead: ZERO_OVERHEAD,
    });

    assert.equal(report.artifacts.appliedRefinements, 1);
    assert.equal(report.refinements.length, 1);
    const ref = report.refinements[0]!;
    assert.equal(ref.status, "improved");
    assert.equal(ref.target, "AGENTS.md");
    assert.equal(ref.before.sessions, 5);
    assert.equal(ref.after.sessions, 5);
    assert.equal(ref.before.failureRate, 0.8);
    assert.equal(ref.after.failureRate, 0.2);
    assert.ok(ref.delta);
    assert.equal(ref.delta.failureRatePp, -60);
    assert.equal(ref.delta.medianCostUsd, -1);
    assert.equal(ref.delta.unverifiedEditRate, -0.6);
    assert.equal(ref.delta.pushbackRatePp, -30);
    assert.equal(ref.delta.toolErrorRatePp, -16);
  });

  it("marks a refinement regressed when failure rate clearly worsens", () => {
    const before = batch("b", -4, [
      { fail: true, cost: 1.0 },
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
    ]);
    const after = batch("a", 2, [
      { fail: true, cost: 1.0 },
      { fail: true, cost: 1.0 },
      { fail: true, cost: 1.0 },
      { fail: true, cost: 1.0 },
      { fail: false, cost: 1.0 },
    ]);
    const report = computeImpact({
      since: BASE_TS - 14 * DAY_MS,
      until: BASE_TS + 14 * DAY_MS,
      sessions: [...before, ...after],
      ledgerEntries: [makeApply("a_reg1", "r_2222222222", appliedAt, ["CLAUDE.md"])],
      overhead: ZERO_OVERHEAD,
    });

    const ref = report.refinements[0]!;
    assert.equal(ref.status, "regressed");
    assert.equal(ref.delta?.failureRatePp, 60);
  });

  it("marks a refinement mixed when one metric improves while another worsens", () => {
    const before = batch("b", -4, [
      { fail: true, cost: 1.0 },
      { fail: true, cost: 1.0 },
      { fail: true, cost: 1.0 },
      { fail: true, cost: 1.0 },
      { fail: false, cost: 1.0 },
    ]);
    const after = batch("a", 2, [
      { fail: false, cost: 3.0 },
      { fail: false, cost: 3.0 },
      { fail: false, cost: 3.0 },
      { fail: false, cost: 3.0 },
      { fail: true, cost: 3.0 },
    ]);
    const report = computeImpact({
      since: BASE_TS - 14 * DAY_MS,
      until: BASE_TS + 14 * DAY_MS,
      sessions: [...before, ...after],
      ledgerEntries: [makeApply("a_mix1", "r_3333333333", appliedAt)],
      overhead: ZERO_OVERHEAD,
    });

    assert.equal(report.refinements[0]!.status, "mixed");
    assert.equal(report.refinements[0]!.delta?.failureRatePp, -60);
    assert.equal(report.refinements[0]!.delta?.medianCostUsd, 2);
  });

  it("marks a refinement insufficient-data when fewer than 5 organic sessions exist on either side", () => {
    const before = batch("b", -4, [
      { fail: true, cost: 2.0 },
      { fail: true, cost: 2.0 },
      { fail: true, cost: 2.0 },
      { fail: true, cost: 2.0 },
      // Trial run with runId must not count toward organic sample size.
      { fail: true, cost: 2.0, runId: "run_trial_1" },
    ]);
    const after = batch("a", 2, [
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
      { fail: false, cost: 1.0 },
    ]);
    const report = computeImpact({
      since: BASE_TS - 14 * DAY_MS,
      until: BASE_TS + 14 * DAY_MS,
      sessions: [...before, ...after],
      ledgerEntries: [makeApply("a_small", "r_4444444444", appliedAt)],
      overhead: ZERO_OVERHEAD,
    });

    const ref = report.refinements[0]!;
    assert.equal(ref.before.sessions, 4);
    assert.equal(ref.after.sessions, 5);
    assert.equal(ref.status, "insufficient-data");
    assert.equal(ref.delta, undefined);
  });

  it("excludes rolled-back applies and caps refinements to the 5 most recent live applies", () => {
    const entries: LedgerEntry[] = [];
    for (let i = 1; i <= 7; i++) {
      entries.push(makeApply(`a_live_${i}`, `r_000000000${i}`, new Date(BASE_TS - (10 - i) * DAY_MS).toISOString(), [`rule-${i}.md`]));
    }
    const rolledBack: RollbackEntry = {
      op: "rollback",
      id: "rb_1",
      apply: "a_live_7",
      candidate: "r_0000000007",
      at: new Date(BASE_TS).toISOString(),
      files: [{ path: "rule-7.md", restored: "1111" }],
    };
    entries.push(rolledBack);

    const report = computeImpact({
      since: BASE_TS - 30 * DAY_MS,
      until: BASE_TS + DAY_MS,
      sessions: [],
      ledgerEntries: entries,
      overhead: ZERO_OVERHEAD,
    });

    assert.equal(report.artifacts.appliedRefinements, 6);
    assert.equal(report.refinements.length, 5);
    assert.deepEqual(
      report.refinements.map((r) => r.id),
      ["a_live_6", "a_live_5", "a_live_4", "a_live_3", "a_live_2"],
    );
  });
});

describe("measureStoreOverhead", () => {
  it("returns zeros on missing directories without throwing", () => {
    const missing = join(makeTmp("csh-impact-missing-"), "nope");
    const ov = measureStoreOverhead({
      index: join(missing, "index.db"),
      blobs: join(missing, "blobs"),
      spool: join(missing, "spool"),
      spoolErrors: join(missing, "spool", "errors.log"),
    });
    assert.deepEqual(ov, ZERO_OVERHEAD);
  });

  it("measures partial stores with index and WAL files only", () => {
    const root = makeTmp("csh-impact-partial-");
    const idx = join(root, "index.db");
    writeFileSync(idx, "0123456789");
    writeFileSync(`${idx}-wal`, "abcde");
    const ov = measureStoreOverhead({
      index: idx,
      blobs: join(root, "blobs"),
      spool: join(root, "spool"),
    });
    assert.equal(ov.indexBytes, 15);
    assert.equal(ov.blobsBytes, 0);
    assert.equal(ov.spoolBytes, 0);
    assert.equal(ov.totalBytes, 15);
    assert.equal(ov.spoolErrors, 0);
  });

  it("sums nested blobs, spool files, and non-empty spool error lines", () => {
    const root = makeTmp("csh-impact-full-");
    const idx = join(root, "index.db");
    const blobs = join(root, "blobs");
    const spool = join(root, "spool");
    mkdirSync(join(blobs, "ab"), { recursive: true });
    mkdirSync(join(spool, "claude-code"), { recursive: true });

    writeFileSync(idx, "a".repeat(100));
    writeFileSync(join(blobs, "ab", "blob1"), "b".repeat(250));
    writeFileSync(join(blobs, "blob2"), "c".repeat(50));
    writeFileSync(join(spool, "claude-code", "2026-10-15.jsonl"), "d".repeat(80));
    const errorsText = '{"err":"one"}\n\n{"err":"two"}\n   \n';
    const errorsPath = join(spool, "errors.log");
    writeFileSync(errorsPath, errorsText);

    const ov = measureStoreOverhead({
      index: idx,
      blobs,
      spool,
      spoolErrors: errorsPath,
    });
    assert.equal(ov.indexBytes, 100);
    assert.equal(ov.blobsBytes, 300);
    assert.equal(ov.spoolBytes, 80 + Buffer.byteLength(errorsText));
    assert.equal(ov.totalBytes, ov.indexBytes + ov.blobsBytes + ov.spoolBytes);
    assert.equal(ov.spoolErrors, 2);
  });
});
