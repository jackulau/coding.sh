// Standalone entry: `node src/mcp/main.ts` serves the coding.sh MCP server on
// stdio (tests and tool evals use it before the CLI wiring exists; users run
// `coding.sh mcp`).
import { runStdioServer } from "./server.ts";

await runStdioServer();
