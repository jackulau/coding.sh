// Minimal in-memory IndexStore / BlobStore for viewer tests. Kept local so the
// viewer tests don't depend on the store builder's implementation.
import { createHash } from "node:crypto";
import { buildSession } from "../../src/core/sessions.ts";
import type {
  AgentEvent,
  BlobRef,
  BlobStore,
  EvalTask,
  HarnessBundle,
  IndexStore,
  Label,
  RunResult,
  SearchHit,
  Session,
  SessionFilter,
} from "../../src/core/types.ts";

export class FakeIndex implements IndexStore {
  // Scans events like the in-memory store, so `where` event keys and text work against it.
  readonly kind = "memory";
  sessions = new Map<string, Session>();
  events = new Map<string, AgentEvent>();
  tasks = new Map<string, EvalTask>();
  bundles = new Map<string, HarnessBundle>();
  runs = new Map<string, RunResult>();
  labels = new Map<string, Label>();
  cursors = new Map<string, number>();

  async migrate() {}
  async close() {}
  async putEvents(batch: AgentEvent[]) {
    let inserted = 0;
    for (const e of batch) {
      if (!this.events.has(e.id)) inserted++;
      this.events.set(e.id, e);
    }
    return { inserted };
  }
  async upsertSession(s: Session) {
    this.sessions.set(s.id, s);
  }
  async getSession(id: string) {
    return this.sessions.get(id);
  }
  async listSessions(f: SessionFilter = {}) {
    let rows = [...this.sessions.values()]
      .filter((s) => !f.agent || s.agent === f.agent)
      .filter((s) => !f.repoRoot || s.repo?.root === f.repoRoot)
      .filter((s) => !f.flag || s.flags.includes(f.flag))
      .filter((s) => f.runId === undefined || (f.runId === null ? !s.runId : s.runId === f.runId))
      .filter((s) => f.parentSessionId === undefined || (f.parentSessionId === null ? !s.parent : s.parent?.sessionId === f.parentSessionId))
      .filter((s) => (f.since === undefined || s.startedAt >= f.since) && (f.until === undefined || s.startedAt < f.until))
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const off = f.offset ?? 0;
    rows = rows.slice(off, f.limit === undefined ? undefined : off + f.limit);
    return rows;
  }
  async listEvents(sessionId: string, opts: { kinds?: string[]; limit?: number; offset?: number } = {}) {
    const off = opts.offset ?? 0;
    return [...this.events.values()]
      .filter((e) => e.sessionId === sessionId && (!opts.kinds || opts.kinds.includes(e.kind)))
      .sort((a, b) => a.ts - b.ts)
      .slice(off, opts.limit === undefined ? undefined : off + opts.limit);
  }
  async search(text: string, opts: { limit?: number; agent?: string } = {}): Promise<SearchHit[]> {
    const t = text.toLowerCase();
    const hits: SearchHit[] = [];
    for (const e of this.events.values()) {
      const s = typeof e.payload.text === "string" ? e.payload.text : "";
      if (s.toLowerCase().includes(t) && (!opts.agent || e.agent === opts.agent)) {
        // Like the real store, the snippet wraps the match in «».
        const at = s.toLowerCase().indexOf(t);
        hits.push({ event: e, snippet: (s.slice(0, at) + "«" + s.slice(at, at + t.length) + "»" + s.slice(at + t.length)).slice(0, 122) });
      }
    }
    return hits.slice(0, opts.limit ?? 50);
  }
  async getCursor(source: string) {
    return this.cursors.get(source) ?? 0;
  }
  async setCursor(source: string, offset: number) {
    this.cursors.set(source, offset);
  }
  async putTask(t: EvalTask) {
    this.tasks.set(t.id, t);
  }
  async getTask(id: string) {
    return this.tasks.get(id);
  }
  async listTasks(opts: { status?: EvalTask["status"]; tag?: string } = {}) {
    return [...this.tasks.values()].filter(
      (t) => (!opts.status || t.status === opts.status) && (!opts.tag || t.tags.includes(opts.tag)),
    );
  }
  async putBundle(b: HarnessBundle) {
    this.bundles.set(b.id, b);
  }
  async getBundle(idOrName: string) {
    return this.bundles.get(idOrName) ?? [...this.bundles.values()].find((b) => b.name === idOrName);
  }
  async listBundles() {
    return [...this.bundles.values()];
  }
  async putRun(r: RunResult) {
    this.runs.set(r.id, r);
  }
  async listRuns(f: { taskId?: string; bundleId?: string; experimentId?: string } = {}) {
    return [...this.runs.values()].filter(
      (r) =>
        (!f.taskId || r.taskId === f.taskId) &&
        (!f.bundleId || r.bundleId === f.bundleId) &&
        (!f.experimentId || r.experimentId === f.experimentId),
    );
  }
  async putLabel(l: Label) {
    this.labels.set(l.id, l);
  }
  async listLabels(f: { sessionId?: string; criterion?: string } = {}) {
    return [...this.labels.values()].filter(
      (l) => (!f.sessionId || l.sessionId === f.sessionId) && (!f.criterion || l.criterion === f.criterion),
    );
  }
  async *referencedBlobs(): AsyncIterable<BlobRef> {
    for (const e of this.events.values()) yield* e.blobs ?? [];
  }
}

