// Pages that moved: old path to new path. The worker answers the old path with a
// 301, so old links keep working and search engines follow the move. A target
// is a page in the docs nav (no #anchor); no built docs page links an old path.
export const MOVED: Record<string, string> = {
  "/docs/how-to/test-claude-md-change": "/docs/how-to/test-agents-md-change",
  // 2026-11-11: the docs regrouped by task; use-case pages merged into the page for the task.
  "/docs/use-cases/claude-code-cost": "/docs/cost",
  "/docs/how-to/expensive-sessions": "/docs/cost",
  "/docs/use-cases/test-agent-instructions": "/docs/how-to/test-agents-md-change",
  "/docs/use-cases/evals-from-failures": "/docs/how-to/session-to-eval",
  "/docs/use-cases/self-hosted-observability": "/docs/production",
  "/docs/use-cases/t3-code": "/docs/agents",
  "/docs/use-cases/pi": "/docs/agents",
  "/docs/use-cases/proxy-model-calls": "/docs/how-to/capture-with-proxy",
  "/docs/perf": "/docs/experiments",
};
