// Item difficulty (EM-12): a 1PL (Rasch) or 2PL item response model over stored
// per-case outcomes across configs, and informative case selection.
//
//   P(config j passes case i) = σ(a_i · (θ_j − b_i))
//
// θ_j is a config's ability, b_i a case's difficulty, a_i its discrimination (1
// in the Rasch model). The fit is joint maximum a posteriori (JML with Gaussian
// priors, so a case every config passed or failed gets a finite difficulty
// instead of ±∞): alternating one-step Newton updates on θ, b and log a until the
// largest change is below `tol`. A case's Fisher information at ability θ is
// a² · P · (1 − P): it peaks where the case is passed half the time and grows
// with discrimination, so the most informative cases sit at mid difficulty for
// the configs being compared and separate them sharply.
//
// Sources: tinyBenchmarks (Polo et al., ICML 2024, arXiv 2402.14992), metabench
// (Kipnis et al., ICLR 2025, arXiv 2407.12844), Fluid Benchmarking (Hofmann et
// al., COLM 2025, arXiv 2509.11106). Counterweight: Madaan et al. 2024 (arXiv
// 2406.10229) found IRT subsets barely reduce rerun noise, so selection here
// ranks cases; it does not replace running them.

/** Outcomes of one config on one case: `pass` of `n` trials (n defaults to 1). */
export interface IrtResponse {
  subject: string;
  item: string;
  pass: number;
  n?: number;
}

export type IrtModel = "1pl" | "2pl";

export interface IrtOpts {
  model?: IrtModel;
  maxIter?: number;
  tol?: number;
  /** Prior sd of abilities (default 1: sets the scale). */
  abilitySd?: number;
  /** Prior sd of difficulties (default 3: weak). */
  difficultySd?: number;
  /** Prior sd of log discrimination, 2PL only (default 0.5). */
  logDiscriminationSd?: number;
}

export interface IrtItem {
  id: string;
  difficulty: number;
  /** 1 under the 1PL model. */
  discrimination: number;
  /** Trials seen. */
  n: number;
  passRate: number;
  /** Configs that ran it. */
  subjects: number;
}

export interface IrtSubject {
  id: string;
  ability: number;
  n: number;
}

export interface IrtFit {
  model: IrtModel;
  items: IrtItem[];
  subjects: IrtSubject[];
  iterations: number;
  converged: boolean;
  logLik: number;
}

const sigmoid = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
const logit = (p: number) => Math.log(p / (1 - p));
const clip = (p: number) => Math.min(0.95, Math.max(0.05, p));