export class FakeBlobs implements BlobStore {
  readonly kind = "fake";
  data = new Map<string, Uint8Array>();
  async put(d: Uint8Array | string) {
    const bytes = typeof d === "string" ? new TextEncoder().encode(d) : d;
    const ref = createHash("sha256").update(bytes).digest("hex");
    this.data.set(ref, bytes);
    return ref;
  }
  async get(ref: BlobRef) {
    return this.data.get(ref);
  }
  async getText(ref: BlobRef) {
    const d = this.data.get(ref);
    return d && new TextDecoder().decode(d);
  }
  async has(refs: BlobRef[]) {
    return refs.map((r) => this.data.has(r));
  }
  async *list() {
    yield* this.data.keys();
  }
  async delete(ref: BlobRef) {
    this.data.delete(ref);
  }
}

export function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent: "claude-code",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_080_000,
    title: `Session ${id}`,
    repo: { root: "/work/api", head: "a41c9e2b00" },
    stats: { events: 3, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 1 },
    flags: [],
    ...over,
  };
}

export function event(sessionId: string, n: number, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `${sessionId}-e${n}`,
    v: 0,
    sessionId,
    ts: 1_700_000_000_000 + n * 1000,
    agent: "claude-code",
    kind: "user.message",
    payload: { text: `prompt ${n}` },
    ...over,
  };
}

/** A finished dataset experiment, as `coding.sh exp run` stores it. */
export function experimentResult(id: string, over: Partial<import("../../src/datasets/types.ts").ExperimentResult> = {}): import("../../src/datasets/types.ts").ExperimentResult {
  const runs = [
    { caseId: "c1", trial: 1, output: "4", latencyMs: 120, grades: [{ graderId: "exact", result: { score: 1, pass: true } }], pass: true, startedAt: 1_762_400_000_000 },
    { caseId: "c2", trial: 1, output: "five", latencyMs: 340, grades: [{ graderId: "exact", result: { score: 0, pass: false, reason: "expected 5" } }], pass: false, startedAt: 1_762_400_000_100 },
  ];
  return {
    id,
    name: "prod-smoke",
    dataset: { id: "qa", name: "QA", version: "v1abcdef" },
    // Long, like a real command task's absolute path: it must truncate, not widen a phone screen.
    task: { kind: "command", ref: "node /root/coding-sh-prod-exp/examples/production/mock-llm/answer.mjs --model gpt-4o --temperature 0" },
    graders: [{ id: "exact", version: "g1", kind: "exact" }],
    trials: 1,
    createdAt: 1_762_400_000_000,
    finishedAt: 1_762_400_001_000,
    runs,
    summary: {
      n: 2, cases: 2, passed: 1, errors: 0,
      passRate: { p: 0.5, lo: 0.09, hi: 0.91 },
      ciMethod: "wilson",
      graders: [{ id: "exact", kind: "exact", n: 2, passed: 1, errors: 0, meanScore: 0.5, passRate: { p: 0.5, lo: 0.09, hi: 0.91 } }],
      latencyMs: { mean: 230, median: 230, p90: 340, max: 340 },
    },
    ...over,
  };
}

/**
 * Sessions and model calls covering each cost mark: estimated from list prices
 * (one call priced as a sibling model), reported, partly estimated, and unpriced.
 */
