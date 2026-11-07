// coding.sh module graders for the eve weather agent.
//
// `ctx.output` is what eveTask returns ({reply, replies, toolCalls, subagents, ...}).
// `ctx.trace` is the session's events mapped to coding.sh kinds
// (tool.start/tool.end, subagent.start/end, llm.call, turn.end, ...), so these
// graders check how the agent got its answer, not just the text.

// A command task (scripts/ask.mjs) returns no trace; fall back to the calls it reports.
const ofKind = (trace, kind) => (trace ?? []).filter((e) => e.kind === kind);
const toolEnds = (ctx) =>
  ctx.trace?.length ? ofKind(ctx.trace, "tool.end").map((e) => e.payload ?? {}) : (ctx.output?.toolCalls ?? []).filter((c) => "ok" in c);
const subagentTypes = (ctx) =>
  ctx.trace?.length ? ofKind(ctx.trace, "subagent.start").map((e) => e.payload?.type) : (ctx.output?.subagents ?? []);
const subagentsOk = (ctx) =>
  ctx.trace?.length
    ? ofKind(ctx.trace, "subagent.end").every((e) => e.payload?.ok === true)
    : (ctx.output?.toolCalls ?? []).filter((c) => c.kind === "agent").every((c) => c.ok === true);

/** The last turn's reply contains expected.reply (case-insensitive). */
export function reply(ctx) {
  const want = String(ctx.expected?.reply ?? "").toLowerCase();
  const got = String(ctx.output?.reply ?? "");
  const pass = want !== "" && got.toLowerCase().includes(want);
  return { score: pass ? 1 : 0, pass, reason: pass ? undefined : `reply ${JSON.stringify(got)} lacks ${JSON.stringify(want)}` };
}

/** Each tool in expected.tools ran and ended ok (true) or failed (false). */
export function tools(ctx) {
  const ends = toolEnds(ctx);
  const misses = [];
  for (const [tool, ok] of Object.entries(ctx.expected?.tools ?? {})) {
    const calls = ends.filter((e) => e.tool === tool);
    if (!calls.length) misses.push(`${tool} never ran`);
    else if (!calls.some((e) => e.ok === ok)) misses.push(`${tool} ${ok ? "failed" : "did not fail"}`);
  }
  const total = Object.keys(ctx.expected?.tools ?? {}).length || 1;
  return { score: 1 - misses.length / total, pass: misses.length === 0, reason: misses.join("; ") || undefined };
}

/** The agent delegated to expected.subagent (or to nobody when it is null), and the subagent finished. */
export function delegation(ctx) {
  const want = ctx.expected?.subagent ?? null;
  const starts = subagentTypes(ctx);
  const ended = subagentsOk(ctx);
  const pass = want === null ? starts.length === 0 : starts.includes(want) && ended;
  return { score: pass ? 1 : 0, pass, reason: pass ? undefined : `subagents: ${JSON.stringify(starts)}, wanted ${JSON.stringify(want)}` };
}

/** Fewer model calls per turn scores higher; fails above options.maxModelCalls. Needs the trace. */
export function efficiency(ctx, options = {}) {
  if (!ctx.trace?.length) return { score: 1, pass: true, reason: "no trace (command task): not measured" };
  const max = options.maxModelCalls ?? 5;
  const turns = Math.max(1, ofKind(ctx.trace, "turn.end").length);
  const perTurn = ofKind(ctx.trace, "llm.call").length / turns;
  return { score: Math.max(0, Math.min(1, (max + 1 - perTurn) / max)), pass: perTurn <= max, reason: `${perTurn.toFixed(1)} model calls per turn` };
}
