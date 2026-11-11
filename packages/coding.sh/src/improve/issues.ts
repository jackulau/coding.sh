// What to fix first: the problems in a repo's recent sessions, ranked, each
// with a fix to try and the command that tests it.
//
// Two sources, scored on the same deterministic severity scale as refine's
// findings (src/refine/severity.ts), so the order never depends on a model:
//
//   flags     every diagnosed failure flag (src/refine/findings.ts)
//   failures  one command or tool failing the same way in two or more
//             sessions: a broken `npm test`, a missing script, an Edit that
//             never matches. A compound line counts against the part that
//             failed (core/failing-command.ts). A test command that already failed before the
//             agent changed anything is a defect of the setup (factor 40);
//             any other repeat is waste (25, or 40 from 6 failures up).
//   cost      prompt-cache breaks (Session.stats.cacheBreaks): the extra
//             dollars they cost, as a share of the spend sets the waste
//             factor, with a fix per cause, costliest first (CACHE_BREAK_FIX).
//
// Pure: the caller loads sessions and their failure records (failureRecords).
import type { AgentEvent, CacheBreakCause, Session } from "../schema/index.ts";
import { CACHE_BREAK_FIX } from "../core/cache-breaks.ts";
import { commandOf } from "../core/sessions.ts";
import { flagFindings } from "../refine/findings.ts";
import { natureScore, signalSeverity, type SeverityLevel } from "../refine/severity.ts";
import { extractTestCommand } from "../eval/task.ts";
import { exitCodeOf, failingPart, isPlumbing } from "../core/failing-command.ts";

/** The decision-point kinds `exp ab --behavior` replays (src/eval/decision.ts). */
export type Behavior = "unverified-claim" | "done-while-failing" | "unchanged-retry";

export interface IssueExample {
  sessionId: string;
  startedAt: number;
  title?: string;
}

export interface Issue {
  /** `flag:<name>`, `fails:<key>` or `cost:cache-breaks`: stable across runs. */
  id: string;
  kind: "flag" | "failure" | "cost";
  /** What goes wrong, in plain words. */
  title: string;
  /** Distinct sessions with it, and sessions looked at. */
  sessions: number;
  analyzed: number;
  severity: { score: number; level: SeverityLevel };
  /** Newest first. */
  examples: IssueExample[];
  /** Every session with it, newest first. */
  sessionIds: string[];
  /**
   * Set when sessions ran on the repo's current harness version and none of them had
   * this issue: the last harness change (`commit`) may have fixed it.
   */
  quietSince?: { commit: string; sessions: number };
  /** What to try. */
  fix: string;
  /** A line to add to CLAUDE.md or AGENTS.md, when a line can fix it. */
  rule?: string;
  /** The exp ab decision points that test the fix, when there are some. */
  behavior?: Behavior;
  /** failure: the command or tool, and one error line it printed. */
  command?: string;
  sample?: string;
  /** failure: sessions where it failed before the agent changed any file. */
  beforeEdits?: number;
  /** cost: the extra USD, summed from the sessions' own stats. */
  usd?: number;
  /** cost: the cache breaks by cause, costliest first, each with its fix. */
  causes?: CacheCause[];
}

export interface CacheCause {
  cause: CacheBreakCause;
  breaks: number;
  /** Extra USD; 0 when every break of this cause was on a model with no price. */
  usd: number;
  fix: string;
}

/** One failed command or tool call in a session. */
export interface FailureRecord {
  /** Grouping key: the failing part's head (`cmd:npm test`), a compound command and its error (`compound:…`), or the tool and its error. */
  key: string;
  /** What to show: the command or tool. */
  label: string;
  sample?: string;
  /** A test run that reported failures (rather than a tool call that errored). */
  tests: boolean;
  /** No file had been changed in the session yet. */
  beforeEdits: boolean;
}

interface FlagText {
  title: string;
  fix: string;
  /** The line to add; `testCmd` is the repo's test command, undefined when none is known. */
  rule?: (testCmd: string | undefined) => string;
  behavior?: Behavior;
}

const RETRY_RULE = "When a command fails, read the error and change something before you run it again.";