export function costFixtures(t0: number): { sessions: Session[]; events: AgentEvent[] } {
  const EST = "cost-est";
  const sessions = [
    session(EST, {
      startedAt: t0, endedAt: t0 + 240_000, model: "claude-sonnet-4-7", title: "Price the session list from list prices",
      stats: {
        events: 4, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, latency: { llmCalls: 3 },
        usage: { inputTokens: 40_000, cacheReadTokens: 210_000, outputTokens: 6_200, costUsd: 0.4231, estimatedCostUsd: 0.4231 },
        duplicateUsage: { calls: 1, tokens: 12_000, costUsd: 0.05 },
      },
    }),
    session("cost-billed", {
      agent: "vercel-ai-sdk", startedAt: t0 - 60_000, endedAt: t0 - 50_000, model: "gpt-6.1-sol", title: "POST /api/summarize", repo: undefined,
      stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, latency: { llmCalls: 1 }, usage: { inputTokens: 9_000, outputTokens: 900, costUsd: 1.1 } },
    }),
    session("cost-mixed", {
      startedAt: t0 - 120_000, endedAt: t0 - 90_000, model: "claude-opus-5-5", title: "Mixed reported and estimated cost",
      stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 5_000, outputTokens: 500, costUsd: 0.3, estimatedCostUsd: 0.1 } },
    }),
    session("cost-none", {
      startedAt: t0 - 180_000, endedAt: t0 - 170_000, model: "kimi-k3", title: "Unpriced model",
      stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 3_000, outputTokens: 300 } },
    }),
  ];
  const e = (n: number, over: Partial<AgentEvent>): AgentEvent => ({ ...event(EST, n), ts: t0 + n * 1000, ...over });
  const events = [
    e(1, { kind: "user.message", payload: { text: "price the list" } }),
    e(2, {
      kind: "llm.call", model: "claude-sonnet-4-7", durationMs: 2100, usage: { inputTokens: 20_000, outputTokens: 3_000, costUsd: 0.0312 },
      payload: { ok: true, responseModel: "claude-sonnet-4-7", costEstimated: true, pricedAs: "claude-sonnet-4-5" },
    }),
    e(3, { kind: "llm.call", model: "gpt-6.1-sol", durationMs: 1500, usage: { inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.02 }, payload: { ok: true, responseModel: "gpt-6.1-sol" } }),
    e(4, { kind: "llm.call", model: "kimi-k3", durationMs: 900, usage: { inputTokens: 3_000, outputTokens: 300 }, payload: { ok: true, responseModel: "kimi-k3" } }),
  ];
  return { sessions, events };
}

/**
 * API (SDK) sessions as ingest builds them: one whose second request was
 * rate-limited (429), and one whose requests all succeeded.
 */
export function failedRequestFixtures(t0: number): { sessions: Session[]; events: AgentEvent[] } {
  const call = (sessionId: string, n: number, payload: Record<string, unknown>): AgentEvent => ({
    ...event(sessionId, n), agent: "openai-agents", source: "sdk", ts: t0 + n * 1000, kind: "llm.call", model: "gpt-5-mini", durationMs: 800,
    usage: { inputTokens: 1_200, outputTokens: 80 }, payload: { responseModel: "gpt-5-mini", ...payload },
  });
  const failed = [
    call("api-429", 1, { ok: true, statusCode: 200 }),
    call("api-429", 2, { ok: false, statusCode: 429, error: "429 Rate limit reached for gpt-5-mini on tokens per min" }),
    call("api-429", 3, { ok: true, statusCode: 200 }),
  ];
  const fine = [call("api-ok", 4, { ok: true, statusCode: 200 }), call("api-ok", 5, { ok: true, statusCode: 200 })];
  return {
    sessions: [
      { ...buildSession(failed), title: "POST /api/triage (rate limited)" },
      { ...buildSession(fine), title: "POST /api/triage" },
    ],
    events: [...failed, ...fine],
  };
}