/** Fit a 1PL or 2PL model by joint MAP. Deterministic: no randomness. */
export function fitIrt(responses: readonly IrtResponse[], opts: IrtOpts = {}): IrtFit {
  const model = opts.model ?? "1pl";
  const maxIter = opts.maxIter ?? 500;
  const tol = opts.tol ?? 1e-6;
  const vt = 1 / (opts.abilitySd ?? 1) ** 2;
  const vb = 1 / (opts.difficultySd ?? 3) ** 2;
  const va = 1 / (opts.logDiscriminationSd ?? 0.5) ** 2;
  // Aggregate repeated (subject, item) responses.
  const sIdx = new Map<string, number>();
  const iIdx = new Map<string, number>();
  const cell = new Map<string, { s: number; i: number; y: number; m: number }>();
  for (const r of responses) {
    const n = r.n ?? 1;
    if (!(n > 0) || !(r.pass >= 0) || r.pass > n) throw new RangeError(`fitIrt: need 0 ≤ pass ≤ n and n > 0 (got pass=${r.pass}, n=${n} for ${r.subject}/${r.item})`);
    let s = sIdx.get(r.subject);
    if (s === undefined) sIdx.set(r.subject, (s = sIdx.size));
    let i = iIdx.get(r.item);
    if (i === undefined) iIdx.set(r.item, (i = iIdx.size));
    const k = `${s}:${i}`;
    const c = cell.get(k);
    if (c) {
      c.y += r.pass;
      c.m += n;
    } else cell.set(k, { s, i, y: r.pass, m: n });
  }
  const cells = [...cell.values()];
  const S = sIdx.size;
  const I = iIdx.size;
  const theta = new Float64Array(S);
  const b = new Float64Array(I);
  const la = new Float64Array(I); // log discrimination
  const bySubj: number[][] = Array.from({ length: S }, () => []);
  const byItem: number[][] = Array.from({ length: I }, () => []);
  cells.forEach((c, k) => {
    bySubj[c.s]!.push(k);
    byItem[c.i]!.push(k);
  });
  const rate = (ks: number[]) => {
    let y = 0;
    let m = 0;
    for (const k of ks) {
      y += cells[k]!.y;
      m += cells[k]!.m;
    }
    return { y, m };
  };
  for (let s = 0; s < S; s++) {
    const { y, m } = rate(bySubj[s]!);
    theta[s] = logit(clip(y / m));
  }
  for (let i = 0; i < I; i++) {
    const { y, m } = rate(byItem[i]!);
    b[i] = -logit(clip(y / m));
  }
  const step = (g: number, h: number) => Math.max(-1, Math.min(1, -g / h));
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter && !converged; iterations++) {
    let maxD = 0;
    for (let s = 0; s < S; s++) {
      let g = -theta[s]! * vt;
      let h = -vt;
      for (const k of bySubj[s]!) {
        const c = cells[k]!;
        const a = Math.exp(la[c.i]!);
        const p = sigmoid(a * (theta[s]! - b[c.i]!));
        g += a * (c.y - c.m * p);
        h -= a * a * c.m * p * (1 - p);
      }
      const d = step(g, h);
      theta[s]! += d;
      maxD = Math.max(maxD, Math.abs(d));
    }
    for (let i = 0; i < I; i++) {
      const a = Math.exp(la[i]!);
      let g = -b[i]! * vb;
      let h = -vb;
      for (const k of byItem[i]!) {
        const c = cells[k]!;
        const p = sigmoid(a * (theta[c.s]! - b[i]!));
        g -= a * (c.y - c.m * p);
        h -= a * a * c.m * p * (1 - p);
      }
      const d = step(g, h);
      b[i]! += d;
      maxD = Math.max(maxD, Math.abs(d));
    }
    if (model === "2pl") {
      for (let i = 0; i < I; i++) {
        const a = Math.exp(la[i]!);
        let g = -la[i]! * va;
        let h = -va;
        for (const k of byItem[i]!) {
          const c = cells[k]!;
          const x = theta[c.s]! - b[i]!;
          const p = sigmoid(a * x);
          g += a * x * (c.y - c.m * p);
          h -= a * a * x * x * c.m * p * (1 - p);
        }
        const d = step(g, h);
        la[i]! += d;
        maxD = Math.max(maxD, Math.abs(d));
      }
    }
    if (maxD < tol) converged = true;
  }
  let logLik = 0;
  for (const c of cells) {
    const p = sigmoid(Math.exp(la[c.i]!) * (theta[c.s]! - b[c.i]!));
    logLik += c.y * Math.log(Math.max(p, 1e-300)) + (c.m - c.y) * Math.log(Math.max(1 - p, 1e-300));
  }
  const items: IrtItem[] = [...iIdx].map(([id, i]) => {
    const { y, m } = rate(byItem[i]!);
    return { id, difficulty: b[i]!, discrimination: Math.exp(la[i]!), n: m, passRate: y / m, subjects: byItem[i]!.length };
  });
  const subjects: IrtSubject[] = [...sIdx].map(([id, s]) => ({ id, ability: theta[s]!, n: rate(bySubj[s]!).m }));
  return { model, items, subjects, iterations, converged, logLik };
}

/** P(pass) at ability θ. */
export function irtProbability(item: Pick<IrtItem, "difficulty" | "discrimination">, theta: number): number {
  return sigmoid(item.discrimination * (theta - item.difficulty));
}

/** Fisher information a² · P · (1 − P) of a case at ability θ. */
export function itemInformation(item: Pick<IrtItem, "difficulty" | "discrimination">, theta: number): number {
  const p = irtProbability(item, theta);
  return item.discrimination * item.discrimination * p * (1 - p);
}

export interface InformativeItem extends IrtItem {
  /** Mean Fisher information over the target abilities. */
  information: number;
  /** Every config passed it or every config failed it: it separates nothing. */
  dead: boolean;
}

/**
 * Cases ranked by mean Fisher information over the target abilities (default:
 * every fitted config's ability), most informative first; dead cases (all pass
 * or all fail) go last. Ties break by case id. `k` keeps the first k.
 */
