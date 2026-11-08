// What made a suite's runs slow or expensive, as lines for the cut proposer
// (cut.ts): per-run cost, tokens, time and turns; the tasks that cost most;
// which tools ran and how often; identical calls repeated inside one run;
// duplicate fetches (core/waste.ts); the longest tool outputs; and the target
// file's size and largest sections, which ride along on every model call.
//
// Pure: the CLI turns each run's captured session and events into a DriverRun.
import type { AgentEvent, Session } from "../schema/index.ts";
import type { HarnessText } from "./protect.ts";

export interface DriverTool {
  tool: string;
  /** The tool and a short form of its input: what makes two calls the same call. */
  key: string;
  /** Output characters: the full output's when known, else as stored (captured outputs are clipped, so a floor). */
  outChars: number;
}

export interface DriverRun {
  task: string;
  pass: boolean;
  wall: number;
  cost?: number;
  tokens?: number;
  llm?: number;
  turns?: number;
  duplicateFetches?: number;
  tools: DriverTool[];
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `s` with the run's working directory taken off its paths, so the same call in two runs (two workspaces) is one key. */
function relative(s: string, cwd: string | undefined): string {
  if (!cwd) return s;
  const dir = cwd.replace(/[\\/]+$/, "");
  return s.split(`${dir}/`).join("").split(`${dir}\\`).join("");
}

/** A short, stable form of a tool call's input, with paths relative to the run's working directory. */
export function inputKey(input: unknown, cwd?: string): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["file_path", "path", "command", "cmd", "pattern", "url", "query", "skill"]) {
      if (typeof o[k] !== "string") continue;
      const v = relative((o[k] as string).replace(/\s+/g, " ").trim(), cwd);
      // A long path keeps its end: the file name tells two reads apart.
      return (k === "file_path" || k === "path") && v.length > 80 ? `…${v.slice(-79)}` : short(v, 80);
    }
  }
  return short(relative(JSON.stringify(input ?? null), cwd), 80);
}

/**
 * A run's driver facts from its captured session and events. `extra.outChars`
 * has the full length of outputs the capture clipped (by toolUseId).
 */
export function driverRun(task: string, pass: boolean, wall: number, s: Session | undefined, events: readonly AgentEvent[], extra: { cost?: number; tokens?: number; outChars?: ReadonlyMap<string, number> } = {}): DriverRun {
  const ends = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "tool.end") continue;
    const id = e.payload.toolUseId;
    const out = e.payload.output;
    if (typeof id === "string") ends.set(id, extra.outChars?.get(id) ?? (typeof out === "string" ? out.length : out === undefined ? 0 : JSON.stringify(out).length));
  }
  const tools: DriverTool[] = [];
  for (const e of events) {
    if (e.kind !== "tool.start" || e.payload.wrapper) continue;
    const tool = typeof e.payload.tool === "string" ? e.payload.tool : "tool";
    const id = e.payload.toolUseId;
    tools.push({ tool, key: `${tool} ${inputKey(e.payload.input, s?.cwd)}`, outChars: typeof id === "string" ? (ends.get(id) ?? 0) : 0 });
  }
  const u = s?.stats.usage;
  const tokens = extra.tokens ?? (u && (u.inputTokens !== undefined || u.outputTokens !== undefined) ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : undefined);
  const cost = extra.cost ?? u?.costUsd;
  return {
    task,
    pass,
    wall,
    ...(cost !== undefined ? { cost } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(s?.stats.latency?.llmMs !== undefined ? { llm: s.stats.latency.llmMs } : {}),
    ...(s ? { turns: s.stats.turns } : {}),
    ...(s?.stats.waste ? { duplicateFetches: s.stats.waste.duplicateFetches } : {}),
    tools,
  };
}

/** Markdown sections (a heading and what follows it up to the next heading of any level), largest first. */
export function sections(text: string): { heading: string; bytes: number }[] {
  const out: { heading: string; bytes: number }[] = [];
  let cur = { heading: "(top of file)", start: 0 };
  const lines = text.split("\n");
  let pos = 0;
  let fence = false;
  const close = (end: number) => {
    const bytes = Buffer.byteLength(text.slice(cur.start, end));
    if (bytes > 0 && text.slice(cur.start, end).trim()) out.push({ heading: cur.heading, bytes });
  };
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^#{1,6}\s+\S/.test(l)) {
      close(pos);
      cur = { heading: short(l.trim(), 70), start: pos };
    }
    pos += l.length + 1;
  }
  close(text.length);
  return out.sort((a, b) => b.bytes - a.bytes);
}

