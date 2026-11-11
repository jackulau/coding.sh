# Agents and OpenTelemetry

`coding.sh init` sets up every agent it finds. `coding.sh doctor` checks the result. For each
agent's hook config, payload ids and known breakage, see [ADAPTERS.md](../ADAPTERS.md).

## Coding agents

| Agent | Capture | History import | MCP registered by `init` | Status |
|---|---|---|---|---|
| Claude Code | hooks + transcript, subagents | yes | yes | Verified on real sessions |
| Codex CLI | hooks + rollout files, subagents | yes | yes | Verified on real sessions. Codex runs new hooks only after you approve them once with `/hooks`. |
| Antigravity CLI (`agy`, formerly Gemini CLI) | hooks + transcript | yes | no | Verified on real sessions |
| Gemini CLI, older installs | hooks + chat files, subagents | yes | yes | Not run live: Gemini CLI moved to Antigravity CLI; this adapter reads sessions from older installs. |
| OpenCode | plugin + session database | yes | yes | Verified on a real install (1.19.5) |
| Cursor CLI | hooks + transcript | yes | yes | Not run live: it needs a Cursor login or `CURSOR_API_KEY`. In `-p` mode Cursor does not fire `stop` or `beforeSubmitPrompt`. |
| GitHub Copilot CLI | hooks + session state | yes | no | Verified on a real install (1.0.107) |
| Factory Droid | hooks + transcript | yes | no | Verified on a real install (1.6.0). `droid exec` fires no `UserPromptSubmit`, so the prompt comes from the transcript. |
| Goose | plugin hooks + session database | yes | no | Verified on a real install (1.57.0). Hooks carry no model or tool output; history import adds them. |
| Pi | extension + transcript | yes | no | Verified on a real install (1.5.0) |
| Amp | plugin | no | no | Not run live: it needs an ampcode.com login. |
| T3 Code | reads its local store on every ingest | yes | no | Verified on a real install (0.1.7, driving Pi) |
| Aider | wrapper (`coding.sh run -- aider …`), with each reply's tokens and cost read from Aider's analytics log while it runs; eval runs parse its token and cost lines | no | no | Verified on a real install (0.86.2) |
| Anything else | `coding.sh run -- <cmd>`: shadow-git snapshots before and after | no | no | Tested: covered by CI; there is no third-party agent to check against. |

What the statuses mean:

- **Verified on real sessions**: checked against sessions captured from a live install of the
  agent during development, in addition to the CI tests.
- **Verified on a real install**: the agent's current release was installed and run through a
  session against a local stub model, its hooks fired and the recorded session was checked, and
  the captured payloads are now CI fixtures. For OpenCode, Pi, Goose, Factory Droid, GitHub
  Copilot CLI and Aider, CI repeats that run on Linux and Windows on every change
  ([`scripts/e2e/real-capture.mjs`](../../scripts/e2e/real-capture.mjs)). The other agents have
  not been checked on Windows yet.
- **Not run live**: CI tests the adapter against hook payloads, transcripts or session stores
  that follow the agent's documented format, plus its install and uninstall. It has not yet been
  checked against a live install of that agent. Reports are welcome.
- **Tested**: covered by CI tests. There is no third-party agent to verify against.

Import past sessions with `coding.sh ingest --backfill [--since 30d]`.

What T3 Code and Pi sessions record, the Claude Code status line (`coding.sh statusline install`)
and `coding.sh run -- <cmd>` are on the site: [Record coding agents](https://coding.sh/docs/agents).

## Model API proxy

Hooks and transcripts record what an agent did. To also record what it sent the model (the full
system prompt, tool definitions and messages of every call), route it through the local proxy:

```sh
coding.sh init --proxy
```

This points Claude Code (`ANTHROPIC_BASE_URL` in `settings.json`) and Codex (a `coding-sh` provider
in `config.toml`) at `coding.sh proxy` on `127.0.0.1:4320` and starts it. Both agents name their
session on every call, so each call lands in the session their hooks capture. An agent that already
calls a gateway or CLIProxyAPI keeps calling it, through the proxy. For other clients,
`eval "$(coding.sh proxy env)"` sets `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`. See
[Capture with the proxy](../how-to/capture-with-proxy.md).

## OpenTelemetry

Agent frameworks and apps that export OpenTelemetry can send traces to a local receiver.
`coding.sh collector` starts an OTLP/HTTP receiver on `127.0.0.1:4318` and prints the environment
that points an exporter at it:

```sh
coding.sh collector
# export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
# export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# export OTEL_TRACES_EXPORTER=otlp
# export OTEL_LOGS_EXPORTER=otlp
# export CLAUDE_CODE_ENABLE_TELEMETRY=1
```

It accepts `POST /v1/traces` and `/v1/logs` as protobuf or JSON. `/v1/metrics` is accepted and
ignored. It understands OTel GenAI semantic conventions, OpenInference, Vercel AI SDK spans and the
Claude Code, Codex and Gemini CLI log events. Every model call becomes an `llm.call` event with
model, token usage, duration and time to first token.

A session that also has a transcript (Claude Code logs sent here and the transcript read by
`coding.sh ingest`) counts the transcript's model calls. The log copies stay stored but add no
tokens or calls to the session's stats, whichever source arrived first.

Point any SDK at the base URL, or set a signal-specific endpoint such as
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces`.

Framework notes: [Trace a framework with OpenTelemetry](https://coding.sh/docs/otel), [LLM gateways](../integrations/ai-gateway.md), [eve](../integrations/eve.md).
