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
  /** <h1> and <title>. */
  title: string;
  /** One sentence for meta description, llms.txt and the docs index. */
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
        summary: "What coding.sh is, what is built today, and what is still planned.",
      },
      {
        path: "/docs/install",
        label: "Install",
        title: "Install",
        summary: "Install coding.sh with one line, or with npm or from source; check it with doctor and remove it cleanly.",
      },
      {
        path: "/docs/quickstart",
        label: "Quickstart",
        title: "Quickstart",
        summary: "Record Claude Code, Codex and other coding agents with no code changes, then list, inspect and search their sessions.",
      },
      { path: "/docs/how-to/trace-your-agent", label: "Your own agent", title: "Trace your own agent", summary: "Record an agent you built with OpenTelemetry or the TypeScript and Python SDKs, then run evals on it and compare versions." },
      { path: "/docs/concepts", label: "Concepts", title: "Concepts", summary: "Sessions, events, turns, flags, datasets, experiments, graders, judges and benchmarks, each in a sentence or two." },
    ],
  },
  {
    label: "Record",
    pages: [
      {
        path: "/docs/otel",
        label: "OpenTelemetry",
        title: "Record any agent with OpenTelemetry",
        summary: "Point the Vercel AI SDK, Claude Agent SDK, OpenAI Agents SDK, LangGraph or any OTLP exporter at the local receiver.",
      },
      { path: "/docs/ai-gateway", label: "Gateways", title: "LLM gateways", summary: "Agents routed through Vercel AI Gateway, OpenRouter, LiteLLM, Cloudflare, Portkey, Helicone and others: tagged sessions, billed cost per call, and A/B runs across models with one key." },
      { path: "/docs/production", label: "Production", title: "Production: API apps", summary: "Run coding.sh serve on SQLite or Postgres and send traces from API apps with the SDKs or OpenTelemetry." },
      {
        path: "/docs/agents",
        label: "Coding agents",
        title: "Coding agents",
        summary: "Which coding agents have adapters, how each is captured, and how subagents are linked to their parent session.",
      },
      // Listed once src/pages/docs/mcp.astro exists (another workflow writes it).
      ...(HAS_MCP_PAGE
        ? [
            {
              path: "/docs/mcp",
              label: "MCP server",
              title: "MCP server",
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
        summary: "Datasets, graders, LLM judges calibrated against human labels, paired experiment comparisons, and repo-replay tasks.",
      },
      { path: "/docs/benchmarks", label: "Benchmarks", title: "Benchmarks", summary: "coding.sh bench: fresh cases every day from a live source, every contender on the same frozen set, and a history of who leads." },
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
      { path: "/docs/how-to/compare-agents", label: "Compare two agents", title: "Compare two agents on your repo", summary: "Turn a real task into a checked eval, snapshot two agent setups, and run both on it with a paired comparison." },
      { path: "/docs/how-to/ci-regressions", label: "Catch regressions in CI", title: "Catch a regression in CI", summary: "Run the same eval on the base branch and the pull request in GitHub Actions, and fail the job when a case regresses." },
      { path: "/docs/how-to/expensive-sessions", label: "Find expensive sessions", title: "Find your most expensive sessions", summary: "Rank sessions by cost or tokens, break spend down by repo, agent and model, and see where cost data comes from." },
      { path: "/docs/how-to/session-to-eval", label: "Session to eval", title: "Turn a real session into an eval", summary: "Keep a captured session as a validated repo task or a dataset case, so later changes are tested against it." },
      { path: "/docs/how-to/self-host-team", label: "Self-host for a team", title: "Self-host for a team", summary: "Run one coding.sh serve on Postgres with ingest and read keys, and send each teammate's sessions to it." },
      { path: "/docs/perf", label: "Measure site speed", title: "Site speed", summary: "How we made coding.sh load faster on slow phones, measured with coding.sh exp metrics, and the command to measure your own site." },
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
