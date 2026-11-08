// "next-action": a case-level tool-call check on one model turn. The case's
// `expected` is a calls spec (must, mustNot, max, order; see
// toolevals/calls.ts) over the tool calls in the task's output, so each case
// says what its own turn must and must not do. `coding.sh replay --fork
// --save-case` writes cases for it: the recorded failing action under mustNot.
import type { Grader } from "../datasets/types.ts";
import { callsSpecProblems, checkCalls, type CallsSpec, type ToolCall } from "../toolevals/calls.ts";

export interface NextActionGraderSpec {
  kind: "next-action";
  name?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The tool calls in a turn's output: `toolCalls: [{name, input}]` (request, continuation and replay tasks). */
export function turnCalls(output: unknown): ToolCall[] {
  const list = isObj(output) && Array.isArray(output.toolCalls) ? output.toolCalls : [];
  return list.filter(isObj).map((c) => ({ tool: String(c.name ?? c.tool ?? "?"), ...(isObj(c.input) ? { args: c.input } : {}) }));
}

export function nextActionGrader(spec: Omit<NextActionGraderSpec, "kind"> = {}): Grader {
  const name = spec.name ?? "next-action";
  return {
    id: name,
    kind: "next-action",
    version: "1",
    async grade(ctx) {
      const exp = isObj(ctx.expected) ? ctx.expected : undefined;
      const problems = exp ? callsSpecProblems(exp) : ["expected is missing"];
      if (problems.length) return { score: 0, pass: false, reason: `this case's expected is not a calls spec: ${problems.join("; ")}` };
      const calls = turnCalls(ctx.output);
      const r = checkCalls(exp as CallsSpec, calls);
      return { score: r.pass ? 1 : 0, pass: r.pass, reason: r.detail ?? (calls.length ? `${calls.map((c) => c.tool).join(", ")}, as expected` : "no tool call, as expected") };
    },
  };
}
