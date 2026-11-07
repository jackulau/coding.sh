// `command` driver (docs/WORKFLOWS.md §6): any program, e.g. a LangGraph or
// Mastra app. Called as `<cmd…> --args <json>` with CODING_SH_WORKFLOW_RUN_ID
// (and CODING_SH_RUN_ID) set; prints its output JSON on stdout. Its spans go
// to the receiver, tagged with the run id through the inherited env.
import { commandEnv, execFileTail } from "../../runner/exec.ts";
import type { TreeSources, WorkflowCase, WorkflowDriver, WorkflowDriverResult, WorkflowVariant } from "../types.ts";

export interface CommandDriverOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Finds the run's sources afterwards (e.g. receiver spans by run id). */
  collect?: (runId: string) => Promise<TreeSources | undefined>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Variant args layered over case args when both are objects; otherwise the variant's, else the case's. */
export function mergeArgs(caseArgs: unknown, variantArgs: unknown): unknown {
  if (isObj(caseArgs) && isObj(variantArgs)) return { ...caseArgs, ...variantArgs };
  return variantArgs ?? caseArgs ?? {};
}

/** The whole of stdout as JSON, else its last JSON line, else the trimmed text. */
export function parseOutput(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!) as unknown;
      } catch {
        // keep looking
      }
    }
    return t;
  }
}

export function commandDriver(o: CommandDriverOpts = {}): WorkflowDriver {
  return {
    id: "command",
    async run(v: WorkflowVariant, c: WorkflowCase, env: Record<string, string>): Promise<WorkflowDriverResult> {
      const argv = v.command ?? (v.script ? [process.execPath, v.script] : undefined);
      if (!argv?.length) throw new Error(`variant ${JSON.stringify(v.name)} has no command or script`);
      const runId = env.CODING_SH_WORKFLOW_RUN_ID ?? "";
      const startedAt = Date.now();
      const r = await execFileTail(argv[0]!, [...argv.slice(1), "--args", JSON.stringify(mergeArgs(c.args, v.args))], {
        cwd: o.cwd ?? process.cwd(),
        env: commandEnv(env),
        timeoutMs: o.timeoutMs ?? 60 * 60_000,
        tailBytes: 32 * 1024 * 1024,
      });
      const res: WorkflowDriverResult = { runId, output: parseOutput(r.stdoutTail), exitCode: r.exitCode, startedAt, endedAt: Date.now() };
      if (r.timedOut) res.error = "timed out";
      else if (r.exitCode !== 0) res.error = r.stderrTail.trim().split("\n").slice(-3).join("\n") || `exit ${r.exitCode}`;
      const sources = o.collect ? await o.collect(runId) : undefined;
      if (sources) res.sources = sources;
      return res;
    },
  };
}
