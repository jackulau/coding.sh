import { OTLPHttpJsonTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

// Send every span to coding.sh's local OTLP receiver (`coding.sh collector`).
// eve's local `.eve/traces/` store keeps working alongside this destination.
// If nothing listens on the port, the exporter drops the batch; the agent is unaffected.
export default otelIntegration({
  traceExporter: new OTLPHttpJsonTraceExporter({
    url: process.env.CODING_SH_OTLP_URL ?? "http://127.0.0.1:4318/v1/traces",
  }),
});
