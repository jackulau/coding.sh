// coding.sh ui: start the local viewer; ingest in the background so new hook
// events show up while it runs. Ctrl-C stops it (exit 130).
import { FileEvalStore } from "../../datasets/store.ts";
import { startViewer } from "../../viewer/server.ts";
import { autoIngest, port as portFlag, str, withContext } from "../common.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const port = portFlag(c.flags.port, 4319);
  const host = str(c.flags.host) ?? "127.0.0.1";
  const open = c.flags.open !== false && out.interactive;
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    let viewer;
    try {
      // Same experiment store `coding.sh exp run` writes to (the index, or JSON files for a store without eval tables).
      const experiments = new FileEvalStore({ env: c.env, index: ctx.index });
      viewer = await startViewer({ index: ctx.index, blobs: ctx.blobs, port, host, open, experiments });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") throw new CliError(`Can't start the viewer: port ${port} is in use`, { reason: "port_in_use", next: ["Pick another port:", "coding.sh ui --port 0"] });
      throw e;
    }
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      autoIngest(ctx)
        .catch((e: unknown) => out.warn(`Background ingest failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => (busy = false));
    }, 3000);
    if (out.json) out.data({ url: viewer.url, port: viewer.port });
    // Piped: the URL alone on stdout for scripts. In a terminal the note below already shows it.
    else if (!out.stdoutTTY) out.print(viewer.url);
    out.note(`Ready on ${viewer.url}`);
    out.note("Press Ctrl-C to stop");
    await new Promise<void>((resolve) => c.signal.addEventListener("abort", () => resolve(), { once: true }));
    clearInterval(timer);
    await viewer.close();
    return 130;
  });
}
