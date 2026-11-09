// Which cases an `exp run` runs (X-26): the cases an earlier experiment
// failed or errored on, then case-id patterns, then a seeded sample, then the
// first N. The choice is stored as `metadata.selection`, so compare can tell a
// run on another run's failures from a run on the whole dataset.
//
// Running a change only on the cases a baseline failed and calling it better
// is regression to the mean: some of those failures were bad luck, and a
// re-run of the baseline itself would pass part of them. compare forces such
// a verdict to inconclusive unless both sides were chosen the same way.
import type { Case, CaseRun, ExperimentResult } from "../datasets/types.ts";
import { mulberry32 } from "../stats/prng.ts";

export interface SelectOpts {
  /** Only cases this experiment failed on (a graded trial that did not pass, or a task error). */
  fromFailing?: Pick<ExperimentResult, "id" | "runs">;
  /** Only cases with a task or infrastructure error in this experiment. */
  fromErrors?: Pick<ExperimentResult, "id" | "runs">;
  /** Case-id patterns (`*` and `?` wildcards); a case matching any is kept. */
  cases?: readonly string[];
  /** A seeded sample: a count (≥ 1) or a share (between 0 and 1). */
  sample?: number;
  /** Seed for the sample. Default 0. */
  seed?: number;
  /** Then only the first N, in dataset order. */
  firstN?: number;
}

/** Stored as `metadata.selection`. */
export interface CaseSelection {
  /** The cases came from this experiment's failures or errors. */
  from?: { kind: "failing" | "errors"; experiment: string };
  cases?: string[];
  sample?: number;
  seed?: number;
  firstN?: number;
  /** Cases selected, of how many in the split. */
  selected: number;
  of: number;
}

const failed = (r: CaseRun) => r.error !== undefined || (!r.pass && !r.ungraded);
const errored = (r: CaseRun) => r.error !== undefined || r.infra !== undefined;

function pattern(p: string): RegExp {
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** Validate a --sample value: an integer count ≥ 1, or a share strictly between 0 and 1. */
export function validSample(x: number): boolean {
  return Number.isFinite(x) && ((x > 0 && x < 1) || (Number.isInteger(x) && x >= 1));
}

/**
 * Apply the selection to cases already narrowed by split and filter. Cases
 * match by id, never by position. Throws a RangeError when nothing is left.
 * Without any option the cases come back as they are and no selection is
 * recorded.
 */
export function selectRunCases(cases: readonly Case[], o: SelectOpts): { cases: Case[]; selection?: CaseSelection } {
  const any = o.fromFailing || o.fromErrors || o.cases?.length || o.sample !== undefined || o.firstN !== undefined;
  if (!any) return { cases: [...cases] };
  if (o.fromFailing && o.fromErrors) throw new RangeError("choose cases from failures or from errors, not both");
  let out = [...cases];
  const sel: CaseSelection = { selected: 0, of: cases.length };
  const src = o.fromFailing ?? o.fromErrors;
  if (src) {
    const kind = o.fromFailing ? "failing" : "errors";
    const test = kind === "failing" ? failed : errored;
    const ids = new Set(src.runs.filter(test).map((r) => r.caseId));
    out = out.filter((c) => ids.has(c.id));
    sel.from = { kind, experiment: src.id };
    if (!out.length) throw new RangeError(`experiment ${src.id} has no ${kind === "failing" ? "failing" : "errored"} cases among the ${cases.length} selected`);
  }
  if (o.cases?.length) {
    const res = o.cases.map(pattern);
    out = out.filter((c) => res.some((re) => re.test(c.id)));
    sel.cases = [...o.cases];
    if (!out.length) throw new RangeError(`no case id matches ${o.cases.map((p) => JSON.stringify(p)).join(", ")}`);
  }
  if (o.sample !== undefined) {
    if (!validSample(o.sample)) throw new RangeError(`sample must be a count of at least 1 or a share between 0 and 1 (got ${o.sample})`);
    const seed = o.seed ?? 0;
    const k = o.sample < 1 ? Math.max(1, Math.round(out.length * o.sample)) : Math.min(out.length, o.sample);
    // Shuffle the ids in sorted order, so the draw depends on the seed and the ids alone.
    const ids = out.map((c) => c.id).sort();
    const rand = mulberry32(seed);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    const keep = new Set(ids.slice(0, k));
    out = out.filter((c) => keep.has(c.id));
    sel.sample = o.sample;
    sel.seed = seed;
  }
  if (o.firstN !== undefined) {
    if (!(Number.isInteger(o.firstN) && o.firstN >= 1)) throw new RangeError(`firstN must be a positive integer (got ${o.firstN})`);
    out = out.slice(0, o.firstN);
    sel.firstN = o.firstN;
  }
  sel.selected = out.length;
  return { cases: out, selection: sel };
}

/** The stored selection of an experiment, if it ran on a subset. */
export function selectionOf(r: Pick<ExperimentResult, "metadata">): CaseSelection | undefined {
  const s = r.metadata?.selection;
  return s && typeof s === "object" ? (s as CaseSelection) : undefined;
}

/**
 * The regression-to-the-mean guard: set when one side ran only on the other
 * side's failures (or errors) and the two were not chosen the same way.
 */
export function selectionWarning(a: Pick<ExperimentResult, "id" | "metadata">, b: Pick<ExperimentResult, "id" | "metadata">): string | undefined {
  const sa = selectionOf(a)?.from;
  const sb = selectionOf(b)?.from;
  if (sa && sb && sa.experiment === sb.experiment && sa.kind === sb.kind) return undefined;
  const [subset, base, label, baseLabel] = sb?.experiment === a.id ? [sb, a, "B", "A"] : sa?.experiment === b.id ? [sa, b, "A", "B"] : [];
  if (!subset || !base) return undefined;
  const what = subset.kind === "failing" ? "failed" : "errored on";
  const flag = subset.kind === "failing" ? "--failing" : "--errors-from";
  return (
    `${label} ran only on the cases ${baseLabel} ${what} (${flag} ${base.id}), so ${baseLabel}'s score there is its worst luck and ${label} looks better from regression to the mean alone. ` +
    `Re-run ${baseLabel}'s config on the same cases (coding.sh exp run <${baseLabel}'s spec> ${flag} ${base.id}) and compare ${label} with that`
  );
}
