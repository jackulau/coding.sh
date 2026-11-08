// What to say when nothing is captured yet. Before `coding.sh init` the answer
// is "run init". After it, running init again changes nothing: capture starts
// with the next agent session, and sessions that were already open when init
// ran may not have loaded the hooks. Every empty state (show latest, status,
// improve, the MCP server, the viewer) gives the same answer from here.
import { existsSync } from "node:fs";
import { paths } from "../core/paths.ts";

/** `coding.sh init` has set up capture on this machine: it writes the hook bin before any agent config. */
export function captureSetUp(env: NodeJS.ProcessEnv): boolean {
  return existsSync(paths(env).hook);
}

/** Told once capture is set up: why nothing shows yet, and what to do. */
export const START_NEW_SESSION = "Start a new agent session to record it. Sessions that were already open may not have loaded the hooks";

/** The recovery step for "no sessions yet": what to do (no trailing colon) and the command. */
export function noSessionsNext(env: NodeJS.ProcessEnv): { label: string; command: string } {
  return captureSetUp(env) ? { label: `Capture is set up. ${START_NEW_SESSION}. If none shows up, check`, command: "coding.sh doctor" } : { label: "Install capture hooks", command: "coding.sh init" };
}

/** The same step as a CliError's `next` lines. */
export function noSessionsNextLines(env: NodeJS.ProcessEnv): string[] {
  const n = noSessionsNext(env);
  return [`${n.label}:`, n.command];
}

/** One sentence for an agent (MCP tools and hints): the same step in prose. */
export function noSessionsHint(env: NodeJS.ProcessEnv): string {
  return captureSetUp(env)
    ? `No sessions captured yet. Capture is set up: ${START_NEW_SESSION}. If this session should be recorded, check capture with \`coding.sh doctor\`.`
    : "No sessions captured yet. Run `coding.sh init` to install capture hooks, then use an agent.";
}
