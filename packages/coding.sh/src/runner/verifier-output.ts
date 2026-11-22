// What the verifier printed, kept on each run so a failure can be read without
// running it again: the end of stdout and stderr, colour codes and progress
// redraws removed, redacted, then trimmed to the last VERIFIER_OUTPUT_CHARS.
// Redaction runs before the trim, so the trim can't cut a secret down to a
// fragment the redactor no longer recognises.
import { createRedactor, type Redactor } from "../core/redact.ts";
import type { RunResult, VerifierOutput } from "../core/types.ts";
import { infraKind, type InfraKind } from "../jobs/retry.ts";

/** The redactor capture uses (capture.redact and capture.redactPatterns), for the runs a command starts. */
export function captureRedactor(config: { capture: { redact: readonly string[]; redactPatterns: readonly string[] } }, env?: NodeJS.ProcessEnv): Redactor {
  return createRedactor({ redact: config.capture.redact, patterns: config.capture.redactPatterns, ...(env ? { env } : {}) });
}

/** Characters of each stream kept on a run, from the end. */
export const VERIFIER_OUTPUT_CHARS = 4096;

// CSI (colours, cursor moves) and OSC (titles, hyperlinks) escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** One stream: no escape codes, only the last redraw of a `\r` progress line, trailing blank lines dropped, the last `max` characters. */
export function cleanStream(s: string, redactor: Redactor, max = VERIFIER_OUTPUT_CHARS): string {
  const text = s
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const l = line.replace(/\r+$/, "");
      return l.slice(l.lastIndexOf("\r") + 1).trimEnd();
    })
    .join("\n")
    .replace(/^\n+|\s+$/g, "");
  const safe = redactor.string(text);
  if (safe.length <= max) return safe;
  let tail = safe.slice(safe.length - max);
  // Start on a whole line when one begins near the cut.
  const nl = tail.indexOf("\n");
  if (nl >= 0 && nl < 200) tail = tail.slice(nl + 1);
  return `…\n${tail}`;
}

/** The smallest tail runner/exec.ts keeps, in bytes. */
const EXEC_TAIL_BYTES = 8 * 1024;

/**
 * A tail that filled exec's buffer may start in the middle of a line, and of a
 * secret the redactor would then miss: its first line goes (or, with no line
 * break, its first 200 characters).
 */
function uncut(s: string): string {
  if (Buffer.byteLength(s) < EXEC_TAIL_BYTES) return s;
  const nl = s.indexOf("\n");
  return nl >= 0 ? s.slice(nl + 1) : s.slice(200);
}

/** The kept output of one verifier run; undefined when it printed nothing. */
export function verifierOutput(v: { stdoutTail: string; stderrTail: string }, redactor: Redactor = createRedactor()): VerifierOutput | undefined {
  const stdout = cleanStream(uncut(v.stdoutTail), redactor);
  const stderr = cleanStream(uncut(v.stderrTail), redactor);
  if (!stdout && !stderr) return undefined;
  return { ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) };
}

/** The last `lines` lines a failed run's verifier printed, stderr after stdout. */
export function outputTail(o: VerifierOutput | undefined, lines: number): string[] {
  if (!o) return [];
  const all = [o.stdout, o.stderr].filter((s): s is string => !!s).join("\n").split("\n");
  return all.slice(-lines);
}

/** A failed run as `compare --json` and `eval run --json` list it. */
export interface FailedRun {
  runId: string;
  taskId: string;
  bundleId: string;
  attempt: number;
  verifierExit: number | null;
  error?: string;
  sessionId?: string;
  verifierOutput?: VerifierOutput;
  /** The agent itself failed: it exited non-zero or timed out. `stderr` is the end of what it printed, cleaned and redacted. */
  agent?: { exitCode: number | null; timedOut?: true; stderr?: string };
}

/** Lines of an agent's stderr a failed run keeps. */
const AGENT_STDERR_LINES = 8;

/** Why the agent failed (non-zero exit or timeout), or undefined when it exited 0 or never ran. */
function agentFailure(a: RunResult["agent"] | undefined, redactor: Redactor): FailedRun["agent"] {
  if (!a || (!a.timedOut && (a.exitCode === 0 || a.exitCode === null || a.exitCode === undefined))) return undefined;
  const stderr = cleanStream(uncut(a.stderrTail ?? ""), redactor).split("\n").slice(-AGENT_STDERR_LINES).join("\n");
  return { exitCode: a.exitCode, ...(a.timedOut ? { timedOut: true as const } : {}), ...(stderr ? { stderr } : {}) };
}

/**
 * Runs whose verifier failed or never passed, oldest first; cancelled, superseded
 * and infrastructure-failed runs are left out. A run whose agent exited non-zero
 * or timed out says so, with the end of its stderr: an agent that can't start
 * fails every run in seconds, and the verifier's output alone doesn't say why.
 */
