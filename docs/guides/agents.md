# Agents and OpenTelemetry

`coding.sh init` sets up every agent it finds. `coding.sh doctor` checks the result. For each
agent's hook config, payload ids and known breakage, see [ADAPTERS.md](../ADAPTERS.md).

## Coding agents

| Agent | Capture | History import | MCP registered by `init` | Status |
|---|---|---|---|---|
| Claude Code | hooks + transcript, subagents | yes | yes | Verified on real sessions |
| Codex CLI | hooks + rollout files, subagents | yes | yes | Verified on real sessions. Codex runs new hooks only after you approve them once with `/hooks`. |
| Antigravity CLI (`agy`, formerly Gemini CLI) | hooks + transcript | yes | no | Verified on real sessions |
| Gemini CLI, older installs | hooks + chat files, subagents | yes | yes | Fixture-tested |
| OpenCode 2.x | plugin + session database | yes | yes | Fixture-tested |
| Cursor CLI | hooks + transcript | yes | yes | Fixture-tested. In `-p` mode Cursor does not fire `stop` or `beforeSubmitPrompt`. |
| GitHub Copilot CLI | hooks + session state | yes | no | Fixture-tested |
| Factory Droid | hooks + transcript | yes | no | Fixture-tested |
| Goose | plugin hooks + session database | yes | no | Fixture-tested |
| Pi | extension + transcript | yes | no | Fixture-tested |
| Amp | plugin | no | no | Fixture-tested |
| T3 Code | reads its local store on every ingest | yes | no | Fixture-tested |
| Aider | wrapper (`coding.sh run -- aider …`); eval runs parse its token and cost lines | no | no | Fixture-tested |
| Anything else | `coding.sh run -- <cmd>`: shadow-git snapshots before and after | no | no | Tested |

What the statuses mean:

- **Verified on real sessions**: checked against sessions captured from a live install of the
  agent during development, in addition to the CI tests.
- **Fixture-tested**: CI tests the adapter against hook payloads, transcripts or session stores
  that follow the agent's documented format, plus its install and uninstall. It has not yet been
  checked against a live install of that agent. Reports are welcome.
- **Tested**: covered by CI tests. There is no third-party agent to verify against.

Import past sessions with `coding.sh ingest --backfill [--since 30d]`.

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

Point any SDK at the base URL, or set a signal-specific endpoint such as
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces`.

Framework notes: [Vercel AI Gateway](../integrations/ai-gateway.md), [eve](../integrations/eve.md).
