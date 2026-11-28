// coding.sh impact [--since 30d] [--repo <DIR|NAME>] [--agent <NAME>] [--json] [--fresh]
//
// Summarizes local store overhead, surfaced session issues (test tampering,
// supervision risk, unverified edit streaks, formal proof issues), eval
// artifacts, and honest before/after comparisons for applied refinements.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  computeImpact,
  DEFAULT_REFINEMENT_WINDOW_MS,
  MAX_REFINEMENTS_SHOWN,
  measureStoreOverhead,
  type ImpactReport,
  type RefinementStatus,
} from "../../core/impact.ts";
import { userHome } from "../../core/paths.ts";
import type { SessionFilter } from "../../core/types.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import { parsePlace, TOTALS_SCAN_CAP, type Place } from "../../mcp/data.ts";
import { findSessions } from "../../query/run.ts";
import { liveApplies, readLedger, refineDir, type LedgerEntry } from "../../refine/ledger.ts";
import { parseSinceWhen, UsageError } from "../args.ts";
import {
  agentScope,
  agentsFlag,
  autoIngest,
  pendingField,
  queryCliError,
  readIngest,
  rejectAgentTypos,
  scanCap,
  stoppedAfter,
  str,
  timeWindow,
  windowNote,
  withContext,
} from "../common.ts";
import { noSessionsNext } from "../first-session.ts";
import { bytes, plural, usd, type Output, type Style } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { withRepo } from "./sessions.ts";
import { emptyWindow } from "./stats.ts";

const STATUS_STYLE: Record<RefinementStatus, Style> = {
  improved: "green",
  regressed: "red",
  mixed: "yellow",
  "insufficient-data": "faint",
};

