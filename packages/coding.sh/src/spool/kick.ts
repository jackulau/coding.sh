// Session-end background ingest, started from the hook so captured sessions
// show up (and reach configured sinks) without anyone running `coding.sh ingest`.
//
// Cheap by construction: only on end-of-turn/session events, a stat of the
// ingest lock (an ingest already running will be followed by the next read's
// lazy ingest), one small file read, and a detached `node cli.mjs ingest
// --background` that the hook never waits for. The child takes the ingest lock
// without waiting (exits quietly when another ingest holds it), so concurrent
// sessions never ingest the same spool range twice.
//
// Skipped for eval runs (CODING_SH_RUN_ID: the runner ingests itself) and when
// CODING_SH_NO_AUTO_INGEST=1.
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../core/paths.ts";

/** Hook events that end a turn or a session, across agents. */
export const END_EVENT = /^(stop|session[._-]?end|session\.idle|afteragent)$/i;

export type KickSpawner = (command: string, args: string[], options: { detached: true; stdio: "ignore"; windowsHide: true; env: NodeJS.ProcessEnv }) => { unref(): void };

/** Returns the CLI path a background ingest was started with, or undefined when skipped. */
export function kickIngest(event: string, env: NodeJS.ProcessEnv = process.env, spawn?: KickSpawner): string | undefined {
  if (!END_EVENT.test(event) || env.CODING_SH_RUN_ID || env.CODING_SH_NO_AUTO_INGEST === "1") return undefined;
  const p = paths(env);
  if (existsSync(p.ingestLock)) return undefined;
  let cli: string;
  try {
    cli = readFileSync(p.cliPointer, "utf8").trim();
  } catch {
    return undefined; // init ran from source, or before this existed: reads ingest lazily
  }
  if (!cli || !existsSync(cli)) return undefined;
  const run = spawn ?? (process.getBuiltinModule("node:child_process").spawn as unknown as KickSpawner);
  const child = run(process.execPath, [cli, "ingest", "--background"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...env, NODE_OPTIONS: undefined } });
  child.unref();
  return cli;
}