const avg = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const known = (rs: readonly DriverRun[], k: "cost" | "tokens" | "llm" | "turns") => rs.map((r) => r[k]).filter((v): v is number => typeof v === "number");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Lines for the cut proposer: at most a few per driver, worst first. */
export function costDrivers(runs: readonly DriverRun[], target?: HarnessText): string[] {
  const out: string[] = [];
  if (runs.length) {
    const tasks = new Set(runs.map((r) => r.task));
    const per = [
      known(runs, "cost").length ? `cost $${avg(known(runs, "cost")).toFixed(4)}` : "",
      known(runs, "tokens").length ? `${Math.round(avg(known(runs, "tokens")))} tokens` : "",
      `wall ${secs(avg(runs.map((r) => r.wall)))}`,
      known(runs, "llm").length ? `LLM time ${secs(avg(known(runs, "llm")))}` : "",
      known(runs, "turns").length ? `${avg(known(runs, "turns")).toFixed(1)} turns` : "",
    ].filter(Boolean);
    out.push(`- ${runs.length} runs over ${tasks.size} tasks, ${Math.round((runs.filter((r) => r.pass).length / runs.length) * 100)}% passed. Per run: ${per.join(", ")}.`);
    const byTask = [...tasks].map((t) => {
      const rs = runs.filter((r) => r.task === t);
      return { t, wall: avg(rs.map((r) => r.wall)), turns: known(rs, "turns").length ? avg(known(rs, "turns")) : undefined, tools: avg(rs.map((r) => r.tools.length)) };
    });
    byTask.sort((a, b) => b.wall - a.wall);
    out.push(`- Slowest tasks: ${byTask.slice(0, 3).map((x) => `${x.t} (${secs(x.wall)}${x.turns !== undefined ? `, ${x.turns.toFixed(1)} turns` : ""}, ${x.tools.toFixed(1)} tool calls)`).join("; ")}.`);
    const toolCount = new Map<string, number>();
    for (const r of runs) for (const t of r.tools) toolCount.set(t.tool, (toolCount.get(t.tool) ?? 0) + 1);
    if (toolCount.size) {
      out.push(`- Tool calls per run: ${[...toolCount].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ${(n / runs.length).toFixed(1)}`).join(", ")}.`);
    }
    const repeats = new Map<string, { runs: number; max: number }>();
    for (const r of runs) {
      const seen = new Map<string, number>();
      for (const t of r.tools) seen.set(t.key, (seen.get(t.key) ?? 0) + 1);
      for (const [k, n] of seen) {
        if (n < 2) continue;
        const x = repeats.get(k) ?? { runs: 0, max: 0 };
        repeats.set(k, { runs: x.runs + 1, max: Math.max(x.max, n) });
      }
    }
    if (repeats.size) {
      const top = [...repeats].sort((a, b) => b[1].runs * b[1].max - a[1].runs * a[1].max).slice(0, 5);
      out.push(`- The same call repeated inside one run: ${top.map(([k, x]) => `"${k}" up to ${x.max} times (in ${x.runs} run${x.runs === 1 ? "" : "s"})`).join("; ")}.`);
    }
    const dup = runs.reduce((s, r) => s + (r.duplicateFetches ?? 0), 0);
    if (dup) out.push(`- ${dup} duplicate fetches (a read repeated while its first result was unchanged and still in context).`);
    const long = runs.flatMap((r) => r.tools).filter((t) => t.outChars >= 2000);
    if (long.length) {
      const big = new Map<string, number>();
      for (const t of long) big.set(t.key, Math.max(big.get(t.key) ?? 0, t.outChars));
      out.push(`- Long tool outputs: ${[...big].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `"${k}" ≥ ${n} chars`).join("; ")}.`);
    }
  }
  if (target?.text) {
    const top = sections(target.text).slice(0, 5);
    out.push(`- ${target.path} is ${Buffer.byteLength(target.text)} bytes and rides along on every model call of every session. Largest sections: ${top.map((s) => `${s.heading} (${s.bytes} bytes)`).join("; ")}.`);
  }
  return out;
}
