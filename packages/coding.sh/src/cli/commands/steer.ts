// coding.sh steer <session>: live telemetry steering advisor for one session.
// Reads stored session stats and events (with auto-ingest / --fresh) and prints
// continue, nudge, or intervene with concrete directives and a paste-ready steer.
import { buildSteerAdvice, type SteerAdvice, type SteerPriority, type SteerRisk, type SteerStatus } from "../../core/steer.ts";
import { autoIngest, notFoundWithBacklog, oneLine, pendingField, readIngest, resolveSession, withContext } from "../common.ts";
import { clean, plural, type Output, type Style } from "../output.ts";
import type { CommandContext } from "../types.ts";

const STATUS_STYLE: Record<SteerStatus, Style> = {
  continue: "green",
  nudge: "yellow",
  intervene: "red",
};

const RISK_STYLE: Record<SteerRisk, Style> = {
  low: "green",
  medium: "yellow",
  high: "red",
};

const PRIORITY_STYLE: Record<SteerPriority, Style> = {
  high: "red",
  medium: "yellow",
  low: "faint",
};

function formatTelemetry(a: SteerAdvice): string {
  const t = a.telemetry;
  const parts = [
    plural(t.checks, "check"),
    `${t.unverifiedTailEdits} unverified tail (max ${t.maxUnverifiedEdits})`,
    plural(t.compactions, "compaction"),
  ];
  if (t.deadEndStreak > 0) parts.push(`dead-end streak ${t.deadEndStreak}`);
  if (t.proofLangs?.length) {
    const proofParts: string[] = [];
    if (t.oscillatingChecks) proofParts.push(`${t.oscillatingChecks} oscillating`);
    if (t.escapeRemaining) proofParts.push(plural(t.escapeRemaining, "escape"));
    const detail = proofParts.length ? ` (${proofParts.join(", ")})` : "";
    parts.push(`proof ${t.proofLangs.join("/")}${detail}`);
  }
  return parts.join(", ");
}

function printAdvice(out: Output, title: string, a: SteerAdvice): void {
  const badge = out.style(a.status, STATUS_STYLE[a.status]);
  const riskBadge = out.style(a.risk, RISK_STYLE[a.risk]);
  out.print(`${out.style(oneLine(clean(title), 90), "bold")}  [${badge}]`);

  const rows: [string, string][] = [
    ["Session", a.sessionId],
    ["Status", badge],
    ["Risk", riskBadge],
    ["Telemetry", formatTelemetry(a)],
  ];
  for (const [k, v] of rows) out.print(`  ${k.padEnd(14)}${v}`);

  if (a.directives.length === 0) {
    out.print();
    out.print("  No intervention needed.");
    return;
  }

  out.print();
  out.print(out.style("Directives", "bold"));
  for (const d of a.directives) {
    const glyph = d.priority === "low" ? out.style("-", "faint") : out.style("!", PRIORITY_STYLE[d.priority]);
    out.print(`  ${glyph} [${d.kind}] (${d.priority}) ${clean(d.reason)}`);
    if (d.evidence) out.print(`    ${out.style("evidence:", "faint")} ${clean(d.evidence)}`);
  }

  if (a.suggestedSteer) {
    out.print();
    out.print(out.style("Suggested steer", "bold"));
    out.print(`  ${clean(a.suggestedSteer)}`);
  }
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = c.positionals[0]!;
  const promptOnly = c.flags.prompt === true;
  const strict = c.flags.strict === true;

  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    let session;
    try {
      session = await resolveSession(ctx, ref);
    } catch (err) {
      throw notFoundWithBacklog(err, backlog);
    }

    const events = await ctx.index.listEvents(session.id);
    const advice = buildSteerAdvice(session, events);
    const exitCode = strict && advice.status === "intervene" ? 1 : 0;

    if (out.json) {
      const doc: Record<string, unknown> = { ...advice };
      Object.assign(doc, pendingField(backlog));
      out.data(doc);
      return exitCode;
    }

    if (promptOnly) {
      if (advice.suggestedSteer) out.print(clean(advice.suggestedSteer));
      return exitCode;
    }

    printAdvice(out, session.title ?? session.id, advice);
    return exitCode;
  }, { create: false });
}
