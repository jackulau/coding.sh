// coding.sh mcp [serve|config]: the coding.sh MCP server.
//   serve (default)  JSON-RPC on stdio until stdin closes. Agents launch this;
//                    stdout carries protocol frames only, notes go to stderr.
//   config           prints how to register the server with agents.
import { UsageError } from "../args.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const action = c.action ?? c.positionals[0] ?? "serve";
  const { mcpLaunchSpec, pinnedLaunchSpec, runningCli } = await import("../../mcp/launch.ts");
  const { existsSync } = await import("node:fs");
  const { paths } = await import("../../core/paths.ts");
  const cli = runningCli();
  // The stable launcher once init has written it; before that, this exact node + cli.mjs.
  const spec = cli && !existsSync(paths(c.env).mcpLauncher) ? pinnedLaunchSpec(cli) : mcpLaunchSpec(cli, c.env);
  if (action === "config") {
    const doc = { mcpServers: { [spec.name]: { command: spec.command, args: spec.args } } };
    const cmd = [spec.command, ...spec.args].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
    if (c.out.json) {
      c.out.data({ server: spec, config: doc, commands: { claudeCode: `claude mcp add -s user ${spec.name} -- ${cmd}`, codex: `codex mcp add ${spec.name} -- ${cmd}` } });
      return 0;
    }
    c.out.print(JSON.stringify(doc, null, 2));
    c.out.note("coding.sh init registers this with every detected agent; to do it by hand:");
    c.out.next("Register with Claude Code", `claude mcp add -s user ${spec.name} -- ${cmd}`);
    c.out.next("Register with Codex", `codex mcp add ${spec.name} -- ${cmd}`);
    return 0;
  }
  if (action !== "serve") throw new UsageError(`Unknown command mcp ${action}`, { reason: "unknown_command", suggestion: "coding.sh mcp config" });
  if (process.stdin.isTTY) {
    // A person ran it by hand: say what it is (stderr) and keep serving.
    process.stderr.write(`coding.sh MCP server on stdio. Agents start this themselves; to see how to register it run: coding.sh mcp config\n`);
  }
  const { runStdioServer } = await import("../../mcp/server.ts");
  // main.ts turns the first Ctrl-C into c.signal; stop serving on it (exit 130).
  await runStdioServer({ env: c.env, cwd: c.cwd, signal: c.signal });
  return 0;
}
