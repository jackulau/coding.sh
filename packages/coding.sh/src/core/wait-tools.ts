/** What a waiting tool's duration belongs to: the user, a subagent, or a timer. */
export type WaitKind = "human" | "subagent" | "wait";

// Tools whose duration is someone else's time: the user answering, a subagent
// working, or an explicit wait. Keyed by lowercase name (MCP prefix stripped).
const WAIT_TOOLS: Record<string, WaitKind> = {
  askuserquestion: "human",
  ask_user_question: "human",
  ask_user: "human",
  ask_followup_question: "human",
  request_user_input: "human",
  request_user_input_async: "human",
  // T3 Code's secret card (mcp__t3-code__request_secret): open until the user pastes the value.
  request_secret: "human",
  exitplanmode: "human",
  exit_plan_mode: "human",
  task: "subagent",
  agent: "subagent",
  wait_agent: "subagent",
  wait: "wait",
  sleep: "wait",
  monitor: "wait",
  taskoutput: "wait",
};

/** Whether a tool's duration is waiting (on the user, a subagent, a timer) rather than tool latency. */
export function waitKind(tool: string): WaitKind | undefined {
  const t = tool.toLowerCase();
  return WAIT_TOOLS[t] ?? WAIT_TOOLS[t.replace(/^mcp__.*__/, "")];
}