/** Plain words per diagnosed flag (src/refine/taxonomy.ts FLAG_DIAGNOSIS). */
export const FLAG_TEXT: Readonly<Record<string, FlagText>> = {
  "no-verification": {
    title: "Says it is done without running anything to check",
    fix: "Name the check in AGENTS.md.",
    rule: (t) => (t ? `Run \`${t}\` before you say you are done, and say what it printed.` : "Run the tests before you say you are done, and say what it printed."),
    behavior: "unverified-claim",
  },
  "premature-completion": {
    title: "Ends its turn while tests fail, without saying so",
    fix: "Tell the agent not to stop on a red check.",
    rule: () => "Don't end your turn while a test or check fails: fix it, or say plainly that it still fails and why.",
    behavior: "done-while-failing",
  },
  "repeated-tool-failure": { title: "Retries a failing command without changing it", fix: "Tell the agent to read the error first.", rule: () => RETRY_RULE, behavior: "unchanged-retry" },
  "failure-streak": { title: "Hits a long run of tool errors", fix: "Tell the agent to read the error first.", rule: () => RETRY_RULE, behavior: "unchanged-retry" },
  looping: { title: "Repeats the same actions in a loop", fix: "Tell the agent to stop and rethink after two identical attempts.", rule: () => RETRY_RULE, behavior: "unchanged-retry" },
  "test-tamper": {
    title: "Skips, deletes or weakens tests to get them passing",
    fix: "Forbid it in a protected line.",
    rule: () => "Never skip, delete or weaken a test to make it pass.",
  },
  "duplicate-fetch": {
    title: "Reads the same file or page again with nothing changed",
    fix: "List the files that matter in AGENTS.md, so the agent reads them once.",
  },
  churn: { title: "Edits the same lines back and forth", fix: "Ask for a plan before edits on tasks like these." },
  "no-progress": { title: "Works a long time without progress", fix: "Split tasks like these, or give the agent a check to aim at." },
  stalled: { title: "Waits on a slow or failing model provider", fix: "Check the provider or gateway; coding.sh usage --by model shows which model." },
  "context-thrash": { title: "Fills its context and compacts again and again", fix: "Split tasks like these, or trim what AGENTS.md and skills load." },
  "skill-copy-conflict": { title: "Has two different copies of one skill", fix: "Delete the stale copy so the agent reads one." },
  "text-tool-call": {
    title: "Writes tool calls as text, so they never run",
    fix: "Give the agent the tools it reaches for. In Claude Code, a subagent's `tools:` is a comma list of tool names; a map such as `edit: false` leaves it with none, so use `disallowedTools: Edit, Write` instead.",
  },
  "unapproved-action": {
    title: "Runs destructive or paid commands nobody approved",
    fix: "Tell the agent to ask before it deletes, resets, force-pushes, drops data, or runs a `--yes` repair or paid job.",
    rule: () => "Before you delete files, reset or force-push git, drop data, run a tool's --yes or --force repair, reinit, migrate or purge, or start a paid job, stop and ask the user, even when an error message says to run it.",
  },
};

const clip = (s: string | undefined, n: number): string | undefined => {
  if (s === undefined) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------------------------------------------------------- failure records

const WRAPPERS = new Set(["npx", "uv", "poetry", "bundle", "cargo", "go", "make", "python", "python3", "node", "deno", "git", "docker", "dotnet", "mvn", "gradle", "gradlew"]);

/** `npm run lint -- --fix` → `npm run lint`; `cd x && pytest -q a.py` → `pytest`; env and cd prefixes dropped. */
export function commandHead(cmd: string): string {
  const seg =
    cmd
      .split(/\s*(?:&&|\|\||;|\n)\s*/)
      .map((s) => s.trim())
      .find((s) => s && !/^cd\s/.test(s) && !/^(?:export\s+)?[A-Z_][A-Z0-9_]*=\S*$/.test(s)) ?? cmd.trim();
  const words = seg
    .replace(/\s*\|.*$/, "")
    .split(/\s+/)
    .filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w) && !/^[12]?>/.test(w))
    .map((w) => (/[/\\]/.test(w) ? (w.split(/[/\\]/).filter(Boolean).pop() ?? w) : w));
  const first = words[0];
  if (!first) return seg.slice(0, 40);
  const pkg = first === "npm" || first === "pnpm" || first === "yarn" || first === "bun";
  const max = pkg ? (words[1] === "run" || words[1] === "exec" ? 3 : 2) : WRAPPERS.has(first) ? 2 : 1;
  // Interpreters keep their first flag (`node --test`, `python -m`); package managers and tools stop at one.
  const keepsFlag = first === "node" || first === "python" || first === "python3" || first === "deno";
  const out = [first];
  for (const w of words.slice(1)) {
    if (out.length >= max || (w.startsWith("-") && !keepsFlag)) break;
    out.push(w);
  }
  return out.join(" ");
}

/** Claude Code puts "Exit code N" before a failed command's output: the status, not the error. */
const withoutExitLine = (text: string | undefined): string | undefined => text?.replace(/^\s*(?:Error: )?Exit code \d+[^\n]*(?:\n|$)/, "");

