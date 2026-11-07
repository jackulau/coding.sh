# Vercel AI Gateway

[AI Gateway](https://vercel.com/docs/ai-gateway) is one endpoint and one key for hundreds of models. coding.sh works with it in four ways:

| What | How | Code |
| --- | --- | --- |
| Detect | Sessions whose calls went through the gateway get the tag `gateway:vercel`. `coding.sh doctor` and `coding.sh gateway status` show which agent configs route through it. | `src/integrations/gateway/ids.ts`, `config.ts` |
| Cost | `coding.sh gateway enrich` adds the billed cost and the serving provider to each linked llm call. | `enrich.ts`, `client.ts` |
| Traces | The OTLP receiver maps gateway trace drains and AI SDK `gateway` spans. | `otel.ts` |
| Experiments | `coding.sh compare a b --gateway` runs both arms through the gateway. LLM graders take `"provider": "gateway"`. | `route.ts` |

Tests mock the gateway API with a local server. Nothing in the test suite calls Vercel.

## Route an agent through the gateway

Create a key at vercel.com/ai-gateway and export it as `AI_GATEWAY_API_KEY` ([coding agents docs](https://vercel.com/docs/ai-gateway/coding-agents)).

**Claude Code**: put this in `~/.claude/settings.json` or export it.

```json
{ "env": {
  "ANTHROPIC_BASE_URL": "https://ai-gateway.vercel.sh/claude-code",
  "ANTHROPIC_AUTH_TOKEN": "<your AI Gateway key>",
  "ANTHROPIC_API_KEY": ""
} }
```

Models from other providers are named `claude-code/<creator>/<model>`. Virtual models are `claude-code/vmc/<slug>`.

**Codex**: put this in `~/.codex/config.toml`.

```toml
model_provider = "vercel"
model = "openai/gpt-5"

[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "https://ai-gateway.vercel.sh/codex/v1"
env_key = "AI_GATEWAY_API_KEY"
wire_api = "responses"
```

**OpenCode** uses its built-in `vercel` provider (`"model": "vercel/anthropic/claude-sonnet-4.5"`). **Pi** uses `vercel-ai-gateway`.

**AI SDK**: pass a `"creator/model"` string, or `gateway("…")` from `@ai-sdk/gateway`. Then send telemetry to the receiver (see `src/otel/receiver.ts`).

```ts
const { text } = await generateText({ model: "openai/gpt-5", prompt, experimental_telemetry: { isEnabled: true } });
```

## Detection

Detection is read-only. coding.sh reads agent configs and env var names, never key values.

A session is tagged `gateway:vercel` on any of these signals:

- **The hook's env.** The hook saw `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` at `ai-gateway.vercel.sh`. Hooks inherit Claude Code's settings env, so this covers Claude Code.
- **A generation id.** A call carries a `gen_<ulid>` generation id. The gateway returns it as the chat completion `id`.
- **The provider or model.** The provider is a gateway provider (`vercel`, `gateway`, `vercel-ai-gateway`), or the model is `claude-code/…` or `vmc/…`.

The tag is not a failure. `failures` and `--flagged` ignore namespaced flags. To list tagged sessions, run `coding.sh sessions --flag gateway:vercel`.

## Cost and provider per call

```sh
coding.sh gateway enrich              # last 30 days
coding.sh gateway enrich --session latest --dry-run
coding.sh gateway enrich --offline    # cache and drained traces only, no API calls
```

The command links each llm call to a gateway generation in one of three ways:

1. **Generation id**, for Codex, OpenAI-compatible clients and the AI SDK.
2. **The provider's response id** (`msg_…`, `resp_…`), matched against drained traces' `vercel.ai_gateway.attempt.provider_response_id`.
3. **Client session id.** The gateway groups requests by session ([session affinity](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity)). Claude Code sends its session id as `x-claude-code-session-id`. A request with that session id goes to the nearest unlinked call within 5 minutes.

For each linked call, coding.sh reads the generation record. It tries the index cache first, then drained traces, then `GET /v1/generation?id=…` ([REST API](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)). The cache keeps only cost, provider, model, latency and token counts.

Each linked call gets a companion `vercel.ai_gateway.generation` span. The span stores the cost difference against what the call already reported. Session totals then equal what the gateway billed: the gateway debit, plus the provider's charge for BYOK. Re-runs are no-ops.

A record not ingested yet shows as `pending`. Run the command again a minute later.

For `vmc/<slug>` virtual models, each call records `virtualModel` and the `resolvedModel` that served it. A virtual model can change behind its slug, so this keeps experiment arms honest.

The key comes from `AI_GATEWAY_API_KEY` by default. To read it from elsewhere, set `[gateway] apiKeyEnv = "NAME"` or `apiKey = "${NAME}"` in `~/.coding.sh/config.toml`. coding.sh never prints, logs or stores the key. Captured `vck_…` keys are redacted.

## Trace drains

[Trace drains](https://vercel.com/docs/ai-gateway/observability-and-spend/trace-drains) need a Pro or Enterprise plan. They export one OTLP trace per request, and the endpoint must be publicly reachable. Tunnel to the local collector (`coding.sh collector`) and set the drain URL to `<tunnel>/v1/traces`.

The receiver maps each request as follows:

- **Root span**: one llm call with the billed and market cost, the generation id, the served provider and the credential type. Its tokens go in `reportedUsage`, not into totals, because the agent's own capture already counts them.
- **Routing and attempt spans**: plain spans, so failovers don't count as extra calls.
- **Session**: requests carry no conversation id, so they group into a daily session `ai-gateway-YYYY-MM-DD`. `gateway enrich` links them back to agent sessions.

## A/B across models with one key

```sh
coding.sh compare sonnet gpt5 --gateway --k 3
```

Each arm runs its bundle's model through the gateway:

- **Claude Code**: `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN`.
- **Codex**: `-c model_provider="vercel"` overrides. No config file is written.
- **OpenCode**: `vercel/<model>`.
- **Pi**: `--provider vercel-ai-gateway`.

The route applies to the agent only, never to setup or the verifier.

For `coding.sh exp`, give the command task the model in its env and run once per model. Then use `exp compare`.

```sh
coding.sh exp run --dataset qa --task '{"kind":"command","command":"node agent.mjs","env":{"MODEL":"anthropic/claude-sonnet-4.5"}}' --grader '{"kind":"llm","provider":"gateway","model":"openai/gpt-5"}'
```

## T3 Code

T3 Code drives Claude Code and Codex, so gateway routing comes from those agents' own config, set as above. Detection works per event, so T3 Code sessions get tagged and enriched as long as the T3 Code adapter keeps `provider`, `responseId` and `messageId` on its llm calls.

## Limits

- **Logs**: the gateway does not expose request logs over its API. Per-call data comes from `/v1/generation` or drains.
- **Claude Code ids**: Claude Code message ids are provider ids, not generation ids. Without a drain, Claude Code calls link only by client session id, and only if the transcript keeps `provider_metadata.gateway.routing`.
- **Session id in drains**: drain spans have no client session id attribute as of November 2026. coding.sh reads `session.id` if one appears.
