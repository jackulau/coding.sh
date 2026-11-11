// Agent-facing text for /llms.txt.
import { SITE_URL, SITE, NAV_PAGES, REPO_URL, LICENSE, SOURCE_STEPS, CLI_PATH, INSTALL_SH, RELEASE_TGZ } from "../data/site";
import { FRAMEWORKS, OTLP_ENDPOINT } from "../data/agents";
import { DOC_PAGES } from "../components/docs/nav";
import { ADAPTER_ROWS, PLANNED_AGENTS, STATUS_LABEL } from "../components/docs/agents";
import { cliReference } from "../components/docs/cli-help";

const abs = (path: string) => new URL(path, SITE_URL).toString();

/** What an agent should paste-and-run to install coding.sh and record its own session. */
export const AGENT_PROMPT = `Install coding.sh and start recording this session: run \`${INSTALL_SH}\` then \`coding.sh init --yes\`. Docs for agents: ${abs("/llms.txt")}`;

function cliSection(): string {
  const ref = cliReference();
  const commands = ref
    ? ref.groups.flatMap((g) => g.commands.map((c) => `- \`coding.sh ${c.name}\` (${g.label.toLowerCase()}): ${c.summary}`)).join("\n")
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

export function llmsText(): string {
  return `# ${SITE.name}

> ${SITE.description}

Also written coding shell, coding sh or codingsh (the \`.sh\` reads as "shell"); the CLI runs as \`coding.sh\` or \`codingsh\`. One tool.

Status: ${SITE.version}, ${LICENSE} licensed. Source: ${REPO_URL}

## Install

\`\`\`sh
${INSTALL_SH}      # checks Node 22.15+, installs the latest release, runs init, opens the viewer
coding.sh init --yes    # non-interactive: install hooks into every detected agent
coding.sh doctor --json # check the install
\`\`\`

The installer is ${abs("/install")} (plain text; read it before piping it to sh). It runs \`npm install -g\`: from npm when
the registry has coding.sh, otherwise on the release tarball, e.g. \`npm i -g ${RELEASE_TGZ}\`. Env: CODING_SH_YES=1 skips the prompt, CODING_SH_NO_INIT=1 installs only,
CODING_SH_NO_UI=1 skips the viewer, CODING_SH_VERSION=v0.1.0 pins a release,
CODING_SH_SOURCE=github skips npm.
From source: \`${SOURCE_STEPS.join(" && ")}\`; the CLI builds to ${CLI_PATH}.

Full prose for every page is at ${abs("/llms-full.txt")}; each page also serves a Markdown copy at <page>.md (the home page at /index.md).
Screenshots and terminal output on the landing page come from the real CLI and viewer, run on a throwaway home where coding.sh works on its own repo; terminals in the docs marked as real output were captured from the CLI.

## Pages

${NAV_PAGES.map((p) => `- [${p.title}](${abs(p.path)}): ${p.summary}`).join("\n")}

## Docs

${DOC_PAGES.map((p) => `- [${p.title}](${abs(p.path)}): ${p.summary}`).join("\n")}

## What it is for

coding.sh records what AI agents do (prompts, model calls, tool calls, file changes, cost), shows each run in a
local viewer, and turns runs that went wrong into evals. Everything stays on your machine. Pre-alpha: what is built is covered by the package's tests; items marked planned do not exist yet.

1. Record (built): a local OTLP receiver (\`coding.sh collector\`, ${OTLP_ENDPOINT}) for ${FRAMEWORKS.join(", ")};
   model-call latency per call. Coding agents are first-class: hooks capture prompts, tool calls, file changes
   and subagents (as child sessions). \`coding.sh run --\` snapshots the working tree before and after;
   hook-captured sessions in a git repository start from the commit checked out at session start.
2. Evals (built): datasets with deterministic graders, command graders and LLM judges; judges are calibrated
   against human labels with Cohen's kappa on a held-out split, and uncalibrated judges are flagged in every
   report. Repo-replay tasks (partial): validation (do-nothing fails, reference passes k of k, near-misses
   fail, no leakage), harness bundles, compare and drafting a task from a captured session are built.
3. Compare (built): two experiments paired by case, with a paired bootstrap CI of the difference and McNemar's
   test on flipped cases; harness compare adds per-arm Wilson intervals and the first step where traces diverge.
4. Storage (built): SQLite index and a content-addressed, zstd-compressed blob store by default; OTLP and HTTP
   sinks, metadata-only by default; third-party stores and sinks load as npm plugins. The Postgres, ClickHouse and S3
   store plugins are on npm (coding.sh-store-postgres, coding.sh-store-clickhouse, coding.sh-store-s3) and used by
   \`coding.sh serve\`. The core is one npm package with zero runtime dependencies, Node 22.15 or newer.
5. Tool evals (built): \`coding.sh toolevals\` scores how well agents use a CLI, MCP server or HTTP API.
   Workflows (built): \`coding.sh workflows\` captures, scores and compares multi-agent runs.
   Trace format (built): TypeScript types (\`coding.sh/schema\`) and a JSON Schema (\`coding.sh/schema.json\`, ${abs("/schema.json")}).

## Coding agents (adapters in code)

${ADAPTER_ROWS.map((a) => `- ${a.name} (\`${a.id}\`, ${STATUS_LABEL[a.status].toLowerCase()}): capture: ${a.live}; backfill: ${a.backfill ?? "none"}; subagents: ${a.subagents}`).join("\n")}

Planned, no adapter yet: ${PLANNED_AGENTS.join(", ")}.

${cliSection()}
`;
}