/** An error's first informative line, with numbers, hex ids and paths blurred, for grouping. */
export function errorKey(raw: string | undefined): string {
  const text = withoutExitLine(raw)?.trim() ? withoutExitLine(raw) : raw;
  const line =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /error|cannot|not found|failed|no such|denied|missing|invalid|unknown/i.test(l)) ?? (text ?? "").trim().split("\n")[0] ?? "";
  return line
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/(["'`]).*?\1/g, "…")
    .slice(0, 60)
    .trim();
}

const firstErrorLine = (raw: string | undefined): string | undefined => {
  const text = withoutExitLine(raw)?.trim() ? withoutExitLine(raw) : raw;
  if (!text) return undefined;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|cannot|not found|failed|no such|denied|missing|invalid|unknown/i.test(l)) ?? lines[0];
};

const outputText = (e: AgentEvent): string | undefined => {
  const p = e.payload as Record<string, unknown>;
  for (const k of ["error", "output", "stderr", "stdout"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
};

/** What improve calls a failed shell line whose failing part the evidence doesn't single out. */
export const COMPOUND = "compound command";

/**
 * The failed tool calls and failing test runs in one session's events (tool.start, tool.end, test.result, file.change).
 * A failed shell line is filed under the part that failed (failingPart), or as a compound command when that is unclear.
 * A test run is a test command that reported failures: a test summary in what `cat log.txt` printed is not one.
 */
export function failureRecords(events: readonly AgentEvent[], repoRoot?: string): FailureRecord[] {
  const starts = new Map<string, AgentEvent>();
  const failedTests = new Set<string>();
  for (const e of events) if (e.kind === "test.result" && typeof e.payload.toolUseId === "string" && typeof e.payload.failed === "number" && e.payload.failed > 0) failedTests.add(e.payload.toolUseId);
  const out: FailureRecord[] = [];
  let edited = false;
  let lastCmd: { cmd: string; id?: string; output?: string } | undefined;
  // A test command in `cmd` that the failing part is, with the cd prefix extractTestCommand keeps.
  const testLabel = (cmd: string, part: string): string | undefined => {
    const t = extractTestCommand(part, repoRoot);
    if (!t) return undefined;
    const full = extractTestCommand(cmd, repoRoot);
    return full?.endsWith(t) ? full : t;
  };
  const sampleOf = (text: string | undefined) => {
    const l = firstErrorLine(text);
    return l ? { sample: l } : {};
  };
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const p = e.payload as Record<string, unknown>;
    if (e.kind === "file.change") {
      edited = true;
      continue;
    }
    if (e.kind === "tool.start") {
      if (typeof p.toolUseId === "string") starts.set(p.toolUseId, e);
      const tool = typeof p.tool === "string" ? p.tool : "";
      if (/^(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch|str_replace|create_file|edit_file|write_file)$/i.test(tool)) edited = true;
      continue;
    }
    if (e.kind === "tool.end") {
      const id = typeof p.toolUseId === "string" ? p.toolUseId : undefined;
      const start = id ? starts.get(id) : undefined;
      const tool = (typeof p.tool === "string" ? p.tool : undefined) ?? (typeof start?.payload.tool === "string" ? (start.payload.tool as string) : "?");
      const cmd = commandOf(start?.payload.input ?? p.input);
      const text = outputText(e);
      if (cmd) lastCmd = { cmd, ...(id ? { id } : {}), ...(text ? { output: text } : {}) };
      if (p.ok !== false) continue;
      if (cmd) {
        // A test command whose run reported failures failed; otherwise find the part that did.
        const tests = id && failedTests.has(id) ? extractTestCommand(cmd, repoRoot) : undefined;
        const part = tests ? undefined : failingPart(cmd, { output: text ?? "", ...(exitCodeOf(p.exitCode, text) !== undefined ? { exitCode: exitCodeOf(p.exitCode, text)! } : {}) });
        const partText = part?.argv.join(" ");
        const label = tests ?? (partText ? (testLabel(cmd, partText) ?? commandHead(partText)) : undefined);
        if (label) out.push({ key: `cmd:${label}`, label, ...sampleOf(text), tests: false, beforeEdits: !edited });
        else out.push({ key: `compound:${errorKey(text)}`, label: COMPOUND, ...sampleOf(text), tests: false, beforeEdits: !edited });
      } else {
        const k = errorKey(text);
        out.push({ key: `tool:${tool}:${k}`, label: tool, ...sampleOf(text), tests: false, beforeEdits: !edited });
      }
      continue;
    }
    if (e.kind === "test.result" && typeof p.failed === "number" && p.failed > 0) {
      const id = typeof p.toolUseId === "string" ? p.toolUseId : undefined;
      const started = id ? commandOf(starts.get(id)?.payload.input) : undefined;
      const src = started ?? lastCmd?.cmd;
      const output = !id || lastCmd?.id === id ? lastCmd?.output : undefined;
      const part = src && !extractTestCommand(src, repoRoot) ? failingPart(src, { output: output ?? "" }) : undefined;
      // A test summary in what plumbing printed (`cat test.log`, `sleep 60 && tail out.log`) is not a test run.
      const label = src ? (extractTestCommand(src, repoRoot) ?? (part && !isPlumbing(part.prog) ? commandHead(part.argv.join(" ")) : undefined)) : undefined;
      if (!label) continue;
      // A failing test run that the tool call already reported as an error is one failure, not two.
      const key = `cmd:${label}`;
      const prev = out.at(-1);
      if (prev && prev.key === key && !prev.tests) {
        prev.tests = true;
        continue;
      }
      out.push({ key, label, ...sampleOf(output), tests: true, beforeEdits: !edited });
    }
  }
  return out;
}

// ---------------------------------------------------------------- ranking

const byNewest = (a: Session, b: Session) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1);
const example = (s: Session): IssueExample => ({ sessionId: s.id, startedAt: s.startedAt, ...(s.title ? { title: s.title } : {}) });

