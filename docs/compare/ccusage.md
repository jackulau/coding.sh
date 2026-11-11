# coding.sh vs ccusage

ccusage is a small open-source CLI that reads the logs your coding agents already write and
reports tokens and cost by day, week, month or session. coding.sh also reports cost from those
logs, and records each session's steps so you can replay it, flag what went wrong and turn it into
an eval. Both are MIT licensed and run on your machine.

Checked against ccusage's docs and repository on 7 November 2026. Sources are at the end of the
page. If something here is out of date, open an issue.

## At a glance

| | coding.sh | ccusage |
|---|---|---|
| License | MIT | MIT |
| Setup | `coding.sh init` installs hooks, then imports history | None: `npx ccusage` reads existing logs |
| Agents | Claude Code, Codex, Cursor and more ([list](https://coding.sh/docs/agents)) | 18 sources, including Claude Code, Codex, OpenCode, Amp, Gemini CLI and Copilot CLI |
| Cost over time | By day, `usage --by day` | Daily, weekly and monthly reports |
| Cost per session | Yes, `show` and `sessions --json` | Yes, `session` |
| Cost by repo, agent and model | Yes, `usage --by repo` and `--by agent-model` | Yes: `--instances` (project), `--breakdown` (model), `--by-agent` (JSON) |
| 5-hour billing window, live | No | Yes, `blocks --live` |
| Status line for Claude Code | No | Yes |
| Prompts, tool calls and file changes per session | Yes | No |
| Replay a session step by step | Yes, `coding.sh replay` | No |
| Flags for failures and waste | Yes | No |
| Evals and A/B comparisons | Yes | No |
| Search across sessions | Yes | No |
| MCP server | Yes | No (deprecated) |
| JSON output | Yes, every command | Yes |

## Where ccusage is better

- **Zero setup.** One command reads the history already on disk. Nothing is installed into your
  agents.
- **Billing windows.** `blocks --live` tracks Claude's 5-hour usage window as it fills.
- **A status line** for Claude Code that shows the current spend.
- **Small and focused.** If all you want is a cost report, it does exactly that.

## Where coding.sh is better

- **What happened, not only what it cost.** Each session keeps its prompts, tool calls, file
  changes and subagents. `coding.sh show` and the viewer open one, and `coding.sh replay` walks it
  step by step.
- **Why a session cost what it did.** `coding.sh show` gives a session's tokens, cache reads and
  latency next to its steps, so a high cost points at the turns that caused it. See
  [Find your most expensive sessions](../how-to/track-cost.md).
- **Billed cost when you have it.** A cost the agent or an LLM gateway reports is used before an
  estimate, and estimates are marked with `~`.
- **From cost to fixes.** Flags mark failures and waste, `coding.sh improve` proposes a line for
  your AGENTS.md, and evals check whether the change helped. See
  [Test an AGENTS.md change](../how-to/test-agents-md-change.md).

## Questions

### Is coding.sh a ccusage alternative?

Yes, if you want more than a cost report. If you only want token counts and a status line,
ccusage is lighter.

### Can I use both?

Yes. ccusage reads the agents' logs and coding.sh reads them too; neither changes them.

### Why do my numbers differ between the two?

Both price tokens with list prices unless a real cost is available, and their price tables and
rules differ, for example for long-context, cache-write and fast-mode rates. coding.sh shows which
model price it used on each call. See
[where cost comes from](../how-to/track-cost.md#where-cost-comes-from).

## Sources

- [ccusage repository](https://github.com/ccusage/ccusage)
- [CLI options](https://ccusage.com/guide/cli-options)
- [ccusage on npm](https://www.npmjs.com/package/ccusage)
