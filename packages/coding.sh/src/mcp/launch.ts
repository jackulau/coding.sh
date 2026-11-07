// How agents launch the coding.sh MCP server. Kept free of server imports so
// init and the config printer stay light.
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { McpServerSpec } from "../core/types.ts";

/** Config key agents register the server under. */
export const MCP_CONFIG_NAME = "coding-sh";

/**
 * The running dist/cli.mjs, when coding.sh runs from a bundle (a stable path
 * for agent configs). npm installs `coding.sh` as a symlink to it, so the entry
 * is resolved first.
 */
export function runningCli(argv1: string | undefined = process.argv[1]): string | undefined {
  if (!argv1) return undefined;
  let entry = argv1;
  try {
    entry = realpathSync(argv1);
  } catch {
    // gone or unreadable: judge the path as given
  }
  return /^cli\.m?js$/.test(basename(entry)) ? entry : undefined;
}

/**
 * How an agent config should launch the server: the installed CLI with `mcp`.
 * `cliPath` is the absolute path of the running dist/cli.mjs when known (stable
 * installs, and no PATH needed for GUI-launched agents); otherwise the
 * `coding.sh` binary on PATH.
 */
export function mcpLaunchSpec(cliPath?: string): McpServerSpec {
  return cliPath ? { name: MCP_CONFIG_NAME, command: process.execPath, args: [cliPath, "mcp"] } : { name: MCP_CONFIG_NAME, command: "coding.sh", args: ["mcp"] };
}
