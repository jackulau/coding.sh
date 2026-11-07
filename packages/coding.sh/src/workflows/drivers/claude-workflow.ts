// `claude-code-workflow` driver (docs/design/workflows.md §6):
//   claude -p --output-format json [--settings <otel+hooks>] \
//     "Run the workflow script at <path> with args <json>. Return its result as JSON and nothing else."
// The run is found afterwards from the host session id Claude prints: the
// newest run dir under <projects>/*/<session id>/subagents/workflows/.
//
// (U) Whether the Workflow tool is available in -p mode is unconfirmed; if it
// is not, run variants from an interactive session instead. Tests drive this
// with a fake `claude` binary only.
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { commandEnv, execFileTail } from "../../runner/exec.ts";
import { claudeProjectsDir } from "../import.ts";
import { findClaudeWorkflowDirs, loadClaudeWorkflowDir } from "../sources/claude-workflow.ts";
import type { WorkflowCase, WorkflowDriver, WorkflowDriverResult, WorkflowVariant } from "../types.ts";
import { mergeArgs, parseOutput } from "./command.ts";

export interface ClaudeWorkflowDriverOpts {
  /** claude binary (default "claude" on PATH). */
  bin?: string;
  /** --settings file wiring OTel export and coding.sh hooks for the run. */
  settings?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Env for locating CLAUDE_CONFIG_DIR / HOME (default process.env). */
  env?: NodeJS.ProcessEnv;
  concurrencyCap?: number;
}

export function workflowPrompt(script: string, args: unknown, resumeFromRunId?: string): string {
  const resume = resumeFromRunId ? ` Resume from run ${resumeFromRunId} (resumeFromRunId: ${JSON.stringify(resumeFromRunId)}).` : "";
  return `Run the workflow script at ${script} with args ${JSON.stringify(args)}.${resume} Return its result as JSON and nothing else.`;
}

export function claudeArgv(v: WorkflowVariant, c: WorkflowCase, o: Pick<ClaudeWorkflowDriverOpts, "settings" | "cwd"> = {}): string[] {
  if (!v.script) throw new Error(`variant ${JSON.stringify(v.name)} has no script`);
  const script = resolve(o.cwd ?? process.cwd(), v.script);
  return ["-p", "--output-format", "json", ...(o.settings ? ["--settings", o.settings] : []), workflowPrompt(script, mergeArgs(c.args, v.args), v.resumeFromRunId)];
}

export function claudeWorkflowDriver(o: ClaudeWorkflowDriverOpts = {}): WorkflowDriver {
  return {
    id: "claude-code-workflow",
    async run(v: WorkflowVariant, c: WorkflowCase, env: Record<string, string>): Promise<WorkflowDriverResult> {
      const startedAt = Date.now();
      const r = await execFileTail(o.bin ?? "claude", claudeArgv(v, c, o), {
        cwd: o.cwd ?? process.cwd(),
        env: commandEnv(env),
        timeoutMs: o.timeoutMs ?? 2 * 60 * 60_000,
        tailBytes: 32 * 1024 * 1024,
      });
      const endedAt = Date.now();
      const printed = parseOutput(r.stdoutTail);
      const doc = printed && typeof printed === "object" && !Array.isArray(printed) ? (printed as Record<string, unknown>) : {};
      const sessionId = typeof doc.session_id === "string" ? doc.session_id : undefined;
      const output = typeof doc.result === "string" ? parseOutput(doc.result) : (doc.result ?? printed);
      const res: WorkflowDriverResult = { runId: env.CODING_SH_WORKFLOW_RUN_ID ?? "", output, exitCode: r.exitCode, startedAt, endedAt };
      if (r.timedOut) res.error = "timed out";
      else if (r.exitCode !== 0 || doc.is_error === true) res.error = r.stderrTail.trim().split("\n").slice(-3).join("\n") || `exit ${r.exitCode}`;
      if (sessionId) {
        const dirs = (await findClaudeWorkflowDirs(claudeProjectsDir({ ...(o.env ?? process.env), ...env }))).filter((d) => d.hostSessionId === sessionId);
        let best: { d: (typeof dirs)[number]; m: number } | undefined;
        for (const d of dirs) {
          try {
            const m = (await stat(join(d.runDir, "journal.jsonl"))).mtimeMs;
            if (!best || m > best.m) best = { d, m };
          } catch {
            // vanished
          }
        }
        if (best) {
          const loaded = await loadClaudeWorkflowDir(best.d, o.concurrencyCap !== undefined ? { concurrencyCap: o.concurrencyCap } : {});
          res.runId = loaded.sources.runId ?? best.d.runId;
          res.sources = loaded.sources;
        }
      }
      return res;
    },
  };
}
