// Agent-facing text for /llms.txt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_URL, SITE, NAV_PAGES, REPO_URL, LICENSE, SOURCE_STEPS, CLI_PATH, INSTALL_SH, RELEASE_TGZ, VERSION } from "../data/site";
import { FRAMEWORKS, OTLP_ENDPOINT } from "../data/agents";
import { DOC_GROUPS, type DocPage } from "../components/docs/nav";
import { ADAPTER_ROWS, PLANNED_AGENTS, STATUS_LABEL } from "../components/docs/agents";
import { cliPath, cliReference } from "../components/docs/cli-help";

const abs = (path: string) => new URL(path, SITE_URL).toString();

/**
 * Blog posts, newest first, from the front matter of src/content/blog/*.md (the
 * file name is the slug). Read from disk because llms.txt is built synchronously,
 * outside astro:content. Build-time only, run from apps/site.
 */
function blogPosts(): { path: string; title: string; description: string; date: string }[] {
  const dir = join(process.cwd(), "src/content/blog");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const head = readFileSync(join(dir, f), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const field = (key: string) => (head.match(new RegExp(`^${key}:[ \t]*(.*)$`, "m"))?.[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
      return { path: `/blog/${f.slice(0, -3)}`, title: field("title"), description: field("description"), date: field("date") };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
}

/** What an agent should paste-and-run to install coding.sh and record its own session. */
export const AGENT_PROMPT = `Install coding.sh and start recording this session: run \`${INSTALL_SH}\` then \`coding.sh init --yes\`. Docs for agents: ${abs("/llms.txt")}`;

function cliSection(): string {
  const ref = cliReference();
  const commands = ref
    ? ref.groups.flatMap((g) => g.commands.map((c) => `- [\`coding.sh ${c.name}\`](${abs(cliPath(c.name))}) (${g.label.toLowerCase()}): ${c.summary}`)).join("\n")
    : `- Run \`coding.sh --help\` for the command list (the reference is generated from the CLI at build time).`;
  return `## CLI

${commands}

Full reference: ${abs("/docs/cli")}

## Output and exit codes

- Every command takes \`--json\`: one JSON document on stdout. Errors go to stderr as one JSON line:
  \`{"status":"error","reason":"<reason>","message":"<text>","next":["<what to do>:","<command>"]}\`.
- Exit codes: 0 success, 1 error, 2 usage error (unknown option, bad value, missing \`--yes\`), 130 canceled.
- Commands that write config ask first; pass \`--yes\` to confirm without a prompt (\`init --dry-run\` prints every edit and writes nothing).`;
}

/** The docs by group, as in the sidebar; sub pages (the REST API read pages, the comparisons) indented under their parent. */
function docsSection(): string {
  const row = (p: DocPage, indent = "") => `${indent}- [${p.title}](${abs(p.path)}): ${p.summary}`;
  return DOC_GROUPS.map(
    (g) => `### ${g.label}\n\n${g.pages.map((p) => [row(p), ...(p.children ?? []).map((c) => row(c, "  "))].join("\n")).join("\n")}`,
  ).join("\n\n");
}

export function llmsText(): string {
  return `# ${SITE.name}

> ${SITE.description}

Also written coding shell, coding sh or codingsh (the \`.sh\` reads as "shell"); the CLI runs as \`coding.sh\` or \`codingsh\`. One tool.

Status: v${VERSION}, ${LICENSE} licensed. coding.sh is new: commands and file formats can still change between releases. Source: ${REPO_URL}

## Install

\`\`\`sh
${INSTALL_SH}      # checks Node 22.16+, installs the latest release, runs init, opens the viewer
coding.sh init --yes    # non-interactive: install hooks into every detected agent
coding.sh doctor --json # check the install
\`\`\`

The installer is ${abs("/install")} (plain text; read it before piping it to sh). It runs \`npm install -g\`: from npm when
the registry has coding.sh, otherwise on the release tarball, e.g. \`npm i -g ${RELEASE_TGZ}\`. Env: CODING_SH_YES=1 skips the prompt, CODING_SH_NO_INIT=1 installs only,
CODING_SH_NO_UI=1 skips the viewer, CODING_SH_VERSION=v<version> pins a release, CODING_SH_TARBALL=<path or url> installs that tarball,
CODING_SH_SOURCE=npm|github forces a source.
From source: \`${SOURCE_STEPS.join(" && ")}\`; the CLI builds to ${CLI_PATH}.

Full prose for every page is at ${abs("/llms-full.txt")}; each page also serves a Markdown copy at <page>.md (the home page at /index.md).
Screenshots and terminal output on the landing page come from the real CLI and viewer, run on a throwaway home where coding.sh works on its own repo; terminals in the docs marked as real output were captured from the CLI.

## Pages

${NAV_PAGES.map((p) => `- [${p.title}](${abs(p.path)}): ${p.summary}`).join("\n")}

## Docs

${docsSection()}

## Blog

${blogPosts().map((p) => `- [${p.title}](${abs(p.path)}) (${p.date}): ${p.description}`).join("\n")}

## What it does

coding.sh records what your AI agents do, so you can see each run on your machine and test changes against the runs
that went wrong.

1. Record your own agent with the TypeScript and Python SDKs, or with OpenTelemetry through the local OTLP receiver
   (\`coding.sh collector\`, ${OTLP_ENDPOINT}): ${FRAMEWORKS.join(", ")}. Each model call keeps its latency.
   Coding agents are recorded through their hooks, with no code changes: prompts, tool calls, file changes and
   subagents (as child sessions). \`coding.sh run --\` records any other command and snapshots the working tree
   before and after; a hook-captured session in a git repository starts from the commit checked out at session start.
2. Read the runs in the terminal (\`coding.sh sessions\`, \`coding.sh show\`), in the local viewer (\`coding.sh ui\`), or
   from your agent over MCP.
3. Evaluate on datasets with deterministic graders, command graders and LLM judges. Judges are calibrated against
   human labels with Cohen's kappa on a held-out split, and an uncalibrated judge is flagged in every report. A failed
   session becomes an eval case or a repo-replay task, checked before it is kept (doing nothing fails, the reference
   passes k of k, near-misses fail, no leakage).
4. Compare two experiments paired by case, with a paired bootstrap interval of the difference and McNemar's test on
   flipped cases; harness compare adds per-arm Wilson intervals and the first step where the traces diverge.
5. Storage: a SQLite index and a content-addressed, zstd-compressed blob store by default; OTLP and HTTP sinks,
   metadata-only by default; stores and sinks load as npm plugins. \`coding.sh serve\` keeps sessions in Postgres or
   ClickHouse with coding.sh-store-postgres, coding.sh-store-clickhouse and coding.sh-store-s3. One npm package with
   zero runtime dependencies, on Node 22.16 or newer.
6. Also: \`coding.sh toolevals\` scores how well agents use a CLI, MCP server or HTTP API; \`coding.sh workflows\`
   captures, scores and compares multi-agent runs; the trace format ships as TypeScript types (\`coding.sh/schema\`) and
   a JSON Schema (\`coding.sh/schema.json\`, ${abs("/schema.json")}).

Comparison pages, one per tool, each with a feature table, where the other tool is the better choice, and sources:
${abs("/docs/compare")}

## Coding agents (adapters in code)

${ADAPTER_ROWS.map((a) => `- ${a.name} (\`${a.id}\`, ${STATUS_LABEL[a.status].toLowerCase()}): capture: ${a.live}; backfill: ${a.backfill ?? "none"}; subagents: ${a.subagents}`).join("\n")}

Planned, no adapter yet: ${PLANNED_AGENTS.join(", ")}.

${cliSection()}
`;
}
