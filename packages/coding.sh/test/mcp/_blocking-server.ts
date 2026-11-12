// An MCP server on stdio whose `block` tool holds the event loop for `ms`
// milliseconds, the way a synchronous SQLite read does. protocol.test.ts sends
// a cancel while it blocks. It writes "block-start" to stderr as it starts blocking and
// "block-end" when it stops, so the test waits on those lines, not on timers.
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
        process.stderr.write("block-start\n");
        while (Date.now() < end) {
          // hold the event loop
        }
        process.stderr.write("block-end\n");
        return { done: true };
      },
    },
  ],
  context: () => undefined,
});

await serveStdio(server, { input: process.stdin, output: process.stdout });