export function failedRuns(runs: readonly RunResult[], redactor: Redactor = createRedactor()): FailedRun[] {
  return runs
    .filter((r) => !r.pass && !r.cancelled && !r.superseded && !r.infra)
    .sort((a, b) => a.startedAt - b.startedAt || a.attempt - b.attempt)
    .map((r) => ({
      runId: r.id,
      taskId: r.taskId,
      bundleId: r.bundleId,
      attempt: r.attempt,
      verifierExit: r.verifierExit,
      ...(r.error ? { error: r.error } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.verifierOutput ? { verifierOutput: r.verifierOutput } : {}),
      ...withAgent(agentFailure(r.agent, redactor)),
    }));
}

const withAgent = (agent: FailedRun["agent"]): Pick<FailedRun, "agent"> => (agent ? { agent } : {});

/** How a reason starts for an infrastructure failure the run recorded no error for. */
const INFRA_REASON: Record<InfraKind, string> = {
  setup: "setup failed",
  auth: "agent login failed",
  "rate-limit": "rate limited",
  overloaded: "model API overloaded",
  server: "model API server error",
  network: "network error",
  tempfail: "temporary failure",
};

/** A line of agent output that names an error. */
const ERROR_WORD = /\b(?:error|errno|enoent|eacces|fatal|failed|refused|denied|not found|cannot|can't|unable)\b/i;

/** In a JSON line (stream-json output), the first string value `test` accepts; else the line. */
function saidIn(line: string, test: (s: string) => boolean): string {
  if (!line.startsWith("{")) return line;
  let found: string | undefined;
  try {
    JSON.parse(line, (_k, v: unknown) => {
      if (found === undefined && typeof v === "string" && test(v)) found = v;
      return v;
    });
  } catch {
    // not JSON
  }
  return found ?? line;
}

/**
 * Why a run failed, for the report's first-failure column: its error; for an
 * infrastructure failure without one, the kind and the line of the agent's
 * output the kind was read from; for an agent that exited non-zero, the exit
 * code and the last line of its stderr that names an error; else the
 * verifier's exit. Cleaned and redacted like the agent's stderr.
 */
export function runReason(r: RunResult, redactor: Redactor = createRedactor()): string | undefined {
  const error = r.error ? cleanStream(r.error, redactor) : "";
  if (error) return error;
  if (r.pass) return undefined;
  const a = r.agent as RunResult["agent"] | undefined;
  const lines = (s: string | undefined) => (s ? cleanStream(uncut(s), redactor).split("\n").map((l) => l.trim()).filter(Boolean) : []);
  if (r.infra) {
    const kind = r.infra;
    const line = [...lines(a?.stderrTail), ...lines(a?.stdoutTail)].findLast((l) => infraKind(l) === kind);
    return line ? `${INFRA_REASON[kind]}: ${saidIn(line, (s) => infraKind(s) === kind)}` : INFRA_REASON[kind];
  }
  if (a && !a.timedOut && a.exitCode) {
    const err = lines(a.stderrTail);
    const line = err.findLast((l) => ERROR_WORD.test(l)) ?? err.at(-1);
    return `agent exited ${a.exitCode}${line ? `: ${line}` : ""}`;
  }
  return r.verifierExit === null ? "verifier did not finish" : `verifier exit ${r.verifierExit}`;
}

/**
 * The human report's block for failed runs: up to `max` of them, each with why
 * its agent failed (when it did) and the last `lines` lines of its verifier
 * output. Empty when no failed run kept either.
 */
export function renderFailedRuns(
  failed: readonly FailedRun[],
  o: { names?: (taskId: string) => string; arm?: (bundleId: string) => string; max?: number; lines?: number; dim?: (s: string) => string } = {},
): string[] {
  const withOutput = failed.filter((f) => f.verifierOutput || f.agent);
  if (!withOutput.length) return [];
  const max = o.max ?? 5;
  const lines = o.lines ?? 8;
  const dim = o.dim ?? ((s: string) => s);
  const out = [withOutput.some((f) => f.verifierOutput) ? `Verifier output of failed runs (last ${lines} lines):` : "Failed runs:"];
  for (const f of withOutput.slice(0, max)) {
    const who = [o.names?.(f.taskId) ?? f.taskId, o.arm?.(f.bundleId), `attempt ${f.attempt}`].filter(Boolean).join(" · ");
    out.push(`  ${who}  ${dim(`exit ${f.verifierExit ?? "-"} · ${f.runId}`)}`);
    if (f.agent) {
      out.push(`    ${f.agent.timedOut ? "the agent timed out" : `the agent exited ${f.agent.exitCode}`}${f.agent.stderr ? ", its stderr ends:" : ""}`);
      for (const l of f.agent.stderr?.split("\n").slice(-lines) ?? []) out.push(`    ${dim("!")} ${l}`);
    }
    for (const l of outputTail(f.verifierOutput, lines)) out.push(`    ${dim("│")} ${l}`);
  }
  if (withOutput.length > max) out.push(dim(`  … ${withOutput.length - max} more failed run(s); --json lists every one with its output`));
  return out;
}
