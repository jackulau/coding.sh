import { defineEvalConfig } from "eve/evals";

// eve's own evals (`npm run eval:eve`). No judge is used: the default mock
// model is deterministic, so plain assertions are enough and no key is needed.
export default defineEvalConfig({ maxConcurrency: 2, timeoutMs: 60_000 });
