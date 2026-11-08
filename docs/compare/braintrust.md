# coding.sh vs Braintrust

Braintrust is a hosted platform for evals and observability of AI products, with experiments,
datasets, a prompt playground and online scoring. Its SDKs, CLI and the autoevals library are open
source; the platform is not. coding.sh is an MIT-licensed CLI and local viewer that records AI
agents on your machine and runs evals there, with coding agents such as Claude Code and Codex
captured through their hooks.

Checked against Braintrust's docs on 7 November 2026. Sources are at the end of the page. If
something here is out of date, open an issue.

## At a glance

| | coding.sh | Braintrust |
|---|---|---|
| License | MIT, all of it | SDKs, CLI and autoevals open source; the platform is closed |
| Hosted cloud | No | Yes, with a free Starter plan |
| Self-host | Yes: a laptop, or one `coding.sh serve` container | A self-hosted data plane (API, Postgres, Redis, object storage, Brainstore) |
| Coding agent capture | Hooks for Claude Code, Codex, Cursor and more ([list](https://coding.sh/docs/agents)) | `bt` CLI for Claude Code, Codex, Cursor, OpenCode and more |
| Import past sessions | Yes, `coding.sh ingest --backfill` | Yes, `bt trace import` |
| OpenTelemetry ingest | Yes, a local OTLP/HTTP receiver | Yes |
| SDK languages | TypeScript and Python | Six |
| Datasets, experiments, LLM judges | Yes | Yes |
| Compare two experiments | Paired bootstrap interval and a ship-or-hold gate | Side-by-side diffs and score deltas |
| Replay a coding session step by step, with files | Yes, `coding.sh replay` | No |
| Online scoring of live traffic | No | Yes |
| Human review queues | No | Yes |
| Prompt management and playground | No | Yes |
| PR comments with eval results | No (exit code only) | Yes, a GitHub Action |
| SSO and audit logs | No | Enterprise |
| MCP server | Yes, local | Yes, hosted |

## Where Braintrust is better

- **The experiment UI.** A polished hosted interface to browse experiments, diff outputs and score
  them, with a playground to try prompts and models.
- **Production.** Online scoring of live traffic, review queues for people, and LLM-based
  clustering of traces into topics.
- **Team reporting for coding agents.** A dashboard that breaks coding-agent cost down by user,
  model, tool and branch across a team.
- **CI feedback.** A GitHub Action posts score changes as a pull request comment.
- **Languages.** SDKs in six languages.

If you want a managed eval platform with a UI the whole team uses, Braintrust fits better than
coding.sh.

## Where coding.sh is better

- **Open source and local.** The whole tool is MIT licensed. Runs and traces stay on your disk, no
  account is needed, and nothing is sent anywhere unless you add a sink.
- **Statistics on every comparison.** `coding.sh exp compare` pairs two runs case by case and
  reports a bootstrap interval of the difference; `--gate` turns it into a ship-or-hold exit code.
  A result inside the noise is reported as inconclusive rather than as a win.
- **Calibrated judges.** An LLM judge counts only after it agrees with human labels on held-out
  cases; uncalibrated judges are flagged in every report.
- **Coding tasks that replay.** An eval task starts from the repository as it was before the agent
  ran, and its verifier is checked first: doing nothing must fail and the reference must pass.
- **Session replay.** `coding.sh replay` walks a session one step at a time with the files each
  step touched.

## Questions

### Is there an open-source Braintrust alternative?

For evals of agents and coding agents, coding.sh is one: MIT licensed and local. It has no
playground, prompt management, review queues or hosted UI.

### How does coding.sh decide that a change helped?

It runs both versions on the same cases, pairs the results by case, and computes a bootstrap
interval of the difference. When the interval's low end is above zero the change is better, when
its high end is below zero it is worse, and otherwise it is inconclusive. See
[Evals](https://coding.sh/docs/evals).

### Can both trace Claude Code?

Yes. Braintrust's `bt` CLI enables tracing for Claude Code and imports past sessions. coding.sh
installs hooks with `coding.sh init` and imports past sessions with `coding.sh ingest --backfill`.

## Sources

- [Self-hosting](https://docs.braintrust.dev/guides/self-hosting)
- [Pricing](https://www.braintrust.dev/pricing)
- [Claude Code integration](https://docs.braintrust.dev/integrations/developer-tools/claude-code)
- [Coding agent insights](https://docs.braintrust.dev/cookbook/recipes/CodingAgentInsights.md)
- [Compare experiments](https://braintrust.dev/docs/evaluate/compare-experiments)
- [eval-action](https://github.com/braintrustdata/eval-action)
- [MCP server](https://docs.braintrust.dev/integrations/developer-tools/mcp.md)