export function informativeItems(fit: IrtFit, o: { k?: number; abilities?: readonly number[] } = {}): InformativeItem[] {
  const at = o.abilities?.length ? o.abilities : fit.subjects.map((s) => s.ability);
  const ranked = fit.items
    .map((it) => ({
      ...it,
      information: at.length ? at.reduce((s, t) => s + itemInformation(it, t), 0) / at.length : 0,
      dead: it.passRate === 0 || it.passRate === 1,
    }))
    .sort((x, y) => Number(x.dead) - Number(y.dead) || y.information - x.information || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return o.k === undefined ? ranked : ranked.slice(0, o.k);
}

/**
 * Responses from stored runs: one per (config, task) with passes over counted
 * runs (cancelled, superseded and infra-failed runs are left out).
 */
export function irtResponsesFromRuns(runs: readonly { taskId: string; bundleId: string; pass: boolean; cancelled?: true; superseded?: true; infra?: string }[]): IrtResponse[] {
  const acc = new Map<string, IrtResponse & { n: number }>();
  for (const r of runs) {
    if (r.cancelled || r.superseded || r.infra) continue;
    const k = `${r.bundleId}\u0000${r.taskId}`;
    const a = acc.get(k) ?? { subject: r.bundleId, item: r.taskId, pass: 0, n: 0 };
    a.n++;
    if (r.pass) a.pass++;
    acc.set(k, a);
  }
  return [...acc.values()];
}

/** Pearson correlation of two equal-length series; NaN without spread. */
export function correlation(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 2 || y.length !== n) return NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** What `irtOrderTasks` adds to a task it could fit. */
export interface IrtTaskFields {
  difficulty?: number;
  discrimination?: number;
  information?: number;
}

export interface IrtTaskOrder<T> {
  tasks: (T & IrtTaskFields)[];
  /** False when fewer than `minConfigs` configs ran: the input order is kept. */
  fitted: boolean;
  model?: IrtModel;
  configs: number;
  note: string;
}

/**
 * Order tasks for informative case selection: fit an item response model on
 * stored runs (1PL; 2PL from `twoPlFrom` configs, default 20) and rank by Fisher
 * information at the target config's ability (default: every config's): mid
 * difficulty and sharp discrimination first, then tasks no config ran, then
 * tasks every config passed or failed. Fewer than `minConfigs` configs (default
 * 3) keeps the input order. Ties keep the input order.
 */
export function irtOrderTasks<T extends { taskId: string }>(
  tasks: readonly T[],
  runs: Parameters<typeof irtResponsesFromRuns>[0],
  o: { target?: string; minConfigs?: number; twoPlFrom?: number } = {},
): IrtTaskOrder<T> {
  const ids = new Set(tasks.map((t) => t.taskId));
  const responses = irtResponsesFromRuns(runs).filter((r) => ids.has(r.item));
  const configs = new Set(responses.map((r) => r.subject)).size;
  const min = o.minConfigs ?? 3;
  if (configs < min) return { tasks: [...tasks], fitted: false, configs, note: `--pick-by irt needs stored runs from ${min} or more configs (found ${configs}), so tasks are ranked by separation` };
  const model: IrtModel = configs >= (o.twoPlFrom ?? 20) ? "2pl" : "1pl";
  const fit = fitIrt(responses, { model });
  const target = o.target === undefined ? undefined : fit.subjects.find((s) => s.id === o.target);
  const order = new Map(informativeItems(fit, target ? { abilities: [target.ability] } : {}).map((x, i) => [x.id, { x, i }]));
  const group = (t: T) => {
    const e = order.get(t.taskId);
    return e ? (e.x.dead ? 2 : 0) : 1;
  };
  const out = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => group(a.t) - group(b.t) || (order.get(a.t.taskId)?.i ?? 0) - (order.get(b.t.taskId)?.i ?? 0) || a.i - b.i)
    .map(({ t }): T & IrtTaskFields => {
      const e = order.get(t.taskId)?.x;
      return e ? { ...t, difficulty: e.difficulty, discrimination: e.discrimination, information: e.information } : t;
    });
  return { tasks: out, fitted: true, model, configs, note: `ranked by ${model.toUpperCase()} item information at ${target ? "the baseline's" : "the stored configs'"} ability (${configs} configs)` };
}
