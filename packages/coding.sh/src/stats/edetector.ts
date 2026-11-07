// Restart e-detector for iteration loops (X-17): when to stop a loop of
// candidate versions, and which earlier version to keep.
//
//   Yin, Liu, Qi, "When Is Enough Enough? Stopping Self-Improvement Loops
//   with E-Detectors", arXiv 2610.04756, Alg. 1 and App. B.
//   https://arxiv.org/abs/2610.04756
//
// Round t compares candidate θ_t with the incumbent θ_{t−1} on n shared items:
// X_{t,i} = c_{t,i} − b_{t,i} ∈ [−1, 1] (candidate minus incumbent; 1 = the
// candidate fixed item i). While the loop still helps, E[X] ≥ ε, the smallest
// gain per round worth paying for. Each round starts a new restart s = t, and
// every restart bets against "still helping":
//
//   W_t^(s) = ∏_{u=s..t} ∏_i [1 + λ_{s,u}(ε − X_{u,i})],   M_t = max_s W_t^(s).
//
// The alarm fires at M_t ≥ 1/δ. The change point is ν̂ = argmax_s W_t^(s), the
// first round of the plateau, and the loop should return θ_{ν̂−1}.
//
// Betting (λ_{s,u}):
// - "agrapa" (default): λ = clip(μ̂/(σ̂² + μ̂²), 0, 1/2) with μ̂ = ε − X̄ and
//   σ̂² = mean(X²) − X̄² over restart s's items before round u, and λ0 on its
//   first round. The paper leaves λ0 open; 0.2 is our choice. The moments are
//   per item, the GRAPA bet for the per-item product.
// - "mixture": fixed λ ∈ {0.1, 0.2, 0.4}, uniform weights; a restart's wealth
//   is the average of its three processes.
//
// Guarantee, stated honestly: each restart's wealth is a nonnegative
// supermartingale while E[X] ≥ ε, so by Ville's inequality it reaches 1/δ
// with probability ≤ δ, and the restarted max has average run length to a
// false alarm ≥ 1/δ (20 rounds at δ 0.05; Prop. 1). That is an average run
// length, not a familywise error rate: a loop that runs long enough on real
// gains still alarms eventually.
//
// Detectability floor (App. B): on a flat plateau (X = 0) a fixed λ gains
// n·log(1 + λε) per round, so the alarm needs ≥ log(1/δ)/(n·log(1 + λε))
// rounds. At n = 12 and ε = 0.01 that is 51 rounds: small evals can't see a
// small ε. See plateauRoundsNeeded.

export type EBet = "agrapa" | "mixture";

export interface EDetectorOpts {
  /** Smallest worthwhile gain per round, in (0, 1). Default 0.01. */
  eps?: number;
  /** Alarm at wealth ≥ 1/δ, δ in (0, 1). Default 0.05. */
  delta?: number;
  /** Default "agrapa". */
  bet?: EBet;
  /** aGRAPA's bet on a restart's first round, in (0, 1/2]. Default 0.2 (our choice; the paper leaves it open). */
  lambda0?: number;
  /** Mixture bets, each in (0, 1/2], uniform weights. Default [0.1, 0.2, 0.4]. */
  grid?: number[];
}

export interface EDetectorResult {
  /** Rounds counted (the alarm round once alarmed: later rounds are ignored). */
  rounds: number;
  alarm: boolean;
  /** Round where the alarm fired (1-based). */
  alarmRound?: number;
  /** ν̂: first round of the plateau (1-based), at the alarm. */
  changePoint?: number;
  /** ν̂ − 1: the version to keep, where 0 is the version before round 1. */
  returnIndex?: number;
  /** log M_t, the largest restart's log wealth (0 before any round). */
  logWealth: number;
  /** log(1/δ). */
  logThreshold: number;
  /** Restart that holds the largest wealth now (1-based), undefined before any round. */
  leader?: number;
  /** Rounds pushed after the alarm and ignored. */
  ignored: number;
  eps: number;
  delta: number;
  bet: EBet;
}

export interface EDetector {
  /** Add one round's paired diffs (candidate − incumbent per item, each in [−1, 1]). */
  push(diffs: readonly number[]): EDetectorResult;
  result(): EDetectorResult;
}

interface Restart {
  start: number;
  /** aGRAPA: one log wealth; mixture: one per grid bet. */
  logW: number[];
  n: number;
  sx: number;
  sx2: number;
}

const logMeanExp = (xs: readonly number[]) => {
  const m = Math.max(...xs);
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s / xs.length);
};

const inUnit = (x: number) => Number.isFinite(x) && x > 0 && x < 1;
const isBet = (x: number) => Number.isFinite(x) && x > 0 && x <= 0.5;

