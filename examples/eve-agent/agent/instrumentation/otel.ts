import { otel } from "eve/instrumentation/otel";

// Process-wide OTel settings. coding.sh is local, so capture prompts and
// outputs (eve already does in development; this keeps it on for `eve start`).
// Tighten recordInputs/recordOutputs before pointing this at shared storage.
export default otel({
  resource: { "service.name": "eve-weather-agent" },
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
});
