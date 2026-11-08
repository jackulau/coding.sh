// What the verifier printed, kept on each run so a failure can be read without
// running it again: the end of stdout and stderr, colour codes and progress
// redraws removed, redacted, then trimmed to the last VERIFIER_OUTPUT_CHARS.
// Redaction runs before the trim, so the trim can't cut a secret down to a
// fragment the redactor no longer recognises.
import { createRedactor, type Redactor } from "../core/redact.ts";
import type { RunResult, VerifierOutput } from "../core/types.ts";

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
}

/** Runs whose verifier failed or never passed, oldest first; cancelled, superseded and infrastructure-failed runs are left out. */
export function failedRuns(runs: readonly RunResult[]): FailedRun[] {
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
    }));
}

/**
 * The human report's block for failed runs: up to `max` of them, each with the
 * last `lines` lines of its verifier output. Empty when no failed run kept any.
 */
export function renderFailedRuns(
  failed: readonly FailedRun[],
  o: { names?: (taskId: string) => string; arm?: (bundleId: string) => string; max?: number; lines?: number; dim?: (s: string) => string } = {},
): string[] {
  const withOutput = failed.filter((f) => f.verifierOutput);
  if (!withOutput.length) return [];
  const max = o.max ?? 5;
  const lines = o.lines ?? 8;
  const dim = o.dim ?? ((s: string) => s);
  const out = [`Verifier output of failed runs (last ${lines} lines):`];
  for (const f of withOutput.slice(0, max)) {
    const who = [o.names?.(f.taskId) ?? f.taskId, o.arm?.(f.bundleId), `attempt ${f.attempt}`].filter(Boolean).join(" · ");
    out.push(`  ${who}  ${dim(`exit ${f.verifierExit ?? "-"} · ${f.runId}`)}`);
    for (const l of outputTail(f.verifierOutput, lines)) out.push(`    ${dim("│")} ${l}`);
  }
  if (withOutput.length > max) out.push(dim(`  … ${withOutput.length - max} more failed run(s); --json lists every one with its output`));
  return out;
}
