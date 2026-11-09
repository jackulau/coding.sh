// coding.sh refine diagnose|signals: the two-stage LLM diagnosis
// (src/refine/diagnose.ts, src/refine/signals.ts). `diagnose` only runs when
// asked: with no API key (and no --provider claude-code|codex) it prints a $0
// plan of the sessions and tokens it would send. Each occurrence keeps only
// citations checked against the trace; severity comes from code. Replies are
// cached, so a rerun on unchanged sessions makes no call and leaves
// signals.json byte for byte the same. `signals` reads that file.
import { resolve } from "node:path";
import { providerFromSpec, type LlmProviderSpec } from "../../graders/index.ts";
import type { ChatProvider } from "../../judge/providers.ts";
import { diagnoseRun, hintPrecision, signalsFile, type DiagnoseRunResult } from "../../refine/diagnose.ts";
import { refineDir } from "../../refine/ledger.ts";
import { readSignals, type Signal, type SignalsDoc } from "../../refine/signals.ts";
import { catalogHash } from "../../refine/taxonomy.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { list, str, withContext } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { gitRoot, providerDefaultModel } from "./exp-ab.ts";

const PROVIDERS = ["anthropic", "openai", "claude-code", "codex"] as const;
type Provider = (typeof PROVIDERS)[number];

