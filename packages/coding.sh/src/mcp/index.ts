// coding.sh MCP server: public surface for the CLI command and for agent
// config writers (init) that register the server.
export { createCodingShMcp, instructions, runStdioServer, SERVER_NAME } from "./server.ts";
export type { CodingShMcp, CodingShMcpOptions } from "./server.ts";
export { LEGACY_VERSIONS, McpServer, MODERN_VERSION, serveStdio, ToolError } from "./protocol.ts";
export type { ToolDef } from "./protocol.ts";
export { buildTools, updateInfo } from "./tools.ts";
export type { ToolCtx } from "./tools.ts";
export { LATEST_URI, sessionUri } from "./resources.ts";
export { MCP_CONFIG_NAME, mcpLaunchSpec, runningCli } from "./launch.ts";
