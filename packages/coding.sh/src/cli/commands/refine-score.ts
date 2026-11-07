// coding.sh refine score: diagnoses scored against human labels by code
// (src/refine/match.ts). With --pred files it scores each file, and with two
// or more it adds repeat agreement. Without --pred it scores the session flags
// of the labelled sessions (FLAG_DIAGNOSIS), which name no component, so they
// match on session and types alone. Writes nothing.
//
// Y-5's `refine diagnose --eval` should reuse scoreRun() and printRun() on its
// diagnoses rather than add a second scorer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pct } from "../../experiments/text.ts";
import {
  FAMILIES,
  flagPrecision,
  flagPredictions,
  parseLabels,
  repeatAgreement,
  scoreOccurrences,
  scoreSignals,
  sessionPresence,
  signalCoverage,
  type Agreement,
  type Coverage,
  type FamilyId,
  type FamilyRecall,
  type FlagPrecision,
  type Labels,
  type Occurrence,
  type Rates,
  type SignalScore,
} from "../../refine/index.ts";
import { UsageError } from "../args.ts";
import { list, withContext } from "../common.ts";
import { CliError, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

export interface RunScore {
  source: string;
  predictions: number;
  /** Predictions in sessions the labels do not name: left out. */
  ignored: number;
  occurrences: Rates;
  byFamily: Partial<Record<FamilyId, FamilyRecall>>;
  signals: Omit<SignalScore, "pairs">;
  sessions: Rates;
  coverage: Coverage;
  byFlag?: FlagPrecision[];
}

function readLabels(c: CommandContext, file: string, what: string): Labels {
  let text: string;
  try {
    text = readFileSync(resolve(c.cwd, file), "utf8");
  } catch (e) {
    throw new CliError(`Can't read ${what} ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`, { reason: "not_found" });
  }
  const l = parseLabels(text);
  if (l.errors.length) {
    for (const e of l.errors.slice(0, 20)) c.out.warn(`${file}:${e.line}: ${e.message}`);
    if (l.errors.length > 20) c.out.warn(`… and ${plural(l.errors.length - 20, "more problem")}`);
    throw new CliError(`${plural(l.errors.length, "problem")} in ${what} ${file}`, {
      reason: "invalid_file",
      next: ["See the labels format:", "coding.sh refine score --help"],
      data: { file, errors: l.errors },
    });
  }
  return l;
}

/** One prediction run scored against the reference. */
export function scoreRun(source: string, pred: readonly Occurrence[], ref: readonly Occurrence[], sessions: ReadonlySet<string>, opts: { byFlag?: boolean } = {}): RunScore {
  const kept = pred.filter((o) => sessions.has(o.sessionId));
  const { pairs, byFamily, ...occurrences } = scoreOccurrences(kept, ref);
  const { pairs: _, ...signals } = scoreSignals(kept, ref);
  return {
    source,
    predictions: kept.length,
    ignored: pred.length - kept.length,
    occurrences,
    byFamily,
    signals,
    sessions: sessionPresence(kept, ref),
    coverage: signalCoverage(pairs, ref),
    ...(opts.byFlag ? { byFlag: flagPrecision(kept, ref) } : {}),
  };
}

const frac = (rate: number, n: number, d: number): string => `${pct(rate)} (${n}/${d})`;
const prf = (r: Rates): string => `P ${frac(r.precision, r.tp, r.tp + r.fp)}  R ${frac(r.recall, r.tp, r.tp + r.fn)}  F1 ${pct(r.f1)}`;
const pad = (s: string): string => s.padEnd(12);

export function printRun(out: Output, r: RunScore): void {
  out.print(`${r.source} (${plural(r.predictions, "prediction")}${r.ignored ? `; ${r.ignored} in unlabelled sessions left out` : ""})`);
  out.print(`  ${pad("occurrences")}${prf(r.occurrences)}`);
  out.print(`  ${pad("signals")}${prf(r.signals)}`);
  out.print(`  ${pad("sessions")}${prf(r.sessions)}`);
  const c = r.coverage;
  out.print(`  ${pad("coverage")}>=1 matched ${frac(c.atLeastOneRate, c.atLeastOne, c.signals)}  >=half matched ${frac(c.atLeastHalfRate, c.atLeastHalf, c.signals)} of labelled Signals`);
  const fams = FAMILIES.flatMap((f) => (r.byFamily[f.id] ? [`${f.id} ${frac(r.byFamily[f.id]!.recall, r.byFamily[f.id]!.tp, r.byFamily[f.id]!.n)}`] : []));
  if (fams.length) out.print(`  ${pad("recall")}${fams.join(", ")}`);
  for (const f of r.byFlag ?? []) out.print(`  ${pad("flag")}${f.flag} P ${frac(f.precision, f.tp, f.n)}`);
}

export async function refineScore(c: CommandContext): Promise<number> {
  const { out } = c;
  const file = c.positionals[0];
  if (!file) throw new UsageError("Name the labels file", { reason: "missing_argument", suggestion: "coding.sh refine score labels.jsonl --pred diagnoses.jsonl" });
  const labels = readLabels(c, file, "labels");
  const predFiles = list(c.flags.pred);
  let ref = labels.occurrences;
  let sessions = new Set(labels.sessions);
  if (!sessions.size) throw new CliError(`No labelled sessions in ${file}`, { reason: "invalid_file" });

  const runs: { source: string; items: Occurrence[] }[] = [];
  const missing: string[] = [];
  if (predFiles.length) {
    for (const f of predFiles) runs.push({ source: f, items: readLabels(c, f, "predictions").occurrences });
  } else {
    const found = await withContext(c, async (ctx) => {
      const rows = [];
      for (const id of labels.sessions) {
        const s = await ctx.index.getSession(id);
        if (s) rows.push(s);
        else missing.push(id);
      }
      return rows;
    });
    missing.sort();
    if (!found.length) throw new CliError(`None of the ${plural(sessions.size, "labelled session")} is in the store`, { reason: "not_found", next: ["Score prediction files instead:", "coding.sh refine score labels.jsonl --pred diagnoses.jsonl"] });
    if (missing.length) {
      sessions = new Set(found.map((s) => s.id));
      ref = ref.filter((o) => sessions.has(o.sessionId));
    }
    runs.push({ source: "flags", items: flagPredictions(found) });
  }

  const flagMode = !predFiles.length;
  const scores = runs.map((r) => scoreRun(r.source, r.items, ref, sessions, { byFlag: flagMode }));
  const agreement: Agreement | undefined = runs.length >= 2 ? repeatAgreement(runs.map((r) => r.items.filter((o) => sessions.has(o.sessionId))), [...sessions]) : undefined;
  const signalCount = new Set(ref.map((o) => o.signalId)).size;

  if (out.json) {
    out.data({
      labels: { file, occurrences: ref.length, signals: signalCount, sessions: sessions.size },
      mode: flagMode ? "flags" : "pred",
      ...(missing.length ? { missing } : {}),
      runs: scores,
      ...(agreement ? { agreement } : {}),
    });
    return 0;
  }
  if (missing.length) out.warn(`${plural(missing.length, "labelled session")} not in the store, left out: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  out.print(`Labels: ${file}, ${plural(ref.length, "occurrence")} in ${plural(signalCount, "Signal")} over ${plural(sessions.size, "session")}`);
  for (const s of scores) {
    out.print();
    printRun(out, s);
  }
  if (agreement) {
    out.print();
    out.print(`repeat agreement ${pct(agreement.agreement)} (${plural(agreement.runs, "run")}, ${plural(agreement.pairs, "pair")}, ${plural(agreement.sessions, "session")})`);
  }
  if (flagMode) out.note("Flags name no component: a flag matches a labelled occurrence in its session that shares a type id.");
  return 0;
}
