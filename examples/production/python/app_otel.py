"""J2 (plain OpenTelemetry path): one gen_ai `chat mock-gpt` span in conversation "j2-otel".

    pip install openai opentelemetry-sdk opentelemetry-exporter-otlp-proto-http coding-sh
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\
    OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20$CODING_SH_INGEST_KEY" OTEL_SERVICE_NAME=j2-otel \\
      python app_otel.py

Nothing here is coding.sh specific except `configure()`, which is the usual TracerProvider +
BatchSpanProcessor + OTLPSpanExporter setup (it reads the standard OTEL_* env vars, or
CODING_SH_URL / CODING_SH_INGEST_KEY when those are unset). Any OTel instrumentation that emits
gen_ai semconv spans (e.g. opentelemetry-instrumentation-openai-v2) works the same way.
"""

import json
import os

from coding_sh.otel import configure
from openai import OpenAI

provider = configure()
if provider is None:
    raise SystemExit("set OTEL_EXPORTER_OTLP_ENDPOINT (or CODING_SH_URL) and install coding-sh[otel]")
tracer = provider.get_tracer("app_otel")

client = OpenAI(base_url=os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:9999/v1"), api_key=os.environ.get("OPENAI_API_KEY", "mock"))
model = os.environ.get("OPENAI_MODEL", "mock-gpt")
messages = [{"role": "user", "content": "ping"}]

with tracer.start_as_current_span("chat " + model) as span:
    span.set_attribute("gen_ai.operation.name", "chat")
    span.set_attribute("gen_ai.provider.name", "openai")
    span.set_attribute("gen_ai.request.model", model)
    span.set_attribute("gen_ai.conversation.id", os.environ.get("SESSION_ID", "j2-otel"))
    span.set_attribute("gen_ai.input.messages", '[{"role":"user","parts":[{"type":"text","content":"ping"}]}]')
    r = client.chat.completions.create(model=model, messages=messages)
    span.set_attribute("gen_ai.response.model", r.model)
    span.set_attribute("gen_ai.response.finish_reasons", [r.choices[0].finish_reason])
    span.set_attribute("gen_ai.usage.input_tokens", r.usage.prompt_tokens)
    span.set_attribute("gen_ai.usage.output_tokens", r.usage.completion_tokens)
    span.set_attribute(
        "gen_ai.output.messages",
        '[{"role":"assistant","parts":[{"type":"text","content":%s}]}]' % json.dumps(r.choices[0].message.content),
    )
    print(r.choices[0].message.content)

provider.shutdown()  # flushes the batch processor
