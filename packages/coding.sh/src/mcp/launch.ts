// How agents launch the coding.sh MCP server. Kept free of server imports so
// init and the config printer stay light.
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { paths } from "../core/paths.ts";
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
 * How an agent config should launch the server. Installed from a bundle
 * (`cliPath` known), agents run `node ~/.coding.sh/bin/mcp.mjs`: a launcher
 * at a stable path that starts whichever CLI bin/cli-path names, so the
 * entry survives node version switches, npx cache eviction and updates
 * (init and update rewrite cli-path). Without a bundle (running from
 * source), the `coding.sh` binary on PATH.
 */
export function mcpLaunchSpec(cliPath?: string, env: NodeJS.ProcessEnv = process.env): McpServerSpec {
  return cliPath ? { name: MCP_CONFIG_NAME, command: "node", args: [paths(env).mcpLauncher] } : { name: MCP_CONFIG_NAME, command: "coding.sh", args: ["mcp"] };
}

/** The launch pinned to this node binary and cli.mjs (for `mcp config` before init has written the launcher). */
export function pinnedLaunchSpec(cliPath: string): McpServerSpec {
  return { name: MCP_CONFIG_NAME, command: process.execPath, args: [cliPath, "mcp"] };
}

/** Source of ~/.coding.sh/bin/mcp.mjs. */
export function mcpLauncherSource(): string {
  return `#!/usr/bin/env node
// coding.sh MCP launcher, written by \`coding.sh init\`. Agent configs run
// \`node <this file>\`: a path that survives node upgrades, npx cache eviction
// and updates. It starts the installed CLI named in cli-path next to it.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
let cli;
try {
  cli = readFileSync(new URL("./cli-path", import.meta.url), "utf8").trim();
} catch {}
const args = ["mcp", ...process.argv.slice(2)];
if (cli && existsSync(cli)) {
  process.argv = [process.argv[0], cli, ...args];
  await import(pathToFileURL(cli).href);
} else {
  // No installed CLI recorded (or it is gone): the coding.sh on PATH.
  const child = spawn("coding.sh", args, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("error", () => {
    process.stderr.write("coding.sh: can't find the coding.sh CLI" + (cli ? " at " + cli : "") + "; run coding.sh init again\\n");
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
`;
}