/** The provider to call, or undefined for a $0 plan: an explicit --provider, else the API whose key is set. */
export function diagnoseProvider(flags: { provider?: string; dryRun?: boolean }, env: NodeJS.ProcessEnv): Provider | undefined {
  if (flags.provider !== undefined && !(PROVIDERS as readonly string[]).includes(flags.provider)) {
    throw new UsageError(`--provider must be one of ${PROVIDERS.join(", ")}`, { reason: "invalid_argument", suggestion: "coding.sh refine diagnose --provider anthropic" });
  }
  if (flags.dryRun) return undefined;
  if (flags.provider) return flags.provider as Provider;
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  return undefined;
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function signalRow(s: Signal): string[] {
  return [s.id, `${s.severity.score} ${s.severity.level}`, s.title, s.typeIds[0] ?? "", `${s.population.affected}/${s.population.analyzed}`, s.status];
}

function printSignals(c: CommandContext, doc: SignalsDoc): void {
  const { out } = c;
  const ranked = [...doc.signals].sort((a, b) => b.severity.score - a.severity.score || b.lastSeen - a.lastSeen || (a.id < b.id ? -1 : 1));
  out.table(["SIGNAL", "SEVERITY", "TITLE", "TYPE", "SESSIONS", "STATUS"], ranked.map(signalRow));
  const hints = hintPrecision(doc).filter((h) => h.precision !== null);
  if (hints.length) out.note(`Rule precision: ${hints.map((h) => `${h.flag} ${Math.round(h.precision! * 100)}% (${h.confirmed}/${h.confirmed + h.rejected})`).join(", ")}`);
  if (ranked.some((s) => s.status === "quiet")) out.note("Quiet means no new occurrence in the last 20 analyzed sessions; it is not evidence a fix worked. Run coding.sh refine test.");
}

export async function refineDiagnose(c: CommandContext): Promise<number> {
  const { out } = c;
  const root = gitRoot(c.cwd) ?? c.cwd;
  const dir = refineDir(c.env, root);
  const since = parseSince(str(c.flags.since) ?? "7d");
  const repoFlag = str(c.flags.repo);
  const repo = repoFlag === "all" ? undefined : repoFlag ? resolve(c.cwd, repoFlag) : root;
  const agents = list(c.flags.agent);
  const sessionIds = list(c.flags.session);
  const maxSessions = positiveInt(c.flags["max-sessions"], "max-sessions") ?? 50;
  const tokenBudget = positiveInt(c.flags["budget-tokens"], "budget-tokens");
  const concurrency = positiveInt(c.flags.concurrency, "concurrency");
  const kind = diagnoseProvider({ ...(str(c.flags.provider) ? { provider: str(c.flags.provider)! } : {}), dryRun: c.flags["dry-run"] === true }, c.env);
  let provider: ChatProvider | undefined;
  if (kind) {
    const model = str(c.flags.model) ?? providerDefaultModel(kind);
    const spec: LlmProviderSpec = { provider: kind, ...(model ? { model } : {}), maxTokens: 4000 };
    provider = providerFromSpec(spec, { env: c.env });
  }
  return withContext(c, async (ctx) => {
    const r: DiagnoseRunResult = await diagnoseRun({
      index: ctx.index,
      dir,
      filter: { since, ...(agents.length ? { agents } : {}), ...(repo ? { repo } : {}), ...(sessionIds.length ? { sessionIds } : {}), ...(c.flags["include-runs"] === true ? { includeRuns: true } : {}) },
      maxSessions,
      ...(tokenBudget ? { tokenBudget } : {}),
      ...(concurrency ? { concurrency } : {}),
      ...(provider ? { provider } : {}),
      ...(c.flags.split === false || c.flags["no-split"] === true ? { split: false } : {}),
      ...(c.signal ? { signal: c.signal } : {}),
    });
    if (!provider) {
      if (out.json) {
        out.data({ plan: true, file: signalsFile(dir), sessions: r.plan.sessions, estimatedInputTokens: r.plan.tokens, uncached: r.plan.uncached, calls: 0 });
        return 0;
      }
      if (!r.plan.sessions.length) {
        out.note(`No session to diagnose since ${day(since)}${repo ? ` under ${repo}` : ""}`);
        out.next("Look further back, or in every repo", "coding.sh refine diagnose --since 30d --repo all");
        return 0;
      }
      out.table(["SESSION", "AGENT", "STARTED", "TOKENS"], r.plan.sessions.map((s) => [s.id, s.agent, day(s.startedAt), tokens(s.tokens)]));
      out.note(`Plan, $0: ${plural(r.plan.sessions.length, "session")}, about ${tokens(r.plan.tokens)} input tokens in ${plural(r.plan.uncached, "call")}, plus a call per new Signal`);
      out.next("Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or use a logged-in CLI, to run it", "coding.sh refine diagnose --provider claude-code");
      return 0;
    }
    const insufficient = r.results.filter((x) => x.status === "insufficient-evidence").length;
    if (out.json) {
      out.data({
        file: signalsFile(dir),
        model: provider.model,
        analyzed: r.results.length,
        pending: r.pending,
        insufficientEvidence: insufficient,
        droppedUnverified: r.droppedUnverified,
        calls: r.calls,
        changed: r.changed,
        hints: r.hints,
        signals: r.doc.signals,
      });
      return 0;
    }
    if (!r.doc.signals.length) out.note(`No Signal yet (${plural(r.results.length, "session")} diagnosed)`);
    else printSignals(c, r.doc);
    const parts = [
      `${plural(r.results.length, "session")} diagnosed`,
      `${plural(r.calls.calls, "model call")}${r.calls.cached ? `, ${r.calls.cached} cached` : ""}`,
      ...(r.changed.length ? [`${plural(r.changed.length, "Signal")} changed`] : []),
      ...(r.droppedUnverified ? [`${plural(r.droppedUnverified, "occurrence")} dropped without a verified citation`] : []),
      ...(insufficient ? [`${insufficient} with insufficient evidence`] : []),
    ];
    out.note(parts.join("; "));
    if (r.pending.length) out.next(`${plural(r.pending.length, "session")} left over the token budget; run again to continue`, "coding.sh refine diagnose");
    else if (r.doc.signals.length) out.next("See one Signal with its evidence", `coding.sh refine signals show ${[...r.doc.signals].sort((a, b) => b.severity.score - a.severity.score)[0]!.id}`);
    return 0;
  });
}

export async function refineSignals(c: CommandContext): Promise<number> {
  const { out } = c;
  const root = gitRoot(c.cwd) ?? c.cwd;
  const file = signalsFile(refineDir(c.env, root));
  const doc = readSignals(file, catalogHash());
  const [sub, id] = c.positionals;
  if (sub !== undefined && sub !== "show") throw new UsageError(`refine signals takes "show <id>", got ${JSON.stringify(sub)}`, { reason: "invalid_argument", suggestion: "coding.sh refine signals show <id>" });
  if (sub === "show") {
    if (!id) throw new UsageError("refine signals show needs a Signal id", { reason: "missing_argument", suggestion: "coding.sh refine signals" });
    const s = doc.signals.find((x) => x.id === id || x.id.startsWith(id));
    if (!s) throw new UsageError(`No Signal ${id} in ${file}`, { reason: "not_found", suggestion: "coding.sh refine signals" });
    if (out.json) {
      out.data(s);
      return 0;
    }
    out.row("Signal", `${s.id}  ${s.title}`);
    out.row("Severity", `${s.severity.score} ${s.severity.level} (${s.severity.drivingNature}; ${s.severity.parts.map((p) => `${p.nature} ${p.score}`).join(", ")})`);
    out.row("Type", s.typeIds.join(", "));
    out.row("Component", `${s.component.type} ${s.component.name}`);
    out.row("Sessions", `${s.population.affected} of ${s.population.analyzed} analyzed, ${day(s.firstSeen)} to ${day(s.lastSeen)}`);
    out.row("Status", s.status === "quiet" ? `quiet (${s.analyzedSinceLastSeen} analyzed since; not evidence a fix worked)` : "open");
    if (s.remediation) {
      out.row("Fix", `${s.remediation.action} (${s.remediation.surface}, ${s.remediation.intent})`);
      if (s.remediation.sessions.affected.length) out.row("Re-test on", s.remediation.sessions.affected.join(" "));
      if (s.remediation.sessions.preserved.length) out.row("Must still pass", s.remediation.sessions.preserved.join(" "));
    }
    out.print();
    for (const o of s.occurrences) {
      out.print(`${o.sessionId}  ${o.nature} ${o.factor}${o.reach !== undefined ? ` x${o.reach}` : ""}  ${o.explanation}`);
      for (const e of o.evidence) out.print(`  [${e.eventId ?? "?"}] "${e.quote}"`);
      if (o.requirement) for (const e of o.requirement.citations) out.print(`  requirement (${o.requirement.source}) [${e.eventId ?? "?"}] "${e.quote}"`);
    }
    return 0;
  }
  if (out.json) {
    out.data({ file, analyzed: Object.keys(doc.sessions).length, hints: hintPrecision(doc), signals: doc.signals });
    return 0;
  }
  if (!doc.signals.length) {
    out.note(`No Signals yet (${plural(Object.keys(doc.sessions).length, "session")} diagnosed)`);
    out.next("Diagnose recent sessions (prints a $0 plan without an API key)", "coding.sh refine diagnose");
    return 0;
  }
  printSignals(c, doc);
  return 0;
}
