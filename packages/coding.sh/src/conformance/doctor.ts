// `coding.sh doctor --conformance`: runs each agent's backfill over the
// transcripts on this machine and checks the events against the invariants in
// ./index.ts. Read-only: transcripts are only read (SQLite sources are read
// from a temp copy by the adapters), blobs are hashed and dropped, and the
// coding.sh store is never opened, so no migration ever runs on it.
import { ADAPTERS } from "../adapters/index.ts";
import type { Adapter } from "../core/types.ts";
import { parseSince, UsageError } from "../cli/args.ts";
import { list, num, str } from "../cli/common.ts";
import type { CommandContext } from "../cli/types.ts";
import { pickAdapters } from "../cli/commands/init.ts";
import { checkAdapter, RULES, score, type AdapterReport, type Rule } from "./index.ts";
import { sourceSummary } from "./sources.ts";

export const DEFAULT_SINCE = "7d";
export const DEFAULT_MAX_EVENTS = 200_000;
/** Per agent. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ConformanceRun {
  ok: boolean;
  /** Share of the checked agents with no violations (0 to 1). */
  score: number;
  since: string;
  agents: (AdapterReport & { name: string; status: "clean" | "violations" | "no-data" | "no-backfill" })[];
}

/** Checks every agent with a backfill (or the named ones) and returns the run, without printing. */
export async function conformance(adapters: readonly Adapter[], opts: { since: number; maxEvents: number; timeoutMs: number; named: boolean; env: NodeJS.ProcessEnv }): Promise<ConformanceRun> {
  const agents: ConformanceRun["agents"] = [];
  for (const a of adapters) {
    const name = a.displayName;
    if (!a.backfill) {
      if (opts.named) agents.push({ adapter: a.id, name, ms: 0, skipped: "no-backfill", report: emptyReport(), violations: 0, status: "no-backfill" });
      continue;
    }
    const src = sourceSummary(a.id, { env: opts.env, since: opts.since });
    // Nothing on disk since the cut: nothing to check (a named agent still gets a row).
    if (src && src.files === 0) {
      if (opts.named) agents.push({ adapter: a.id, name, ms: 0, sources: src, report: emptyReport(), violations: 0, status: "no-data" });
      continue;
    }
    const r = await checkAdapter(a, { since: opts.since, maxEvents: opts.maxEvents, timeoutMs: opts.timeoutMs, env: opts.env });
    if (r.violations === 0 && r.report.counts.events === 0) {
      if (opts.named) agents.push({ ...r, name, status: "no-data" });
      continue;
    }
    agents.push({ ...r, name, status: r.violations ? "violations" : "clean" });
  }
  const checked = agents.filter((x) => x.status === "clean" || x.status === "violations");
  return { ok: checked.every((x) => x.violations === 0), score: score(checked), since: new Date(opts.since).toISOString(), agents };
}

function emptyReport(): AdapterReport["report"] {
  return {
    ok: true,
    counts: { events: 0, sessions: 0, kinds: {}, sessionsWithoutStart: 0, sessionsWithoutUserMessage: 0, duplicateIdsSameContent: 0, duplicateIdsDifferentContent: 0, parentIds: 0, danglingParentIds: 0, toolStartWithoutEnd: 0, toolEndWithoutStart: 0, badTimestamps: 0, negativeDurations: 0, partialSessions: 0 },
    violations: {},
    examples: [],
  };
}

const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

export async function runConformance(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const named = list(c.flags.agent);
  const sinceRaw = str(c.flags.since) ?? DEFAULT_SINCE;
  const since = parseSince(sinceRaw);
  const maxEvents = num(c.flags["max-events"]) ?? DEFAULT_MAX_EVENTS;
  if (!(maxEvents >= 1) || !Number.isInteger(maxEvents)) throw new UsageError(`--max-events must be a whole number of 1 or more, got ${maxEvents}`, { reason: "invalid_argument" });
  const spin = out.spin("Reading transcripts…");
  const run = await conformance(named.length ? pickAdapters(named) : ADAPTERS, { since, maxEvents, timeoutMs: DEFAULT_TIMEOUT_MS, named: named.length > 0, env });
  spin.stop();

  if (out.json) {
    out.data(run);
    return run.ok ? 0 : 1;
  }
  for (const a of run.agents) {
    if (a.status === "no-backfill") {
      out.row(a.name, "no transcripts to read (captured by hooks only)", "none");
      continue;
    }
    if (a.status === "no-data") {
      out.row(a.name, `no transcripts since ${sinceRaw === DEFAULT_SINCE ? "7 days ago" : sinceRaw}`, "none");
      continue;
    }
    const k = a.report.counts;
    const size = `${plural(k.events, "event")}, ${plural(k.sessions, "session")}`;
    const cut = a.truncated ? `, stopped at ${a.truncated === "timeout" ? `${DEFAULT_TIMEOUT_MS / 1000} s` : plural(maxEvents, "event")}` : "";
    if (!a.violations) {
      out.row(a.name, `${size}${cut}, no violations`, "ok");
      continue;
    }
    const rules = (Object.entries(a.report.violations) as [Rule, number][]).map(([r, n]) => {
      const f = (RULES[r] as { finding?: string }).finding;
      return `${r} ${n}${f ? ` (${f})` : ""}`;
    });
    out.row(a.name, `${size}${cut}, ${plural(a.violations, "violation")}: ${rules.join(", ")}`, "fail");
    const shown = new Set<Rule>();
    for (const v of a.report.examples) {
      if (shown.has(v.rule)) continue;
      shown.add(v.rule);
      out.note(`${v.rule}: ${v.detail}${v.sessionId ? ` (session ${v.sessionId.slice(0, 36)})` : ""}`);
    }
  }
  const checked = run.agents.filter((a) => a.status === "clean" || a.status === "violations");
  if (!checked.length) {
    out.row("Conformance", `no agent transcripts since ${sinceRaw}`, "none");
    out.next("Look further back", "coding.sh doctor --conformance --since 30d");
    out.print("ok");
    return 0;
  }
  const clean = checked.filter((a) => a.violations === 0).length;
  if (!run.ok) out.next("See every violation", `coding.sh doctor --conformance --json${named.length ? named.map((n) => ` --agent ${n}`).join("") : ""}`);
  out.print(`${clean}/${checked.length} agents conform`);
  return run.ok ? 0 : 1;
}