/** For metrics: twelve sessions over ten days from t0 (a Wednesday by default): three agents, five models, two repos, failure flags and tags, priced and unpriced, two subagents. */
export function metricFixtures(t0 = Date.UTC(2026, 9, 7)): Session[] {
  const DAY_MS = 86_400_000;
  const H = 3_600_000;
  const T0 = t0;
  const s = (id: string, day: number, hour: number, over: Omit<Partial<Session>, "stats"> & { stats?: Partial<Session["stats"]> } = {}): Session =>
    session(id, {
      ...over,
      startedAt: T0 + day * DAY_MS + hour * H,
      endedAt: T0 + day * DAY_MS + hour * H + 600_000,
      stats: { events: 10, turns: 1, toolCalls: 4, toolErrors: 0, filesChanged: 1, ...over.stats },
      flags: over.flags ?? [],
    });
  return [
    s("m01", 0, 9, { model: "claude-opus-5-5", stats: { toolCalls: 12, toolErrors: 2, usage: { inputTokens: 40_000, outputTokens: 3_000, cacheReadTokens: 200_000, costUsd: 1.25, estimatedCostUsd: 1.25 }, latency: { llmCalls: 14, llmP95Ms: 9_000, ttftP50Ms: 1_100 } }, flags: ["no-verification"] }),
    s("m02", 0, 15, { agent: "codex", model: "gpt-6.1-sol", repo: { root: "/work/demo", head: "" }, stats: { toolCalls: 30, toolErrors: 1, usage: { inputTokens: 90_000, outputTokens: 6_000, costUsd: 0.4 }, latency: { llmCalls: 22, llmP95Ms: 14_000, ttftP50Ms: 900 } }, flags: ["compaction", "skill:pdf"] }),
    s("m03", 1, 10, { model: "claude-sonnet-5", stats: { usage: { inputTokens: 5_000, outputTokens: 400 }, latency: { llmCalls: 3, llmP95Ms: 3_000 } } }),
    s("m04", 1, 11, { model: "claude-sonnet-5", parent: { sessionId: "m03", type: "Explore" }, stats: { toolCalls: 6, usage: { inputTokens: 2_000, outputTokens: 100, costUsd: 0.01, estimatedCostUsd: 0.01 } } }),
    s("m05", 2, 8, { agent: "cursor", model: "gpt-6.1-sol", repo: undefined, cwd: "/home/user/notes", stats: { toolCalls: 0, latency: { llmCalls: 1, llmP95Ms: 1_200, ttftP50Ms: 300 } }, flags: ["premature-completion"] }),
    s("m06", 3, 23, { agent: "codex", model: "gpt-6.1-sol", repo: { root: "/work/demo", head: "" }, stats: { toolCalls: 50, toolErrors: 9, usage: { inputTokens: 300_000, outputTokens: 12_000, cacheReadTokens: 1_000_000, costUsd: 2.5 }, latency: { llmCalls: 60, llmP95Ms: 30_000, ttftP50Ms: 2_000 }, llmErrors: { count: 2 } }, flags: ["repeated-tool-failure", "compaction"] }),
    s("m07", 5, 12, { model: "claude-opus-5-5", stats: { usage: { inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.3333333333, estimatedCostUsd: 0.3333333333 } }, flags: ["model:switch"] }),
    s("m08", 5, 12, { model: "claude-opus-5-5", parent: { sessionId: "m07", type: "general-purpose" }, stats: { toolCalls: 2, usage: { inputTokens: 1_000, outputTokens: 50, costUsd: 0.1111111111, estimatedCostUsd: 0.1111111111 } } }),
    s("m09", 6, 1, { agent: "codex", model: "gpt-6.1-mini", repo: { root: "/work/demo", head: "" }, stats: { toolCalls: 8, usage: { inputTokens: 20_000, outputTokens: 900, costUsd: 0.05 }, latency: { llmCalls: 9, llmP95Ms: 4_000, ttftP50Ms: 500 } } }),
    s("m10", 8, 18, { model: "kimi-k3", stats: { usage: { inputTokens: 7_000, outputTokens: 700 } }, flags: ["no-verification"] }),
    s("m11", 9, 2, { agent: "cursor", model: undefined, repo: undefined, stats: { toolCalls: 1, toolErrors: 1 } }),
    s("m12", 9, 20, { model: "claude-opus-5-5", stats: { toolCalls: 40, toolErrors: 3, usage: { inputTokens: 80_000, outputTokens: 5_000, costUsd: 0.75 }, latency: { llmCalls: 30, llmP95Ms: 12_000, ttftP50Ms: 1_500 } }, flags: ["no-verification", "skill:pdf"] }),
  ];
}

/** A long session: `turns` prompts, each with model calls and tool calls, some failing, a compaction now and then. */
export function longSession(total: number, turns: number, seed = 7): AgentEvent[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: AgentEvent[] = [];
  const t0 = Date.UTC(2026, 10, 1);
  const per = Math.floor(total / turns);
  const base = { v: 0, sessionId: "long-1", agent: "claude-code" } as const;
  let k = 0;
  const push = (kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}) => {
    out.push({ ...base, id: `e${String(k).padStart(7, "0")}`, ts: t0 + k * 1000, kind, payload, ...extra } as AgentEvent);
    k++;
  };
  push("session.start", {});
  for (let t = 0; t < turns && k < total; t++) {
    const turnId = `t${t}`;
    push("user.message", { text: `prompt ${t}: fix the thing` }, { turnId });
    const stop = Math.min(total - 1, k + per - 1);
    let tool = 0;
    while (k < stop - 2) {
      const r = rnd();
      if (r < 0.0002) push("context.compact", { trigger: "auto" }, { turnId });
      else if (r < 0.2) push("llm.call", { ok: true, requestModel: "claude-opus-5-5" }, { turnId });
      else {
        const id = `tu${t}-${tool++}`;
        push("tool.start", { tool: "Bash", toolUseId: id, input: { command: "npm test" } }, { turnId });
        push("tool.end", { tool: "Bash", toolUseId: id, ok: rnd() > 0.01, output: "ok" }, { turnId });
      }
    }
    push("assistant.message", { text: "done" }, { turnId });
    push("turn.end", {}, { turnId });
  }
  while (k < total) push("notification", { text: "idle" });
  return out;
}
