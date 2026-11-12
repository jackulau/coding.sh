// An MCP server on stdio whose `block` tool holds the event loop for `ms`
// milliseconds, the way a synchronous SQLite read does. protocol.test.ts sends
// a cancel while it blocks.
import { McpServer, serveStdio } from "../../src/mcp/protocol.ts";

const server = new McpServer<unknown>({
  serverInfo: { name: "blocking", version: "0" },
  instructions: () => "",
  tools: [
    {
      name: "block",
      title: "Block",
      description: "Busy-waits for ms milliseconds.",
      inputSchema: { type: "object", properties: { ms: { type: "number" } }, additionalProperties: false },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      run: async (a) => {
        const end = Date.now() + Number(a.ms ?? 0);
        while (Date.now() < end) {
          // hold the event loop
        }
        return { done: true };
      },
    },
  ],
  context: () => undefined,
});

await serveStdio(server, { input: process.stdin, output: process.stdout });
