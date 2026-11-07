# Python apps on coding.sh

Three small apps that send to a `coding.sh serve` instance. They default to the shared mock LLM
(`examples/production/mock-llm`, port 9999), so they run without API keys.

| File | Shows |
|---|---|
| `app_sdk.py` | The SDK: `observe()` an OpenAI and an Anthropic client, one `trace()` in session `j2-sdk` (journey J2). |
| `app_otel.py` | Plain OpenTelemetry: one gen_ai `chat mock-gpt` span in conversation `j2-otel` (journey J2). |
| `app_api.py` | A production-style HTTP API: one trace per request in the caller's conversation, a tool span and a model call. |

```sh
python3 -m venv .venv && .venv/bin/pip install -q openai anthropic -e packages/sdk-python \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
node examples/production/mock-llm/server.mjs &

# SDK
CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=$INGEST_KEY_DEMO .venv/bin/python examples/production/python/app_sdk.py

# Plain OTel
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20$INGEST_KEY_DEMO" OTEL_SERVICE_NAME=j2-otel \
  .venv/bin/python examples/production/python/app_otel.py

# API service
CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=$INGEST_KEY_DEMO CODING_SH_SERVICE=support-api \
  .venv/bin/python examples/production/python/app_api.py --port 8080 &
curl -s localhost:8080/chat -d '{"conversation_id":"c-1","message":"where is order 42?"}'
```

With the `demo` key, the sessions show up as `demo/j2-sdk`, `demo/j2-otel` and `demo/c-1`.
