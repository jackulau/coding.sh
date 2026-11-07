#!/usr/bin/env node
// Fake MCP server, legacy era (2025-11-25 / 2025-06-18 / 2025-03-26): stdio, or `--http <port>`.
import { main } from "./fake-mcp-core.mjs";
main("legacy");