/**
 * The issues in `sessions`: those seen in two or more sessions first, then by
 * severity, most severe first. `failures` maps a session id to
 * its failure records (sessions without an entry had none or were not read).
 */
export function rankIssues(sessions: readonly Session[], failures: ReadonlyMap<string, readonly FailureRecord[]>, opts: { testCommand?: string; maxExamples?: number } = {}): Issue[] {
  const analyzed = sessions.length;
  const maxEx = opts.maxExamples ?? 3;
  const testCmd = opts.testCommand;
  const out: Issue[] = [];
  for (const f of flagFindings(sessions, { maxExamples: sessions.length })) {
    const t = FLAG_TEXT[f.flag];
    out.push({
      id: f.id,
      kind: "flag",
      title: t?.title ?? `Sessions flagged ${f.flag}`,
      sessions: f.support.sessions,
      analyzed,
      severity: { score: f.diagnosis.severity.score, level: f.diagnosis.severity.level },
      examples: f.examples.slice(0, maxEx).map((x) => ({ sessionId: x.sessionId, startedAt: x.startedAt, ...(x.title ? { title: x.title } : {}) })),
      sessionIds: f.examples.map((x) => x.sessionId),
      fix: t?.fix ?? `Open an example and look for what the ${f.flag} flag points at.`,
      ...(t?.rule ? { rule: t.rule(testCmd) } : {}),
      ...(t?.behavior ? { behavior: t.behavior } : {}),
    });
  }

  const byKey = new Map<string, { label: string; sample?: string; tests: boolean; sessions: Session[]; before: number; count: number }>();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const [id, recs] of failures) {
    const s = byId.get(id);
    if (!s) continue;
    const seen = new Set<string>();
    for (const r of recs) {
      const g = byKey.get(r.key) ?? { label: r.label, tests: false, sessions: [], before: 0, count: 0 };
      g.count++;
      if (r.tests) g.tests = true;
      if (!g.sample && r.sample) g.sample = r.sample;
      if (!seen.has(r.key)) {
        seen.add(r.key);
        g.sessions.push(s);
        if (r.beforeEdits) g.before++;
      }
      byKey.set(r.key, g);
    }
  }
  for (const [key, g] of byKey) {
    if (g.sessions.length < 2) continue;
    const setup = g.tests && g.before >= 2;
    const part = natureScore(setup ? { nature: "defect", factor: 40, affected: g.sessions.length, analyzed } : { nature: "inefficiency", factor: g.count >= 6 ? 40 : 25, affected: g.sessions.length, analyzed });
    const sev = signalSeverity([part]);
    const compound = key.startsWith("compound:");
    const what = key.startsWith("cmd:") ? `\`${g.label}\`` : compound ? `A ${COMPOUND}` : g.label;
    out.push({
      id: `fails:${key}`,
      kind: "failure",
      title: setup ? `${what} already fails before the agent changes anything` : `${what} fails the same way in several sessions`,
      sessions: g.sessions.length,
      analyzed,
      severity: { score: sev.score, level: sev.level },
      examples: [...g.sessions].sort(byNewest).slice(0, maxEx).map(example),
      sessionIds: [...g.sessions].sort(byNewest).map((x) => x.id),
      fix: setup
        ? `Fix ${what} so it passes on a clean checkout, or tell the agent the command that works. Until then the agent can't check its work.`
        : key.startsWith("cmd:")
          ? `Fix ${what}, or tell the agent in AGENTS.md what to run instead.`
          : compound
            ? "Open an example: the error doesn't say which part of the command failed, so run its parts one at a time."
            : `Look at an example: tell the agent how to use ${g.label}, or why it fails.`,
      ...(compound ? {} : { command: g.label }),
      ...(g.sample ? { sample: clip(g.sample, 160)! } : {}),
      beforeEdits: g.before,
    });
  }
  const cache = cacheIssue(sessions, maxEx);
  if (cache) out.push(cache);
  // Something that happened in two or more sessions is a habit a line can change; a one-off goes after every habit.
  const recurring = (i: Issue) => (i.sessions >= 2 ? 1 : 0);
  out.sort((a, b) => recurring(b) - recurring(a) || b.severity.score - a.severity.score || b.sessions - a.sessions || (a.id < b.id ? -1 : 1));
  return out;
}

