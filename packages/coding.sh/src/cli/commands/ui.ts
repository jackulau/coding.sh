// coding.sh ui: start the local viewer at once and ingest in a background
// worker (its own store connection), so the viewer shows what is indexed while
// a big spool drains and new hook events show up while it runs. Ctrl-C stops
// it (exit 130).
import { isLocked } from "../../core/lock.ts";
import { createRedactor } from "../../core/redact.ts";
import { pricesFor } from "../../core/pricing.ts";
import { snapshotBaseline } from "../../core/replay.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import { viewerForks } from "../../experiments/fork.ts";
import { proxySettings } from "../../proxy/state.ts";
import { startViewer } from "../../viewer/server.ts";
import { port as portFlag, str, withContext } from "../common.ts";
import { startBackgroundIngest, type BackgroundIngest } from "../ingest-worker.ts";
import { captureSetUp } from "../first-session.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const port = portFlag(c.flags.port, 4319);
  const host = str(c.flags.host) ?? "127.0.0.1";
  const open = c.flags.open !== false && out.interactive;
  return withContext(c, async (ctx) => {
    let viewer;
    let ingest: BackgroundIngest | undefined;
    try {
      // Same experiment store `coding.sh exp run` writes to (the index, or JSON files for a store without eval tables).
      const experiments = new FileEvalStore({ env: c.env, index: ctx.index });
      // Replays can start from a `coding.sh run` snapshot: its shadow repo is on this machine.
      const redactor = createRedactor({ redact: ctx.config.capture.redact, patterns: ctx.config.capture.redactPatterns, env: ctx.env });
      const replayBaseline = (s: Parameters<typeof snapshotBaseline>[0]) => snapshotBaseline(s, ctx.env, redactor);
      // A history import (init's background rest) holds the import lock: the empty list says so.
      const ingestStatus = () => {
        const s = ingest?.status();
        return s && { ...s, importing: isLocked(ctx.paths.importLock), captureSetUp: captureSetUp(c.env) };
      };
      // Fork from a replay step: the stored call sent again with this machine's key (the local viewer only).
      const fork = viewerForks({ index: ctx.index, blobs: ctx.blobs, env: c.env, prices: pricesFor(ctx.config.pricing), upstreams: proxySettings(c.env).upstreams });
      viewer = await startViewer({ index: ctx.index, blobs: ctx.blobs, port, host, open, experiments, ingestStatus, replayBaseline, fork });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") throw new CliError(`Can't start the viewer: port ${port} is in use`, { reason: "port_in_use", next: ["Pick another port:", "coding.sh ui --port 0"] });
      throw e;
    }
    // A remote store (--store / CODING_SH_STORE_URL) is read as is: never push this machine's spool into it.
    if (!ctx.storeOverridden) ingest = startBackgroundIngest({ env: c.env, cwd: c.cwd, onError: (m) => out.warn(`Background ingest failed: ${m}`) });
    if (out.json) out.data({ url: viewer.url, port: viewer.port });
    // Piped: the URL alone on stdout for scripts. In a terminal the note below already shows it.
    else if (!out.stdoutTTY) out.print(viewer.url);
    out.note(`Ready on ${viewer.url}`);
    out.note("Press Ctrl-C to stop");
    await new Promise<void>((resolve) => c.signal.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.all([ingest?.close(), viewer.close()]);
    return 130;
  });
}
