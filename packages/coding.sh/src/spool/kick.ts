// Session-end background ingest, started from the hook so captured sessions
// show up (and reach configured sinks) without anyone running `coding.sh ingest`.
//
// Cheap by construction: only on end-of-turn/session events, one tiny marker
// write, a look at the ingest lock, one small file read, and a detached `node
// cli.mjs ingest --background` that the hook never waits for. The child takes
// the ingest lock without waiting (exits quietly when another ingest holds
// it), so concurrent sessions never ingest the same spool range twice.
//
// No lost wakeups: the marker (`spool/.ingest.pending`) is touched AFTER the
// spool line is appended and BEFORE the lock is checked. A live holder clears
// it before each pass and checks it again after releasing (core/ingest.ts), so
// a kick skipped because an ingest was running is picked up by that ingest. A
// lock left by a dead holder (crash, SIGKILL) is stale and does not block.
//
// Skipped for eval runs (CODING_SH_RUN_ID: the runner ingests itself) and when
// CODING_SH_NO_AUTO_INGEST=1.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isLocked, wakeMarker } from "../core/lock.ts";
import { paths } from "../core/paths.ts";

/** Hook events that end a turn or a session, across agents. */
export const END_EVENT = /^(stop|session[._-]?end|session\.idle|afteragent)$/i;

export type KickSpawner = (command: string, args: string[], options: { detached: true; stdio: "ignore"; windowsHide: true; env: NodeJS.ProcessEnv }) => { unref(): void };

/** Returns the CLI path a background ingest was started with, or undefined when skipped. */
export function kickIngest(event: string, env: NodeJS.ProcessEnv = process.env, spawn?: KickSpawner): string | undefined {
  if (!END_EVENT.test(event) || env.CODING_SH_RUN_ID || env.CODING_SH_NO_AUTO_INGEST === "1") return undefined;
  const p = paths(env);
  try {
    writeFileSync(wakeMarker(p.ingestLock), "", { mode: 0o600 });
  } catch {
    // no spool dir yet: nothing for an ingest to miss
  }
  if (isLocked(p.ingestLock)) return undefined; // the live holder re-runs for the marker
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