/** Cache breaks are listed from this many extra dollars, in two or more sessions. */
export const CACHE_ISSUE_MIN_USD = 1;

/** Waste points (FACTOR_POINTS) for cache breaks costing this share of the spend: under 2% small, from 50% severe. */
export function cacheFactor(share: number): number {
  return share >= 0.5 ? 85 : share >= 0.25 ? 65 : share >= 0.1 ? 40 : share >= 0.02 ? 25 : 10;
}

const usdText = (n: number): string => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;

/**
 * The cost of lost prompt cache, from what ingest already stored per session
 * (Session.stats.cacheBreaks: count, extraUsd, byCause); nothing is recomputed.
 * Its severity comes from dollars: the extra USD as a share of the sessions'
 * spend sets the waste factor, so it ranks against the other issues by what it costs.
 */
export function cacheIssue(sessions: readonly Session[], maxExamples = 3): Issue | undefined {
  const usd = (s: Session) => s.stats.cacheBreaks?.extraUsd ?? 0;
  const hit = sessions.filter((s) => usd(s) > 0).sort((a, b) => usd(b) - usd(a) || byNewest(a, b));
  const extra = hit.reduce((n, s) => n + usd(s), 0);
  if (hit.length < 2 || extra < CACHE_ISSUE_MIN_USD) return undefined;
  const spend = sessions.reduce((n, s) => n + (s.stats.usage?.costUsd ?? 0), 0);
  // With no spend recorded the share is unknown: material waste (25), as a repeated failure.
  const share = spend > 0 ? Math.min(1, extra / spend) : undefined;
  const sev = signalSeverity([natureScore({ nature: "inefficiency", factor: share === undefined ? 25 : cacheFactor(share), affected: hit.length, analyzed: sessions.length })]);
  const by = new Map<CacheBreakCause, { breaks: number; usd: number }>();
  let breaks = 0;
  for (const s of sessions) {
    const cb = s.stats.cacheBreaks;
    if (!cb) continue;
    breaks += cb.count;
    for (const [c, v] of Object.entries(cb.byCause) as [CacheBreakCause, { count: number; extraUsd?: number } | undefined][]) {
      if (!v || !(c in CACHE_BREAK_FIX)) continue;
      const g = by.get(c) ?? { breaks: 0, usd: 0 };
      g.breaks += v.count;
      g.usd += v.extraUsd ?? 0;
      by.set(c, g);
    }
  }
  const causes: CacheCause[] = [...by]
    .map(([cause, g]) => ({ cause, breaks: g.breaks, usd: Math.round(g.usd * 100) / 100, fix: CACHE_BREAK_FIX[cause] }))
    .sort((a, b) => b.usd - a.usd || b.breaks - a.breaks || (a.cause < b.cause ? -1 : 1));
  const top = causes[0];
  return {
    id: "cost:cache-breaks",
    kind: "cost",
    title: `Pays ${usdText(extra)} again for prompt cache it lost (${breaks} cache ${breaks === 1 ? "break" : "breaks"}${share === undefined ? "" : `, ${share < 0.01 ? "under 1" : Math.round(share * 100)}% of the spend`})`,
    sessions: hit.length,
    analyzed: sessions.length,
    severity: { score: sev.score, level: sev.level },
    examples: hit.slice(0, maxExamples).map(example),
    sessionIds: hit.map((x) => x.id),
    fix: top ? `Keep the cache warm, costliest cause first. ${top.cause}: ${top.fix}.` : "Keep the prompt prefix stable between turns.",
    usd: Math.round(extra * 100) / 100,
    causes,
  };
}
