// The docs table of contents: one ordered list drives the sidebar, the mobile
// menu, prev/next links and the Docs section of /llms.txt. Groups follow what
// the reader is doing; pages for any AI agent come before coding-agent pages.

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
  /** Words readers type to find this page that its title misses. Search ranks them like a title (Search.astro). */
  searchTerms?: string[];
  /**
   * Sub pages: in DOC_PAGES (llms.txt, social cards, docPage(), redirect
   * targets) but not drawn in the sidebar, which highlights the parent
   * instead. Prev/next skip them.
   */
  children?: DocPage[];
}

export interface DocGroup {
  label: string;
  pages: DocPage[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    label: "Get started",
    pages: [
      {
        path: "/docs",
        label: "Overview",
        title: "Record your agents and test your changes",
        summary: "coding.sh saves every prompt, model call, tool call, file change and cost your AI agents make, on your machine.",
      },
      {
        path: "/docs/quickstart",
        label: "Quickstart",
        title: "Quickstart",
        metaTitle: "Quickstart: record your first AI agent run · coding.sh",
        summary: "Record your first run and open it in the viewer: your own agent in TypeScript or Python, or a coding agent like Claude Code or Codex, no code changes.",
      },
      {
        path: "/docs/install",
        label: "Install",
        title: "Install",
        metaTitle: "Install coding.sh with one line or with npm",
        summary: "Install coding.sh with one line or with npm, check it with doctor, and remove it cleanly.",
      },
      {
        path: "/docs/concepts",
        label: "Concepts",
        title: "Concepts",
        summary: "Sessions, turns, events and subagents; datasets, experiments, graders and judges. What each one is and where you see it.",
      },
    ],
  },
  {
    label: "Record",
    pages: [
      {
        path: "/docs/how-to/trace-your-agent",
        label: "Your agent (SDK)",
        title: "Trace your agent with the SDK",
        summary: "Wrap your OpenAI or Anthropic client, mark tool calls and conversations, and see each run in the viewer. TypeScript and Python.",
      },
      {
        path: "/docs/otel",
        label: "Frameworks (OpenTelemetry)",
        title: "Trace a framework with OpenTelemetry",
        metaTitle: "OpenTelemetry for AI agents: a local OTLP receiver",
        summary: "Send traces from the OpenAI Agents SDK, LangGraph, the Vercel AI SDK, the Claude Agent SDK or any OTLP exporter to coding.sh.",
      },
      {
        path: "/docs/agents",
        label: "Coding agents",
        title: "Record Claude Code, Codex and other coding agents",
        metaTitle: "Supported coding agents: Claude Code, Codex, Cursor, more",
        summary: "Claude Code, Codex, Cursor, OpenCode, Pi, T3 Code and more: how each one is recorded with no code changes, and what you get.",
      },
      {
        path: "/docs/how-to/capture-with-proxy",
        label: "Model call proxy",
        title: "Log every model call with the proxy",
        metaTitle: "Log every LLM call your agent makes, with a local proxy",
        summary: "Route any client through a local Anthropic or OpenAI proxy to keep every prompt, see why the prompt cache missed, and replay a call.",
      },
      {
        path: "/docs/ai-gateway",
        label: "LLM gateways",
        title: "LLM gateways",
        metaTitle: "LLM gateways: OpenRouter, LiteLLM, Vercel AI Gateway",
        summary: "Agents behind Vercel AI Gateway, OpenRouter, LiteLLM, Portkey, Helicone and others: tagged sessions, billed cost per call, and A/B runs across models.",
      },
      {
        path: "/docs/how-to/trace-durable-workflow",
        label: "Durable workflows",
        title: "Trace a durable workflow",
        summary: "Record a Vercel Workflow or Temporal run as one session across crashes, deploys and days, with each step's attempts, waits and resume points.",
      },
    ],
  },
  {
    label: "Look at runs",
    pages: [
      {
        path: "/docs/explore",
        label: "Find and read runs",
        title: "Find and read runs",
        summary: "List, filter and search sessions, read one step by step in the terminal or the viewer, and follow a run while it works.",
      },
      {
        path: "/docs/cost",
        label: "Track cost",
        title: "Track cost and tokens",
        metaTitle: "Track AI agent cost per session, model and repo",
        summary: "Tokens and cost per session, agent, model, repo and day, your most expensive sessions, and where each number comes from.",
      },
      {
        path: "/docs/use-cases/replay-agent-session",
        label: "Replay a session",
        title: "Replay a session step by step",
        metaTitle: "Replay a Claude Code or Codex session step by step",
        summary: "Step through a recorded session and see what each command printed and what it did to each file. Nothing is run again.",
      },
      {
        path: "/docs/how-to/attribute-commits",
        label: "Agent lines per commit",
        title: "See which agent session wrote each commit",
        summary: "Match the lines each commit added to the session that wrote them, see it per line with coding.sh blame, and export Agent Trace records.",
      },
      // Listed once src/pages/docs/mcp.astro exists (another workflow writes it).
      ...(HAS_MCP_PAGE
        ? [
            {
              path: "/docs/mcp",
              label: "Ask your agent (MCP)",
              title: "Let your agent read its own runs over MCP",
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
        title: "Run your first eval",
        metaTitle: "Evals for AI agents: cases, graders and judges · coding.sh",
        summary: "Write the cases, point coding.sh at the command that answers one, read the pass rate per case, then fix the failures and compare the two runs.",
        searchTerms: ["eval", "evals"],
      },
      {
        path: "/docs/judges",
        label: "LLM judges",
        title: "LLM judges",
        summary: "Grade answers with a model when there is no exact answer: write a rubric, pick the provider and model, and check the judge against your labels.",
      },
      {
        path: "/docs/how-to/session-to-eval",
        label: "Failures to evals",
        title: "Turn failed runs into evals",
        metaTitle: "Build agent evals from real failures · coding.sh",
        summary: "Keep the runs that went wrong as eval cases or repo tasks, so every later change is tested against them.",
      },
      {
        path: "/docs/tool-evals",
        label: "Tool evals",
        title: "Tool evals",
        summary: "See how well agents use your CLI, MCP server or HTTP API, and keep the help and description changes that raise the score, with coding.sh toolevals.",
      },
      {
        path: "/docs/benchmarks",
        label: "Benchmarks",
        title: "Benchmarks",
        summary: "Compare agents or models on new cases every day, so none can be tuned to a fixed test, and see who leads over weeks, with coding.sh bench.",
      },
    ],
  },
  {
    label: "Experiment",
    pages: [
      {
        path: "/docs/experiments",
        label: "Experiments",
        title: "Experiments",
        summary: "Run two versions of your agent on the same cases and get a paired verdict: what got better, what broke, and whether the difference is real.",
      },
      {
        path: "/docs/how-to/compare-agents",
        label: "Compare two agents",
        title: "Compare two agents on your repo",
        summary: "Turn a real task into a checked eval, snapshot two agent setups, and run both on it with a paired comparison.",
      },
      {
        path: "/docs/how-to/replay-llm-calls",
        label: "Replay model calls",
        title: "Replay recorded model calls",
        summary: "Record a run's model calls, then re-run your change with the calls before it served from the recording and the rest live, against a control arm.",
      },
      {
        path: "/docs/workflows",
        label: "Multi-agent workflows",
        title: "Workflow experiments",
        summary: "Capture multi-agent workflow runs, score them against known answers, compare two versions with paired statistics, and replay with a control fork.",
      },
      {
        path: "/docs/how-to/ci-regressions",
        label: "Catch regressions in CI",
        title: "Catch a regression in CI",
        summary: "Run an eval suite, or the same eval on the base branch and the pull request, with the coding.sh GitHub Action, and fail the job when it regresses.",
      },
    ],
  },
  {
    label: "Improve your agent",
    pages: [
      {
        path: "/docs/improve",
        label: "What to fix first",
        title: "What to fix first",
        summary: "coding.sh improve ranks the problems in your recent sessions, proposes the AGENTS.md line that fixes each, and checks whether your last edits helped.",
      },
      {
        path: "/docs/how-to/test-agents-md-change",
        label: "Test an AGENTS.md change",
        title: "Test an AGENTS.md change",
        metaTitle: "Test an AGENTS.md or skill change · coding.sh",
        summary: "Replay the moments your agent went wrong with your committed AGENTS.md and with your edit, and get a ship-or-hold verdict before you commit.",
      },
      {
        path: "/docs/harness-evals",
        label: "AGENTS.md and skill evals",
        title: "Evaluate AGENTS.md and skills",
        summary: "Refine AGENTS.md in tested rounds, keep safety lines from being dropped, check that a skill loads, and replay tasks from your repo.",
      },
      {
        path: "/docs/how-to/evaluate-a-skill",
        label: "Evaluate a skill",
        title: "Evaluate an Agent Skill",
        summary: "Run the same behaviour tasks with and without a skill, grade each run with checks and a judge, and read a ship-or-hold answer.",
      },
      {
        path: "/docs/how-to/does-this-plugin-help",
        label: "Does this plugin help?",
        title: "Does this plugin help me?",
        summary: "See what a Claude Code plugin's hooks add to your sessions and what it costs, then run your tasks with and without it.",
      },
      {
        path: "/docs/terse-mode",
        label: "Does a terse mode save money?",
        title: "Does a terse mode save money on your tasks?",
        summary: "Run your tasks with and without a be-concise rule, skill or plugin, and compare pass rate, cost, output tokens and the input it adds.",
      },
    ],
  },
  {
    label: "Run for a team",
    pages: [
      {
        path: "/docs/how-to/self-host-team",
        label: "Self-host for a team",
        title: "Self-host for a team",
        summary: "Run one container, connect each machine with coding.sh init --remote, and open the team viewer with everyone's sessions.",
      },
      {
        path: "/docs/production",
        label: "Production apps",
        title: "Trace an app in production",
        metaTitle: "Open-source, self-hosted LLM observability · coding.sh",
        summary: "Run coding.sh serve on SQLite or Postgres and send traces from your deployed app with the SDKs or OpenTelemetry.",
      },
      {
        path: "/docs/deploy",
        label: "Deploy the server",
        title: "Deploy coding.sh serve",
        summary: "Run coding.sh serve with Docker Compose, Fly.io, Railway or Render, or take traces from serverless functions.",
      },
      {
        path: "/docs/privacy",
        label: "Privacy and redaction",
        title: "Privacy and redaction",
        summary: "What coding.sh stores, what it removes before writing, metadata mode, and how to purge a leaked secret.",
      },
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
      {
        path: "/docs/api",
        label: "REST API",
        title: "REST API reference",
        summary: "Every route coding.sh serve answers, with auth and examples: ingest, OTLP, the model API proxy, health and metrics.",
        children: [
          { path: "/docs/api/read", label: "Read API", title: "Read API: sessions and calls", summary: "The /api routes the viewer and your scripts read, their auth and errors: projects, sessions, events, outlines, replays, blobs and model calls." },
          { path: "/docs/api/read/search", label: "Search and evals API", title: "Read API: search, labels and evals", summary: "The /api routes for search, stats, facets, events, labels, experiments, compare, benchmarks, tasks, runs and bundles, update and ingest status." },
        ],
      },
      {
        path: "/docs/query",
        label: "Query language",
        title: "Query language",
        summary: "Every --where key, operator and facet that sessions, usage, stats and the viewer's filter bar accept, with examples.",
      },
      { path: "/docs/config", label: "Configuration", title: "Configuration reference", summary: "Every config.toml key and environment variable, their defaults, and which layer wins." },
      {
        path: "/docs/storage",
        label: "Storage",
        title: "Storage",
        summary: "The SQLite index, the content-addressed blob store, sinks, and how to plug in a remote store.",
      },
      {
        path: "/docs/stores",
        label: "Postgres and ClickHouse",
        title: "Postgres and ClickHouse stores",
        summary: "Keep sessions in Postgres or ClickHouse for coding.sh serve: setup, the collector config, and queries you can run on the tables.",
      },
      {
        path: "/docs/trace-format",
        label: "Trace format",
        title: "Trace format",
        summary: "The coding.sh/trace v0 event format every adapter and the OTLP receiver normalize into.",
      },
      {
        path: "/docs/eval-methods",
        label: "How evals are computed",
        title: "How evals are computed",
        summary: "pass@k, paired comparison, bootstrap intervals, McNemar's test, the ship-or-hold gate and judge calibration, each with its formula.",
      },
      {
        path: "/docs/troubleshooting",
        label: "Troubleshooting",
        title: "Troubleshooting",
        summary: "What doctor checks, why sessions go missing, and every CLI error reason with its fix.",
        searchTerms: ["missing session", "no sessions", "sessions not showing", "not working"],
      },
      {
        path: "/docs/faq",
        label: "FAQ",
        title: "FAQ",
        metaTitle: "coding.sh FAQ: privacy, performance and status",
        summary: "Short answers about privacy, performance, status and support.",
      },
      {
        path: "/docs/roadmap",
        label: "Roadmap",
        title: "Roadmap",
        summary: "The gaps coding.sh still has, what has not run on a live install, and what to use until then.",
      },
      {
        // Bodies in docs/compare/: checked against each tool's own docs, with sources.
        // Other products are named only here and on these pages.
        path: "/docs/compare",
        label: "Compare with other tools",
        title: "coding.sh compared with other tools",
        metaTitle: "coding.sh and other tracing and eval tools, side by side",
        summary: "Feature tables for other tracing and eval tools, and when each one is the better choice.",
        children: [
          { path: "/docs/compare/langfuse", label: "vs Langfuse", title: "coding.sh vs Langfuse", metaTitle: "coding.sh vs Langfuse: open-source agent observability", summary: "Langfuse is an open-source LLM platform, hosted or self-hosted; coding.sh records any AI agent and coding agents locally. Features and where each wins." },
          { path: "/docs/compare/langsmith", label: "vs LangSmith", title: "coding.sh vs LangSmith", metaTitle: "coding.sh vs LangSmith: an open-source, self-hosted option", summary: "LangSmith is a hosted platform; coding.sh is MIT licensed and runs on your machine. A feature table, and where each one is the better choice." },
          { path: "/docs/compare/braintrust", label: "vs Braintrust", title: "coding.sh vs Braintrust", metaTitle: "coding.sh vs Braintrust: open-source agent evals", summary: "Braintrust is a hosted eval platform; coding.sh runs evals locally with paired statistics. A feature table, and where each one is the better choice." },
          { path: "/docs/compare/agentops", label: "vs AgentOps", title: "coding.sh vs AgentOps", metaTitle: "coding.sh vs AgentOps: agent observability compared", summary: "AgentOps instruments Python agent frameworks; coding.sh records any AI agent and coding agents locally, with evals. Where each is better." },
          { path: "/docs/compare/laminar", label: "vs Laminar", title: "coding.sh vs Laminar", metaTitle: "coding.sh vs Laminar: AI agent tracing compared", summary: "Laminar is open-source agent observability with a cloud; coding.sh records any AI agent and coding agents locally. Features and where each wins." },
          { path: "/docs/compare/ccusage", label: "vs ccusage", title: "coding.sh vs ccusage", metaTitle: "ccusage alternative: cost, replay and evals · coding.sh", summary: "ccusage reports coding-agent token cost from local logs; coding.sh adds each session's steps, replay, flags and evals. Where each is the better choice." },
        ],
      },
    ],
  },
];

/** The pages drawn in the sidebar, in order. Prev/next run over these. */
const TOP_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages);

/** Every docs page, each top-level page followed by its sub pages. */
export const DOC_PAGES: DocPage[] = TOP_PAGES.flatMap((p) => [p, ...(p.children ?? [])]);

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function docPage(path: string): DocPage {
  const page = DOC_PAGES.find((p) => p.path === norm(path));
  if (!page) throw new Error(`docs: ${path} is missing from src/components/docs/nav.ts`);
  return page;
}

/** The sidebar page a sub page sits under, or undefined for a top-level page. */
export function parentOf(path: string): DocPage | undefined {
  const here = norm(path);
  return TOP_PAGES.find((p) => p.children?.some((c) => c.path === here));
}

/** The group a page (or its parent) is listed in. */
export function groupOf(path: string): DocGroup | undefined {
  const top = parentOf(path)?.path ?? norm(path);
  return DOC_GROUPS.find((g) => g.pages.some((p) => p.path === top));
}

/**
 * Prev/next for the pager. A top-level page links the top-level pages beside
 * it and never a sub page. A sub page walks its siblings, from its parent to
 * the page after the parent.
 */
export function neighbours(path: string): { prev?: DocPage; next?: DocPage } {
  const here = norm(path);
  const parent = parentOf(here);
  if (parent) {
    const kids = parent.children!;
    const i = kids.findIndex((c) => c.path === here);
    return { prev: kids[i - 1] ?? parent, next: kids[i + 1] ?? neighbours(parent.path).next };
  }
  const i = TOP_PAGES.findIndex((p) => p.path === here);
  return { prev: i > 0 ? TOP_PAGES[i - 1] : undefined, next: i >= 0 ? TOP_PAGES[i + 1] : undefined };
}
