// Drains the spool of $CODING_SH_HOME with small checkpoints, printing a line per checkpoint
// so ingest-crash.test.ts can kill it mid-drain. CRASH_AFTER=<method>:<n> kills the process
// itself right after the n-th call of that index method returns (putEvents, upsertSession,
// setCursor): a crash at an exact point between the writes of one checkpoint.
import { openContext } from "../../../src/core/context.ts";

const ctx = await openContext({ env: process.env });
const [method, nth] = (process.env.CRASH_AFTER ?? "").split(":");
if (method) {
  const index = ctx.index as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = index[method]!.bind(ctx.index);
  let calls = 0;
  index[method] = async (...args) => {
    const out = await real(...args);
    if (++calls === Number(nth)) process.kill(process.pid, "SIGKILL");
    return out;
  };
}
await ctx.ingest({ checkpointEvents: Number(process.env.CHECKPOINT_EVENTS ?? 25), onProgress: () => process.stdout.write("checkpoint\n") });
await ctx.close();
process.stdout.write("done\n");
