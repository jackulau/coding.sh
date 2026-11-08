// What to fix first: the problems in a repo's recent sessions, ranked, each
// with a fix to try and the command that tests it.
//
// Two sources, scored on the same deterministic severity scale as refine's
// findings (src/refine/severity.ts), so the order never depends on a model:
//
//   flags     every diagnosed failure flag (src/refine/findings.ts)
//   failures  one command or tool failing the same way in two or more
//             sessions: a broken `npm test`, a missing script, an Edit that
//             never matches. A test command that already failed before the
//             agent changed anything is a defect of the setup (factor 40);
//             any other repeat is waste (25, or 40 from 6 failures up).
//
// Pure: the caller loads sessions and their failure records (failureRecords).
import type { AgentEvent, Session } from "../schema/index.ts";
import { commandOf } from "../core/sessions.ts";
import { flagFindings } from "../refine/findings.ts";
import { natureScore, signalSeverity, type SeverityLevel } from "../refine/severity.ts";
import { extractTestCommand } from "../eval/task.ts";

/** The decision-point kinds `exp ab --behavior` replays (src/eval/decision.ts). */
export type Behavior = "unverified-claim" | "done-while-failing" | "unchanged-retry";

export interface IssueExample {
  sessionId: string;
  startedAt: number;
  title?: string;
}

export interface Issue {
  /** `flag:<name>` or `fails:<key>`: stable across runs. */
  id: string;
  kind: "flag" | "failure";
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
}

/** One failed command or tool call in a session. */
export interface FailureRecord {
  /** Grouping key: the command's head (`npm test`, `npm run lint`) or the tool and its error. */
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
  rule?: (testCmd: string) => string;
  behavior?: Behavior;
}

const RETRY_RULE = "When a command fails, read the error and change something before you run it again.";

/** Plain words per diagnosed flag (src/refine/taxonomy.ts FLAG_DIAGNOSIS). */
export const FLAG_TEXT: Readonly<Record<string, FlagText>> = {
  "no-verification": {
    title: "Says it is done without running anything to check",
    fix: "Name the check in CLAUDE.md or AGENTS.md.",
    rule: (t) => `Run \`${t}\` before you say you are done, and say what it printed.`,
    behavior: "unverified-claim",
  },
  "premature-completion": {
    title: "Ends its turn while tests or checks fail",
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
    fix: "List the files that matter in CLAUDE.md or AGENTS.md, so the agent reads them once.",
  },
  churn: { title: "Edits the same lines back and forth", fix: "Ask for a plan before edits on tasks like these." },
  "no-progress": { title: "Works a long time without progress", fix: "Split tasks like these, or give the agent a check to aim at." },
  stalled: { title: "Waits on a slow or failing model provider", fix: "Check the provider or gateway; coding.sh usage --by model shows which model." },
  "context-thrash": { title: "Fills its context and compacts again and again", fix: "Split tasks like these, or trim what CLAUDE.md and skills load." },
  "skill-copy-conflict": { title: "Has two different copies of one skill", fix: "Delete the stale copy so the agent reads one." },
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

/** An error's first informative line, with numbers, hex ids and paths blurred, for grouping. */
export function errorKey(text: string | undefined): string {
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

const firstErrorLine = (text: string | undefined): string | undefined => {
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

/** The failed tool calls and failing test runs in one session's events (tool.start, tool.end, test.result, file.change). */
export function failureRecords(events: readonly AgentEvent[], repoRoot?: string): FailureRecord[] {
  const starts = new Map<string, AgentEvent>();
  const out: FailureRecord[] = [];
  let edited = false;
  let lastCmd: { label: string; output?: string } | undefined;
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
      const start = typeof p.toolUseId === "string" ? starts.get(p.toolUseId) : undefined;
      const tool = (typeof p.tool === "string" ? p.tool : undefined) ?? (typeof start?.payload.tool === "string" ? (start.payload.tool as string) : "?");
      const cmd = commandOf(start?.payload.input ?? p.input);
      const text = outputText(e);
      if (cmd) lastCmd = { label: extractTestCommand(cmd, repoRoot) ?? commandHead(cmd), ...(text ? { output: text } : {}) };
      if (p.ok !== false) continue;
      if (cmd) {
        const head = extractTestCommand(cmd, repoRoot) ?? commandHead(cmd);
        out.push({ key: `cmd:${head}`, label: head, ...(firstErrorLine(text) ? { sample: firstErrorLine(text)! } : {}), tests: false, beforeEdits: !edited });
      } else {
        const k = errorKey(text);
        out.push({ key: `tool:${tool}:${k}`, label: tool, ...(firstErrorLine(text) ? { sample: firstErrorLine(text)! } : {}), tests: false, beforeEdits: !edited });
      }
      continue;
    }
    if (e.kind === "test.result" && typeof p.failed === "number" && p.failed > 0 && lastCmd) {
      // A failing test run that the tool call already reported as an error is one failure, not two.
      const key = `cmd:${lastCmd.label}`;
      const prev = out.at(-1);
      if (prev && prev.key === key && !prev.tests) {
        prev.tests = true;
        continue;
      }
      out.push({ key, label: lastCmd.label, ...(firstErrorLine(lastCmd.output) ? { sample: firstErrorLine(lastCmd.output)! } : {}), tests: true, beforeEdits: !edited });
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
  const testCmd = opts.testCommand ?? "the tests";
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
    const what = key.startsWith("cmd:") ? `\`${g.label}\`` : g.label;
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
          ? `Fix ${what}, or tell the agent in CLAUDE.md or AGENTS.md what to run instead.`
          : `Look at an example: tell the agent how to use ${g.label}, or why it fails.`,
      command: g.label,
      ...(g.sample ? { sample: clip(g.sample, 160)! } : {}),
      beforeEdits: g.before,
    });
  }
  // Something that happened in two or more sessions is a habit a line can change; a one-off goes after every habit.
  const recurring = (i: Issue) => (i.sessions >= 2 ? 1 : 0);
  out.sort((a, b) => recurring(b) - recurring(a) || b.severity.score - a.severity.score || b.sessions - a.sessions || (a.id < b.id ? -1 : 1));
  return out;
}
