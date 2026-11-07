// Verify stage scored against truth (docs/WORKFLOWS.md §5): each finding that
// entered verify is real or spurious (from findings matching); verify kept it
// (survived) or refuted it.
import { cohenKappa } from "../../stats/index.ts";

export interface VerifyEntry {
  findingIdx: number;
  survived: boolean;
  /** Per skeptic: true = failed to refute (votes to keep). */
  votes?: boolean[];
}

export interface VerifyScore {
  n: number;
  /** (real kept + spurious refuted) / n. */
  refuteAccuracy: number;
  /** Real findings refuted / real findings entered. NaN with no real entries. */
  falseKillRate: number;
  /** Spurious findings kept / spurious findings entered. NaN with no spurious entries. */
  falseKeepRate: number;
  /** Cohen's κ of survived vs real. NaN when either side used one category only. */
  kappa: number;
  confusion: { realKept: number; realRefuted: number; spuriousKept: number; spuriousRefuted: number };
  /** Per skeptic index: share of votes that agree with truth. */
  perSkeptic: { skeptic: number; n: number; accuracy: number }[];
}

export function verifyConfusion(entered: VerifyEntry[], real: Set<number>): VerifyScore {
  const c = { realKept: 0, realRefuted: 0, spuriousKept: 0, spuriousRefuted: 0 };
  for (const e of entered) {
    const r = real.has(e.findingIdx);
    if (r && e.survived) c.realKept++;
    else if (r) c.realRefuted++;
    else if (e.survived) c.spuriousKept++;
    else c.spuriousRefuted++;
  }
  const n = entered.length;
  const reals = c.realKept + c.realRefuted;
  const spurious = c.spuriousKept + c.spuriousRefuted;
  const k = cohenKappa(
    entered.map((e) => (e.survived ? "keep" : "refute")),
    entered.map((e) => (real.has(e.findingIdx) ? "keep" : "refute")),
    ["keep", "refute"],
  );
  const perSkeptic: VerifyScore["perSkeptic"] = [];
  const width = Math.max(0, ...entered.map((e) => e.votes?.length ?? 0));
  for (let i = 0; i < width; i++) {
    let m = 0;
    let ok = 0;
    for (const e of entered) {
      const v = e.votes?.[i];
      if (typeof v !== "boolean") continue;
      m++;
      if (v === real.has(e.findingIdx)) ok++;
    }
    perSkeptic.push({ skeptic: i, n: m, accuracy: m ? ok / m : NaN });
  }
  return {
    n,
    refuteAccuracy: n ? (c.realKept + c.spuriousRefuted) / n : NaN,
    falseKillRate: reals ? c.realRefuted / reals : NaN,
    falseKeepRate: spurious ? c.spuriousKept / spurious : NaN,
    kappa: k.kappa,
    confusion: c,
    perSkeptic,
  };
}
