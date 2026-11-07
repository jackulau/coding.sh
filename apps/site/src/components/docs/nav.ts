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
        title: "Quickstart: coding agents",
        summary: "Install capture hooks into Claude Code, Codex and other coding agents, then list, inspect and search sessions.",
      },
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
      { path: "/docs/ai-gateway", label: "AI Gateway", title: "Vercel AI Gateway", summary: "Agents routed through Vercel AI Gateway: tagged sessions, billed cost per call, trace drains, and A/B runs across models with one key." },
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
      {
        path: "/docs/tool-evals",
        label: "Tool evals",
        title: "Tool evals (planned)",
        summary: "The design for measuring how well agents use a CLI, MCP server or HTTP API. Not implemented yet.",
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
