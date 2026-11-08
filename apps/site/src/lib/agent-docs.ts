// Hand-written agent documents: /agents.md (the canonical setup workflow) and
// /skill.md (the same workflow as a Claude Code-style skill). Commands here
// match the CLI reference generated from the binary (/docs/cli).
import { SITE_URL, INSTALL_SH } from "../data/site";

const today = new Date().toISOString().slice(0, 10);
const abs = (p: string) => new URL(p, SITE_URL).toString();

/** YAML frontmatter shared by every agent-facing Markdown page. */
export function frontmatter(f: { title: string; description: string; path: string; md: string }) {
  return `---
title: ${JSON.stringify(f.title)}
description: ${JSON.stringify(f.description)}
canonical: ${abs(f.path)}
human_url: ${abs(f.path)}
markdown_url: ${abs(f.md)}
agents_url: ${abs("/agents.md")}
llms_url: ${abs("/llms.txt")}
updated: ${today}
---`;
}

const WORKFLOW = `## 1. Install

\`\`\`sh
${INSTALL_SH}
\`\`\`

Needs Node.js 22.15 or newer. The script installs the latest release with \`npm i -g\`, runs \`coding.sh init\`
and opens the viewer. Read it first: ${abs("/install")}. In a non-interactive shell set \`CODING_SH_YES=1\`
(no prompt) and \`CODING_SH_NO_UI=1\` (no browser):

\`\`\`sh
curl -fsSL https://coding.sh/install | CODING_SH_YES=1 CODING_SH_NO_UI=1 sh
\`\`\`

## 2. Install the capture hooks

\`\`\`sh
coding.sh init --dry-run   # print every config edit, write nothing
coding.sh init --yes       # add one hook to every detected agent
\`\`\`

Tell the user which agents were configured. Every edited file is backed up to \`~/.coding.sh/backups\` first.
Codex runs new hooks only after the user approves them with \`/hooks\` inside Codex; never write trust state yourself.

## 3. Verify

\`\`\`sh
coding.sh doctor --json
\`\`\`

One JSON document: each detected agent, whether its hooks are in place, whether the spool and store are
writable and whether the OTLP port is free. Fix what it reports before going on.

## MCP

\`coding.sh mcp\` is an MCP server over stdio that lets the agent query its own history (sessions, the current
session, failures, latency, usage, search, and drafting an eval from a session). \`init\` registers it
automatically with Claude Code, Codex, Cursor, OpenCode and older Gemini CLI installs. Manual: run \`coding.sh mcp\` over stdio.

## 4. Where sessions land

- Everything is under \`~/.coding.sh\` (\`CODING_SH_HOME\` moves it): \`spool/\` raw hook events, \`index.db\` SQLite
  index, \`blobs/\` zstd payloads.
- \`coding.sh sessions --since 1d --json\` lists sessions, newest first.
- \`coding.sh show latest --json\` prints one session's timeline, with subagents and latency.
- \`coding.sh ingest --backfill --since 30d\` imports transcripts from before \`init\`.
- \`coding.sh ui\` opens the local viewer on 127.0.0.1.
- Agent frameworks (Vercel AI SDK, OpenAI Agents SDK, LangGraph, ...) export OTLP to \`coding.sh collector\` on
  http://127.0.0.1:4318. See ${abs("/docs/otel")}.

## 5. Run an eval

\`\`\`sh
coding.sh dataset import cases.jsonl --name smoke
coding.sh exp run --dataset smoke --name base \\
  --task '{"kind":"command","command":"node","args":["agent.mjs"]}' \\
  --grader '{"kind":"exact"}'
# change the prompt, harness or model, run again as --name candidate, then:
coding.sh exp compare <base-id> <candidate-id> --json
\`\`\`

\`exp compare\` pairs the runs by case and reports a paired bootstrap CI of the difference and McNemar's test.
Details: ${abs("/docs/evals")} and ${abs("/docs/experiments#compare")}.

## Output and exit codes

- Every command takes \`--json\`: one JSON document on stdout. Errors are one JSON line on stderr:
  \`{"status":"error","reason":"<reason>","message":"<text>","next":["<suggested command>"]}\`.
- Exit codes: 0 success, 1 error, 2 usage error (unknown option, bad value, missing \`--yes\`), 130 canceled.
- Commands that change config ask first. Pass \`--yes\` only when the user asked you to set it up.

## Remove

\`\`\`sh
coding.sh uninstall --dry-run
coding.sh uninstall --yes   # removes only the hooks coding.sh added; captured data stays
\`\`\`
`;

export function agentsMd() {
  return `${frontmatter({
    title: "coding.sh agent setup",
    description: "The canonical workflow for an AI agent setting up coding.sh for a user: install, hooks, verify, sessions, evals.",
    path: "/",
    md: "/agents.md",
  })}

# coding.sh agent setup

> coding.sh records every agent run on the user's machine (prompts, tool calls, file changes, subagents, model
> latency), turns failures into evals and compares changes with paired statistics. Local-first, MIT licensed.

Follow these steps in order. Ask the user before step 2 unless they already asked you to set coding.sh up.

${WORKFLOW}
More: ${abs("/llms.txt")} (index), ${abs("/llms-full.txt")} (every page), ${abs("/docs/cli")} (CLI reference).
`;
}

export function skillMd() {
  return `---
name: coding-sh
description: Install and use coding.sh, local traces and evals for AI agents. Use when the user wants to record agent sessions, inspect what an agent did, or run evals and compare a prompt, harness or model change.
---

# coding.sh

Local-first traces and evals for AI agents. Canonical workflow: ${abs("/agents.md")}

${WORKFLOW}`;
}