const pct = (x: number | null): string => (x === null ? "-" : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`);

function readScopedLedgers(home: string, env: NodeJS.ProcessEnv, place: Place | undefined): LedgerEntry[] {
  const refineRoot = join(home, "refine");
  if (!existsSync(refineRoot)) return [];

  const dirs = new Set<string>();
  if (existsSync(join(refineRoot, "ledger.jsonl"))) dirs.add(refineRoot);

  if (place) {
    const repoRoot = place.repo ?? place.path;
    if (repoRoot) {
      const exact = refineDir(env, repoRoot);
      if (existsSync(exact)) dirs.add(exact);
    } else if (place.name) {
      const slug = place.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      try {
        for (const entry of readdirSync(refineRoot, { withFileTypes: true })) {
          if (entry.isDirectory() && (entry.name === slug || entry.name.startsWith(`${slug}-`))) {
            dirs.add(join(refineRoot, entry.name));
          }
        }
      } catch {
        // Missing or unreadable refine dir: leave empty.
      }
    }
  } else {
    try {
      for (const entry of readdirSync(refineRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(join(refineRoot, entry.name));
      }
    } catch {
      // Missing or unreadable refine dir: leave empty.
    }
  }

  const out: LedgerEntry[] = [];
  for (const dir of [...dirs].sort()) out.push(...readLedger(dir));
  return out;
}

function renderReport(out: Output, sinceLabel: string, r: ImpactReport): void {
  const { window: w, catches: c, artifacts: a, overhead: o } = r;

  out.print(out.style("Coverage & Overhead", "bold"));
  const agentList = w.agents.length ? w.agents.join(", ") : "none";
  out.row("Window", `${sinceLabel} (${plural(w.sessions, "session")}, ${w.organicSessions} organic; agents: ${agentList}; ${plural(w.repos, "repo")})`, "none", true);
  out.row("Store size", `${bytes(o.totalBytes)} (index ${bytes(o.indexBytes)}, blobs ${bytes(o.blobsBytes)}, spool ${bytes(o.spoolBytes)})`, "none", true);
  out.row("Spool errors", String(o.spoolErrors), o.spoolErrors > 0 ? "warn" : "ok", true);
  out.row("Artifacts", `${plural(a.datasets, "dataset")}, ${plural(a.experiments, "experiment")}, ${plural(a.appliedRefinements, "applied refinement")}`, "none", true);

  if (w.sessions === 0) return;

  out.print();
  out.print(out.style("Issues Surfaced", "bold"));
  out.row("Flagged", `${c.flaggedSessions} of ${w.sessions} (${pct(c.failureRate)})`, c.flaggedSessions > 0 ? "warn" : "ok", true);
  out.row("Test tamper", plural(c.tamperFlags, "session"), c.tamperFlags > 0 ? "warn" : "none", true);
  out.row("Supervision risk", `${c.highRiskSessions} high, ${c.mediumRiskSessions} medium`, c.highRiskSessions > 0 ? "warn" : "none", true);
  out.row("Unverified streaks", `${plural(c.unverifiedLongStreaks, "session")} (>=5 edits before a check)`, c.unverifiedLongStreaks > 0 ? "warn" : "none", true);

  const proofDetail =
    c.proofSessions > 0
      ? `${plural(c.proofSessions, "session")} (${c.proofOscillatingSessions} oscillating, ${c.proofWithEscapes} with escapes)`
      : "0 sessions";
  out.row("Formal proofs", proofDetail, c.proofWithEscapes > 0 || c.proofOscillatingSessions > 0 ? "warn" : "none", true);

  if (c.totalCostUsd !== undefined) {
    const wastePart =
      c.wastedSpendUsd !== undefined
        ? `, ${usd(c.wastedSpendUsd)} wasted (flagged sessions + unflagged cache breaks)`
        : "";
    out.row("Spend", `${usd(c.totalCostUsd)} total${wastePart}`, "none", true);
  } else if (c.wastedSpendUsd !== undefined) {
    out.row("Cache waste", usd(c.wastedSpendUsd), "none", true);
  }

  out.print();
  out.print(out.style("Applied Refinements (14d Before vs After)", "bold"));
  if (r.refinements.length > 0) {
    out.table(
      ["TARGET", "APPLIED", "BEFORE", "AFTER", "FAIL%", "MED COST", "STATUS"],
      r.refinements.map((item) => [
        item.target,
        item.appliedAt.slice(0, 10),
        String(item.before.sessions),
        String(item.after.sessions),
        `${pct(item.before.failureRate)} -> ${pct(item.after.failureRate)}`,
        `${usd(item.before.medianCostUsd ?? undefined)} -> ${usd(item.after.medianCostUsd ?? undefined)}`,
        out.style(item.status, STATUS_STYLE[item.status]),
      ]),
    );
    if (r.refinements.some((item) => item.status === "insufficient-data")) {
      out.note("insufficient-data: fewer than 5 organic sessions on at least one side of the 14-day window.");
    }
  } else {
    out.note("No applied refinements recorded yet.");
  }
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const now = Date.now();
  const sinceRaw = str(c.flags.since) ?? "30d";
  const sinceWhen = parseSinceWhen(sinceRaw, now);
  const since = sinceWhen.ms;
  const until = now;
  if (!(since < until)) throw emptyWindow(sinceRaw, since, undefined, until);

  const repo = str(c.flags.repo);
  if (repo !== undefined && !repo.trim()) {
    throw new UsageError("--repo needs a path or a repo name", { reason: "invalid_argument" });
  }
  const place = repo !== undefined ? parsePlace(repo, c.cwd, userHome(c.env)) : undefined;
  const agents = agentsFlag(c);
  const scope = agentScope(agents, undefined);
  const scopedWhere = withRepo(scope.where, repo, c);
  const window = timeWindow({ since: sinceWhen });
  const cap = scanCap(c.env) ?? TOTALS_SCAN_CAP;

  return withContext(
    c,
    async (ctx) => {
      const backlog = await autoIngest(ctx, readIngest(c));
      const ledgerEntries = readScopedLedgers(ctx.paths.root, c.env, place);
      const recentApplies = liveApplies(ledgerEntries)
        .map((a) => Date.parse(a.at))
        .filter((ms) => Number.isFinite(ms))
        .sort((a, b) => b - a)
        .slice(0, MAX_REFINEMENTS_SHOWN);

      let earliestNeeded = since;
      for (const atMs of recentApplies) {
        const beforeStart = atMs - DEFAULT_REFINEMENT_WINDOW_MS;
        if (beforeStart < earliestNeeded) earliestNeeded = beforeStart;
      }

      const filter: Omit<SessionFilter, "limit" | "offset"> = {
        since: earliestNeeded,
        until,
        parentSessionId: null,
      };
      if (scope.agent) filter.agent = scope.agent;

      let found;
      try {
        found = await findSessions(ctx.index, scopedWhere ?? {}, { filter, limit: cap });
      } catch (err) {
        throw queryCliError(err);
      }

      const windowSessions = found.sessions.filter((s) => s.startedAt >= since && s.startedAt < until);
      if (windowSessions.length === 0) await rejectAgentTypos(ctx.index, agents);

      const evalStore = new FileEvalStore({ root: ctx.paths.root, index: ctx.index });
      const [datasets, experiments] = await Promise.all([evalStore.listDatasets(), evalStore.listExperiments()]);
      const overhead = measureStoreOverhead(ctx.paths);

      const report = computeImpact({
        since,
        until,
        sessions: windowSessions,
        comparisonSessions: found.sessions,
        ledgerEntries,
        datasets: datasets.length,
        experiments: experiments.length,
        overhead,
      });

      if (out.json) {
        const doc: Record<string, unknown> = { ...report };
        Object.assign(doc, pendingField(backlog));
        if (found.truncated) doc.truncated = true;
        out.data(doc);
        return 0;
      }

      windowNote(out, window);
      renderReport(out, sinceRaw, report);

      if (found.truncated) out.warn(stoppedAfter(cap));

      if (report.window.sessions === 0) {
        if (!(await ctx.index.listSessions({ limit: 1 })).length) {
          out.note("No sessions captured yet");
          const next = noSessionsNext(c.env);
          out.next(next.label, next.command);
        } else {
          out.note("No sessions matched this window or filter");
          out.next("Widen the window", "coding.sh impact --since 90d");
        }
        return 0;
      }

      if (report.catches.tamperFlags > 0) {
        out.next("Inspect sessions flagged for test or proof tampering", "coding.sh sessions --flag test-tamper");
      } else if (report.refinements.length === 0 && report.catches.flaggedSessions > 0) {
        out.next("Mine recurring failures to draft a harness refinement", "coding.sh refine mine");
      } else if (report.artifacts.datasets === 0 && report.catches.flaggedSessions > 0) {
        out.next("Turn flagged sessions into a replayable eval suite", "coding.sh eval init --sessions");
      } else if (report.catches.highRiskSessions > 0) {
        out.next("Review high supervision-risk work items", "coding.sh work --risk high");
      }

      return 0;
    },
    { create: false },
  );
}
