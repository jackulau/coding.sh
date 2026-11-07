// Experiments for the Experiments tab of the landing-page viewer. The first one
// is the same A/B as the "Know if it helped" band (src/data/compare.ts), so the
// numbers agree across the page. Stats are computed at build time.
import { TASKS, ARMS, computeStats, taskPasses, type TaskRow } from "./compare";

export interface Experiment {
  id: string;
  title: string;
  bench: string;
  agent: string;
  ago: string;
  arms: { base: string; cand: string };
  /** Mean cost per run and p95 wall time per arm. */
  cost: { base: number; cand: number };
  p95s: { base: number; cand: number };
  tasks: TaskRow[];
}

export const EXPERIMENTS: Experiment[] = [
  {
    id: "exp_7c21",
    title: "Test-feedback hook + trimmed CLAUDE.md",
    bench: "my-failures",
    agent: "claude-code",
    ago: "12m ago",
    arms: { base: ARMS.base.sub, cand: ARMS.cand.sub },
    cost: { base: 0.077, cand: 0.071 },
    p95s: { base: 41, cand: 38 },
    tasks: TASKS,
  },
  {
    id: "exp_51ad",
    title: "claude-opus-5-5 vs claude-sonnet-5-5",
    bench: "orders-api",
    agent: "claude-code",
    ago: "2h ago",
    arms: { base: "claude-sonnet-5-5", cand: "claude-opus-5-5" },
    cost: { base: 0.064, cand: 0.192 },
    p95s: { base: 37, cand: 52 },
    tasks: [
      { task: "paginate-orders-api", base: "101", cand: "111", note: "candidate read the API contract before editing" },
      { task: "add-rate-limit", base: "111", cand: "111" },
      { task: "cache-invalidation", base: "011", cand: "111" },
      { task: "webhook-signature", base: "111", cand: "110", note: "first divergence at step 3: candidate rewrote the verifier instead of patching it" },
      { task: "retry-idempotency", base: "010", cand: "011" },
      { task: "handle-empty-cart", base: "111", cand: "111" },
      { task: "fix-n-plus-one", base: "001", cand: "011" },
      { task: "csv-export", base: "111", cand: "111" },
    ],
  },
  {
    id: "exp_0e9f",
    title: "Disable the search MCP server",
    bench: "support-triage",
    agent: "codex",
    ago: "1d ago",
    arms: { base: "mcp: search on", cand: "mcp: search off" },
    cost: { base: 0.021, cand: 0.018 },
    p95s: { base: 14, cand: 19 },
    tasks: [
      { task: "refund-policy", base: "1111", cand: "0100", note: "first divergence at step 2: without search the agent guessed the policy text" },
      { task: "shipping-delay", base: "1111", cand: "1011" },
      { task: "account-merge", base: "1101", cand: "0001", note: "first divergence at step 4: candidate never found the merge runbook" },
      { task: "password-reset", base: "1111", cand: "1111" },
      { task: "invoice-copy", base: "1110", cand: "1010" },
      { task: "plan-downgrade", base: "1111", cand: "1111" },
      { task: "gdpr-export", base: "0111", cand: "0011" },
      { task: "cancel-order", base: "1111", cand: "1110" },
      { task: "address-change", base: "1111", cand: "1111" },
      { task: "duplicate-charge", base: "1101", cand: "0101" },
    ],
  },
];

export type Verdict = "better" | "worse" | "inconclusive";

export function summarize(e: Experiment, seed: number) {
  const st = computeStats(e.tasks, seed);
  const [lo, hi] = st.diffCI;
  const verdict: Verdict = lo > 0 ? "better" : hi < 0 ? "worse" : "inconclusive";
  const costDelta = Math.round(((e.cost.cand - e.cost.base) / e.cost.base) * 100);
  const rows = e.tasks
    .map((t) => ({ ...t, delta: taskPasses(t.cand) - taskPasses(t.base) }))
    // Regressions first, then improvements, then unchanged.
    .sort((a, b) => (a.delta < 0 ? -1 : 0) - (b.delta < 0 ? -1 : 0) || Math.abs(b.delta) - Math.abs(a.delta) || b.delta - a.delta);
  return { st, verdict, costDelta, rows };
}