/** Incremental restart e-detector (Yin et al., arXiv 2610.04756, Alg. 1). Freezes at the alarm. */
export function createEDetector(opts: EDetectorOpts = {}): EDetector {
  const eps = opts.eps ?? 0.01;
  const delta = opts.delta ?? 0.05;
  const bet = opts.bet ?? "agrapa";
  const lambda0 = opts.lambda0 ?? 0.2;
  const grid = opts.grid ?? [0.1, 0.2, 0.4];
  if (!inUnit(eps)) throw new RangeError(`eps must be in (0, 1), got ${eps}`);
  if (!inUnit(delta)) throw new RangeError(`delta must be in (0, 1), got ${delta}`);
  if (bet !== "agrapa" && bet !== "mixture") throw new RangeError(`bet must be "agrapa" or "mixture", got ${String(bet)}`);
  if (!isBet(lambda0)) throw new RangeError(`lambda0 must be in (0, 0.5], got ${lambda0}`);
  if (!grid.length || !grid.every(isBet)) throw new RangeError(`grid bets must each be in (0, 0.5], got [${grid.join(", ")}]`);

  const logThreshold = Math.log(1 / delta);
  const restarts: Restart[] = [];
  let rounds = 0;
  let ignored = 0;
  let alarmRound: number | undefined;
  let changePoint: number | undefined;
  let logWealth = 0;
  let leader: number | undefined;

  const wealthOf = (r: Restart) => (bet === "agrapa" ? (r.logW[0] as number) : logMeanExp(r.logW));

  const result = (): EDetectorResult => {
    const out: EDetectorResult = { rounds, alarm: alarmRound !== undefined, logWealth, logThreshold, ignored, eps, delta, bet };
    if (leader !== undefined) out.leader = leader;
    if (alarmRound !== undefined && changePoint !== undefined) {
      out.alarmRound = alarmRound;
      out.changePoint = changePoint;
      out.returnIndex = changePoint - 1;
    }
    return out;
  };

  const push = (diffs: readonly number[]): EDetectorResult => {
    for (const x of diffs) if (!(Number.isFinite(x) && x >= -1 && x <= 1)) throw new RangeError(`paired diffs must lie in [-1, 1], got ${x}`);
    if (alarmRound !== undefined) {
      ignored++;
      return result();
    }
    rounds++;
    restarts.push({ start: rounds, logW: bet === "agrapa" ? [0] : grid.map(() => 0), n: 0, sx: 0, sx2: 0 });
    let roundSum = 0;
    let roundSq = 0;
    for (const x of diffs) {
      roundSum += x;
      roundSq += x * x;
    }
    for (const r of restarts) {
      if (bet === "agrapa") {
        let lambda = lambda0;
        if (r.n > 0) {
          const xbar = r.sx / r.n;
          const mu = eps - xbar;
          const den = r.sx2 / r.n - xbar * xbar + mu * mu;
          lambda = den > 0 ? Math.min(Math.max(mu, 0) / den, 0.5) : 0;
        }
        if (lambda > 0) for (const x of diffs) r.logW[0]! += Math.log1p(lambda * (eps - x));
      } else {
        grid.forEach((lambda, j) => {
          for (const x of diffs) r.logW[j]! += Math.log1p(lambda * (eps - x));
        });
      }
      r.n += diffs.length;
      r.sx += roundSum;
      r.sx2 += roundSq;
    }
    logWealth = -Infinity;
    for (const r of restarts) {
      const w = wealthOf(r);
      // Ties go to the earliest restart: the longest plateau explains the data as well.
      if (w > logWealth) {
        logWealth = w;
        leader = r.start;
      }
    }
    if (logWealth >= logThreshold) {
      alarmRound = rounds;
      changePoint = leader;
    }
    return result();
  };

  return { push, result };
}

/** Batch form of createEDetector: feed every round, stop counting at the alarm. */
export function eDetector(rounds: readonly (readonly number[])[], opts: EDetectorOpts = {}): EDetectorResult {
  const d = createEDetector(opts);
  for (const r of rounds) d.push(r);
  return d.result();
}

/**
 * Fewest flat-plateau rounds (X = 0 on all n items) before a fixed-λ bettor can
 * alarm: ⌈log(1/δ) / (n·log(1 + λε))⌉ (arXiv 2610.04756, App. B). aGRAPA's
 * bet tops out at λ = 1/2, so the default is its floor. A loop that will run
 * fewer rounds than this can't detect a plateau at this ε.
 */
export function plateauRoundsNeeded(n: number, eps: number, delta = 0.05, lambda = 0.5): number {
  if (!(Number.isInteger(n) && n >= 1)) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (!inUnit(eps)) throw new RangeError(`eps must be in (0, 1), got ${eps}`);
  if (!inUnit(delta)) throw new RangeError(`delta must be in (0, 1), got ${delta}`);
  if (!isBet(lambda)) throw new RangeError(`lambda must be in (0, 0.5], got ${lambda}`);
  return Math.ceil(Math.log(1 / delta) / (n * Math.log1p(lambda * eps)));
}
