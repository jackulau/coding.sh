// What to say when nothing is captured yet. Before `coding.sh init` the answer
// is "run init". After it, running init again changes nothing: capture starts
// with the next agent session, and sessions that were already open when init
// ran may not have loaded the hooks. Every empty state (show latest, status,
// improve, the MCP server, the viewer) gives the same answer from here.
import { existsSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { nextStepBin } from "./next-steps.ts";

/** `coding.sh init` has set up capture on this machine: it writes the hook bin before any agent config. */
export function captureSetUp(env: NodeJS.ProcessEnv): boolean {
  return existsSync(paths(env).hook);
}

/** Told once capture is set up: why nothing shows yet, and what to do. */
export const START_NEW_SESSION = "Start a new agent session to record it. Sessions that were already open may not have loaded the hooks";

/** The recovery step for "no sessions yet": what to do (no trailing colon) and the command, as the user's shell runs it (nextStepBin). */
export function noSessionsNext(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { label: string; command: string } {
  const bin = nextStepBin(env, platform);
  return captureSetUp(env) ? { label: `Capture is set up. ${START_NEW_SESSION}. If none shows up, check`, command: `${bin} doctor` } : { label: "Install capture hooks", command: `${bin} init` };
}

/** The same step as a CliError's `next` lines. */
export function noSessionsNextLines(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const n = noSessionsNext(env, platform);
  return [`${n.label}:`, n.command];
}

/** One sentence for an agent (MCP tools and hints): the same step in prose. */
export function noSessionsHint(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const bin = nextStepBin(env, platform);
  return captureSetUp(env)
    ? `No sessions captured yet. Capture is set up: ${START_NEW_SESSION}. If this session should be recorded, check capture with \`${bin} doctor\`.`
    : `No sessions captured yet. Run \`${bin} init\` to install capture hooks, then use an agent.`;
}
