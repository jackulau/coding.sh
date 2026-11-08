// coding.sh diff-calls <a> [b]: what changed between two logged model calls
// (model, settings, tool definitions, system prompt, message history) and,
// when b missed the prompt cache, the first change that explains it. With one
// call, b is that call and a the model call before it in its session.
// Also printCall, the one-call view `coding.sh show <call>` prints.
import { CallRefError, diffCalls, loadCall, resolveCall, type CallDiff, type LoadedCall } from "../../proxy/calls.ts";
import type { IndexStore } from "../../core/types.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { oneLine, withContext } from "../common.ts";
import { clean, CliError, duration, tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** resolveCall with the CLI's errors. */
export async function callOrFail(index: IndexStore, ref: string): Promise<AgentEvent> {
  try {
    return await resolveCall(index, ref);
  } catch (e) {
    if (!(e instanceof CallRefError)) throw e;
    throw new CliError(e.message, {
      reason: e.reason,
      next: e.candidates.length ? ["Use more of the id:", ...e.candidates] : ["Calls are listed in a session's timeline:", "coding.sh show <session>"],
      ...(e.candidates.length ? { data: { candidates: e.candidates } } : {}),
    });
  }
}

/** The model call before `e` in its session, if any. */
async function previousCall(index: IndexStore, e: AgentEvent): Promise<AgentEvent | undefined> {
  const calls = await index.listEvents(e.sessionId, { kinds: ["llm.call"] });
  const i = calls.findIndex((x) => x.id === e.id);
  return i > 0 ? calls[i - 1] : undefined;
}

const short = (id: string) => id.slice(0, 12);
const clock = (ts: number) => new Date(ts).toISOString().slice(11, 19);
const val = (v: unknown) => (v === undefined ? "-" : typeof v === "string" ? v : JSON.stringify(v));

function cacheText(u: AgentEvent["usage"]): string {
  const r = u?.cacheReadTokens ?? 0;
  const w = u?.cacheWriteTokens ?? 0;
  if (!r && !w) return "no cache";
  const total = r + w + (u?.inputTokens ?? 0);
  return `cache read ${tokens(r)} write ${tokens(w)}${total ? ` (${Math.round((r / total) * 100)}% hit)` : ""}`;
}

export function printDiff(out: Output, d: CallDiff): void {
  for (const [k, s] of [["a", d.a], ["b", d.b]] as const) {
    out.print(`${out.style(k, "bold")}  ${short(s.id)}  ${s.model ?? "?"}  ${clock(s.ts)}  in ${tokens(s.usage.inputTokens)} out ${tokens(s.usage.outputTokens)}  ${cacheText(s.usage)}${s.usage.costUsd !== undefined ? `  ${usd(s.usage.costUsd)}` : ""}`);
  }
  out.print();
  const row = (label: string, text: string) => out.print(`${label.padEnd(10)}${text}`);
  row("Model", d.model ? `${d.model.a ?? "?"} → ${d.model.b ?? "?"}` : "same");
  if (d.content === "full") row("Settings", d.params.length ? d.params.map((p) => `${p.key} ${val(p.a)} → ${val(p.b)}`).join(", ") : "same");
  const t = d.tools;
  row("Tools", t.same ? "same" : [t.added.length ? `+ ${t.added.join(", ")}` : "", t.removed.length ? `- ${t.removed.join(", ")}` : "", t.changed.length ? `~ ${t.changed.join(", ")}` : "", t.reordered ? "reordered" : "", d.content === "metadata" && !t.added.length && !t.removed.length ? "changed (by hash)" : ""].filter(Boolean).join("  "));
  if (d.system.same) row("System", "same");
  else if (d.content === "metadata") row("System", `changed (hash ${d.system.a ?? "-"} → ${d.system.b ?? "-"})`);
  else {
    row("System", "changed");
    for (const l of d.system.lines ?? []) {
      const text = `          ${l.op} ${oneLine(clean(l.text), 110)}`;
      out.print(l.op === "+" ? out.style(text, "green") : l.op === "-" ? out.style(text, "red") : out.style(text, "faint"));
    }
    if (!d.system.lines) out.print("          (too long to diff line by line)");
  }
  const m = d.messages;
  row("Messages", d.content === "metadata" ? `${m.a} → ${m.b}` : m.rewritten ? `${m.a} → ${m.b}, rewritten from message ${m.shared + 1}` : `${m.a} → ${m.b}, b extends a (${m.shared} shared)`);
  const c = d.cache;
  if (c.expected === 0) row("Cache", "a cached nothing");
  else if (c.reused) row("Cache", out.style(`hit: b read ${tokens(c.read)} of the ${tokens(c.expected)} a cached`, "green"));
  else row("Cache", out.style(`miss: b read ${tokens(c.read)} of the ${tokens(c.expected)} a cached, and wrote ${tokens(c.write)}`, "yellow"));
  if (c.cause) row("Why", c.cause);
}

/** The one-call view: what was sent, what came back, usage and cache. `all` prints the whole system prompt. */
export function printCall(out: Output, l: LoadedCall, all: boolean): void {
  const e = l.event;
  const p = e.payload;
  const row = (label: string, text: string) => out.print(`${label.padEnd(10)}${text}`);
  out.print(out.style(oneLine(clean(String(p.prompt ?? e.model ?? e.id)), 100), "bold"));
  row("Call", e.id);
  row("Session", `${e.sessionId}${p.linkedBy ? ` (linked by ${String(p.linkedBy)})` : ""}`);
  row("Client", [p.client, p.clientVersion, p.provider, p.api].filter(Boolean).map(String).join("  "));
  row("Model", `${e.model ?? "?"}${p.requestModel && p.requestModel !== e.model ? ` (asked for ${String(p.requestModel)})` : ""}`);
  const status = [p.statusCode ?? p.errorClass ?? "?", p.stopReason, p.stream ? "stream" : "", p.aborted ? "aborted" : ""].filter(Boolean).map(String).join("  ");
  row("Status", `${status}  ${duration(e.durationMs)}${typeof p.ttfbMs === "number" ? `  first byte ${duration(p.ttfbMs)}` : ""}${typeof p.ttftMs === "number" ? `  first token ${duration(p.ttftMs)}` : ""}`);
  if (p.error) row("Error", oneLine(clean(String(p.error)), 100));
  const u = e.usage;
  row("Usage", `in ${tokens(u?.inputTokens)}  out ${tokens(u?.outputTokens)}  ${cacheText(u)}${u?.costUsd !== undefined ? `  ${usd(u.costUsd)}${p.costEstimated === true ? " est" : ""}` : ""}`);
  const info = l.info;
  const sys = info?.system;
  if (sys !== undefined) {
    const lines = sys.split("\n");
    row("System", `${sys.length.toLocaleString("en-US")} chars, ${lines.length} lines${p.systemHash ? `  #${String(p.systemHash)}` : ""}`);
    for (const line of all ? lines : lines.slice(0, 12)) out.print(out.style(`          ${oneLine(clean(line), 110)}`, "faint"));
    if (!all && lines.length > 12) out.print(out.style(`          … ${lines.length - 12} more lines (--all)`, "faint"));
  } else if (p.systemHash) row("System", `#${String(p.systemHash)} (content not stored)`);
  const names = info ? info.toolNames : ((p.toolNames as string[] | undefined) ?? []);
  if (names.length || p.toolCount) row("Tools", `${p.toolCount ?? names.length}${p.toolsHash ? `  #${String(p.toolsHash)}` : ""}  ${oneLine(names.join(", "), 100)}`);
  row("Messages", `${p.messageCount ?? info?.messages.length ?? "?"}`);
  if (info && Object.keys(info.params).length) row("Settings", oneLine(Object.entries(info.params).map(([k, v]) => `${k}=${val(v)}`).join("  "), 110));
  const rl = Object.entries(p).filter(([k]) => k.startsWith("rl") || k === "retryAfterMs");
  if (rl.length) row("Limits", rl.map(([k, v]) => `${k.replace(/^rl/, "")} ${String(v)}`).join("  "));
  if (!l.request) row("Content", p.requestRef ? "the request blob is gone (gc?)" : "not stored (capture mode metadata, or not a proxy call)");
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  return withContext(c, async (ctx) => {
    const b = await callOrFail(ctx.index, c.positionals[c.positionals.length > 1 ? 1 : 0]!);
    let a: AgentEvent | undefined;
    if (c.positionals.length > 1) a = await callOrFail(ctx.index, c.positionals[0]!);
    else {
      a = await previousCall(ctx.index, b);
      if (!a) throw new CliError(`Call ${short(b.id)} is the first model call of its session; name two calls`, { reason: "not_found", next: ["Compare two calls:", "coding.sh diff-calls <a> <b>"] });
    }
    const d = diffCalls(await loadCall(ctx.blobs, a), await loadCall(ctx.blobs, b));
    if (out.json) out.data(d);
    else printDiff(out, d);
    return 0;
  });
}
