// The docs table of contents: one ordered list drives the sidebar, the mobile
// menu, prev/next links and the Docs section of /llms.txt.

import { existsSync } from "node:fs";
import { join } from "node:path";

// Build-time only (Astro frontmatter, llms.txt, scripts/gen-og.mjs), all run from apps/site.
const HAS_MCP_PAGE = existsSync(join(process.cwd(), "src/pages/docs/mcp.astro"));

export interface DocPage {
  path: string;
  /** Sidebar label. */
  label: string;
  /** <h1>, and <title> as "<title> · coding.sh docs" unless metaTitle is set. */
  title: string;
  /** The whole <title> (at most 60 characters), when the default form is too long or misses the words people search for. */
  metaTitle?: string;
  /** One sentence (at most 155 characters) for meta description, llms.txt and the docs index. */
  summary: string;
}

export interface DocGroup {
  label: string;
  pages: DocPage[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    label: "Start",
    pages: [
      {
        path: "/docs",
        label: "Overview",
        title: "coding.sh docs",
        summary: "Docs for coding.sh, open-source observability and evals for AI agents: what is built today, what is planned, and where to start.",
      },
      {
        path: "/docs/install",
        label: "Install",
        title: "Install",
        metaTitle: "Install coding.sh: one line, npm or from source",
        summary: "Install coding.sh with one line, or with npm or from source; check it with doctor and remove it cleanly.",
      },
      {
        path: "/docs/quickstart",
        label: "Quickstart",
        title: "Quickstart",
        metaTitle: "Quickstart: record Claude Code and Codex sessions",
        summary: "Record Claude Code, Codex and other coding agents with no code changes, then list, inspect and search their sessions.",
      },
      { path: "/docs/how-to/trace-your-agent", label: "Your own agent", title: "Trace your own agent", summary: "Record an agent you built with OpenTelemetry or the TypeScript and Python SDKs, then run evals on it and compare versions." },
      { path: "/docs/concepts", label: "Concepts", title: "Concepts", summary: "Sessions, events, turns, flags, datasets, experiments, graders, judges and benchmarks, each in a sentence or two." },
    ],
  },
  {
    // One page per job people search for; each sends the reader on to the how-to or guide.
    label: "Use cases",
    pages: [
      { path: "/docs/use-cases/claude-code-cost", label: "Track agent cost", title: "Track Claude Code and Codex cost per session", metaTitle: "Claude Code cost tracking, per session and repo · coding.sh", summary: "Track Claude Code and Codex token usage and cost per session, repo and model, locally. Estimates from tokens × list price are marked ~." },
      { path: "/docs/use-cases/replay-agent-session", label: "Replay a session", title: "Replay a Claude Code or Codex session step by step", metaTitle: "Replay a Claude Code or Codex session step by step", summary: "Replay Claude Code and Codex sessions step by step: commands, output and diffs, from your local session history. Nothing is re-run." },
      { path: "/docs/use-cases/test-agent-instructions", label: "Test CLAUDE.md and skills", title: "Test a CLAUDE.md, AGENTS.md or skill change", metaTitle: "Test a CLAUDE.md, AGENTS.md or skill change · coding.sh", summary: "Test a CLAUDE.md, AGENTS.md or skill change on your own sessions and get a Ship it, Hold or Don't ship verdict." },
      { path: "/docs/use-cases/evals-from-failures", label: "Evals from failures", title: "Build evals from your agent's failures", metaTitle: "Build coding agent evals from real failures · coding.sh", summary: "Turn your coding agent's failed sessions into an eval suite: one task per session, checked by your verifier, run with eval run." },
      { path: "/docs/use-cases/self-hosted-observability", label: "Self-hosted observability", title: "Open-source, self-hosted LLM observability", metaTitle: "Open-source, self-hosted LLM observability · coding.sh", summary: "Open-source, self-hosted LLM observability: one coding.sh serve takes OpenTelemetry traces and SDK events, on SQLite, Postgres or ClickHouse." },
      { path: "/docs/use-cases/proxy-model-calls", label: "Log model calls", title: "Log every model call your agent makes", metaTitle: "Log every LLM call your agent makes, with a local proxy", summary: "Log every LLM call Claude Code or Codex makes with a local proxy: full prompts, cache use and cost, and why the prompt cache missed." },
    ],
  },
  {
    label: "Record",
    pages: [
      {
        path: "/docs/otel",
        label: "OpenTelemetry",
        title: "Record any agent with OpenTelemetry",
        metaTitle: "OpenTelemetry for AI agents: a local OTLP receiver",
        summary: "Point the Vercel AI SDK, Claude Agent SDK, OpenAI Agents SDK, LangGraph or any OTLP exporter at the local receiver.",
      },
      { path: "/docs/how-to/capture-with-proxy", label: "Model API proxy", title: "Capture every model call with the proxy", summary: "Route Claude Code, Codex or any client through a local Anthropic/OpenAI proxy to log every call, see why the prompt cache missed, and replay a call." },
      { path: "/docs/how-to/trace-durable-workflow", label: "Durable workflows", title: "Trace a durable workflow", summary: "Record a Vercel Workflow or Temporal run as one session across crashes, deploys and days, with each step's attempts, waits and resume points." },
      { path: "/docs/ai-gateway", label: "Gateways", title: "LLM gateways", metaTitle: "LLM gateways: OpenRouter, LiteLLM, Vercel AI Gateway", summary: "Agents behind Vercel AI Gateway, OpenRouter, LiteLLM, Portkey, Helicone and others: tagged sessions, billed cost per call, and A/B runs across models." },
      { path: "/docs/production", label: "Production", title: "Production: API apps", summary: "Run coding.sh serve on SQLite or Postgres and send traces from API apps with the SDKs or OpenTelemetry." },
      {
        path: "/docs/agents",
        label: "Coding agents",
        title: "Coding agents",
        metaTitle: "Supported coding agents: Claude Code, Codex, Cursor, more",
        summary: "Which coding agents have adapters, how each is captured, and how subagents are linked to their parent session.",
      },
      // Listed once src/pages/docs/mcp.astro exists (another workflow writes it).
      ...(HAS_MCP_PAGE
        ? [
            {
              path: "/docs/mcp",
              label: "MCP server",
              title: "MCP server",
              metaTitle: "MCP server: let your agent query its own traces",
              summary: "Let your agent query its own sessions, failures, latency and usage over MCP; init registers the server for you.",
            },
          ]
        : []),
    ],
  },
  {
    label: "Evaluate",
    pages: [
      {
        path: "/docs/evals",
        label: "Evals",
        title: "Evals",
        metaTitle: "Evals for AI agents and coding agents · coding.sh docs",
        summary: "Your first eval suite in minutes with eval init and eval run, then datasets, graders, calibrated LLM judges, paired comparisons and repo-replay tasks.",
      },
      { path: "/docs/benchmarks", label: "Benchmarks", title: "Benchmarks", summary: "coding.sh bench: fresh cases every day from a live source, every contender on the same frozen set, and a history of who leads." },
      { path: "/docs/workflows", label: "Workflows", title: "Workflow experiments", summary: "Capture multi-agent workflow runs, score them against known answers, compare two versions with paired statistics, and replay with a control fork." },
      {
        path: "/docs/tool-evals",
        label: "Tool evals",
        title: "Tool evals (planned)",
        summary: "The design for measuring how well agents use a CLI, MCP server or HTTP API. Not implemented yet.",
      },
    ],
  },
  {
    label: "How-to",
    pages: [
      { path: "/docs/how-to/test-claude-md-change", label: "Test a CLAUDE.md change", title: "Test a CLAUDE.md change in five minutes", summary: "Replay the moments your agent went wrong with your committed CLAUDE.md and with your edit, and get a ship-or-hold verdict before you commit." },
      { path: "/docs/how-to/compare-agents", label: "Compare two agents", title: "Compare two agents on your repo", summary: "Turn a real task into a checked eval, snapshot two agent setups, and run both on it with a paired comparison." },
      { path: "/docs/how-to/ci-regressions", label: "Catch regressions in CI", title: "Catch a regression in CI", summary: "Run the same eval on the base branch and the pull request in GitHub Actions, and fail the job when a case regresses." },
      { path: "/docs/how-to/expensive-sessions", label: "Find expensive sessions", title: "Find your most expensive sessions", metaTitle: "Find your most expensive Claude Code and Codex sessions", summary: "Rank sessions by cost or tokens, break spend down by repo, agent and model, and see where cost data comes from." },
      { path: "/docs/how-to/evaluate-a-skill", label: "Evaluate a skill", title: "Evaluate an Agent Skill", summary: "Run the same behaviour tasks with and without a skill, grade each run with checks and a judge, and read a ship-or-hold answer." },
      { path: "/docs/how-to/session-to-eval", label: "Session to eval", title: "Turn a real session into an eval", summary: "Keep a captured session as a validated repo task or a dataset case, so later changes are tested against it." },
      { path: "/docs/how-to/self-host-team", label: "Self-host for a team", title: "Self-host for a team", summary: "Run one container, connect each machine with coding.sh init --remote, and open the team viewer." },
      { path: "/docs/perf", label: "Measure site speed", title: "Site speed", summary: "How we made coding.sh load faster on slow phones, measured with coding.sh exp metrics, and the command to measure your own site." },
    ],
  },
  {
    // Bodies in docs/compare/: checked against each tool's own docs, with sources.
    label: "Compare",
    pages: [
      { path: "/docs/compare", label: "Overview", title: "coding.sh compared with other tools", metaTitle: "coding.sh vs Langfuse, LangSmith, Braintrust and others", summary: "How coding.sh compares with Langfuse, LangSmith, Braintrust, AgentOps, Laminar and ccusage, and when each of them is the better choice." },
      { path: "/docs/compare/langfuse", label: "vs Langfuse", title: "coding.sh vs Langfuse", metaTitle: "coding.sh vs Langfuse: open-source agent observability", summary: "Langfuse is an open-source LLM platform, hosted or self-hosted; coding.sh is a local CLI for coding agents and evals. A feature table and where each wins." },
      { path: "/docs/compare/langsmith", label: "vs LangSmith", title: "coding.sh vs LangSmith", metaTitle: "coding.sh vs LangSmith: an open-source, self-hosted option", summary: "LangSmith is a hosted platform; coding.sh is MIT licensed and runs on your machine. A feature table, and where each one is the better choice." },
      { path: "/docs/compare/braintrust", label: "vs Braintrust", title: "coding.sh vs Braintrust", metaTitle: "coding.sh vs Braintrust: open-source agent evals", summary: "Braintrust is a hosted eval platform; coding.sh runs evals locally with paired statistics. A feature table, and where each one is the better choice." },
      { path: "/docs/compare/agentops", label: "vs AgentOps", title: "coding.sh vs AgentOps", metaTitle: "coding.sh vs AgentOps: agent observability compared", summary: "AgentOps instruments Python agent frameworks; coding.sh captures coding agents and runs evals, locally. A feature table and where each is better." },
      { path: "/docs/compare/laminar", label: "vs Laminar", title: "coding.sh vs Laminar", metaTitle: "coding.sh vs Laminar: AI agent tracing compared", summary: "Laminar is open-source agent observability with a cloud; coding.sh is a local CLI for coding agents and evals. A feature table and where each is better." },
      { path: "/docs/compare/ccusage", label: "vs ccusage", title: "coding.sh vs ccusage", metaTitle: "ccusage alternative: cost, replay and evals · coding.sh", summary: "ccusage reports coding-agent token cost from local logs; coding.sh adds each session's steps, replay, flags and evals. Where each is the better choice." },
    ],
  },
  {
    label: "Reference",
    pages: [
      {
        path: "/docs/cli",
        label: "CLI",
        title: "CLI reference",
        summary: "Every coding.sh command and option, generated from the CLI's own --help output at build time.",
      },
      { path: "/docs/sdk", label: "SDKs", title: "SDK reference", summary: "Every function and option in the TypeScript and Python SDKs, generated from their source." },
      { path: "/docs/api", label: "REST API", title: "REST API reference", summary: "Every route coding.sh serve answers: ingest, OTLP, the read API, health and metrics, with auth and examples." },
      { path: "/docs/config", label: "Configuration", title: "Configuration reference", summary: "Every config.toml key and environment variable, their defaults, and which layer wins." },
      {
        path: "/docs/storage",
        label: "Storage",
        title: "Storage",
        summary: "The SQLite index, the content-addressed blob store, sinks, and how to plug in a remote store.",
      },
      {
        path: "/docs/trace-format",
        label: "Trace format",
        title: "Trace format",
        summary: "The coding.sh/trace v0 event format every adapter and the OTLP receiver normalize into.",
      },
      { path: "/docs/troubleshooting", label: "Troubleshooting", title: "Troubleshooting", summary: "What doctor checks, why sessions go missing, and every CLI error reason with its fix." },
      {
        path: "/docs/faq",
        label: "FAQ",
        title: "FAQ",
        metaTitle: "coding.sh FAQ: privacy, performance and alternatives",
        summary: "Privacy, performance, status, and how coding.sh relates to hosted tracing tools.",
      },
    ],
  },
];

export const DOC_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages);

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function docPage(path: string): DocPage {
  const page = DOC_PAGES.find((p) => p.path === norm(path));
  if (!page) throw new Error(`docs: ${path} is missing from src/components/docs/nav.ts`);
  return page;
}

export function neighbours(path: string): { prev?: DocPage; next?: DocPage } {
  const i = DOC_PAGES.findIndex((p) => p.path === norm(path));
  return { prev: i > 0 ? DOC_PAGES[i - 1] : undefined, next: i >= 0 ? DOC_PAGES[i + 1] : undefined };
}
