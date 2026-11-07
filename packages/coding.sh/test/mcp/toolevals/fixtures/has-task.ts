// Tool-eval check: exits 0 when the store holds an eval task drafted from
// <sessionId> with verifier <command>.
//   node has-task.ts <dataDir> <sessionId> <verifier>
import { openContext } from "../../../../src/core/context.ts";

const [data, session, verifier] = process.argv.slice(2);
const ctx = await openContext({ env: { ...process.env, CODING_SH_HOME: data } });
try {
  const tasks = await ctx.index.listTasks();
  const hit = tasks.find((t) => t.sourceSessionId === session && t.verifier.command === verifier);
  if (!hit) {
    process.stderr.write(`no task from ${session} with verifier ${JSON.stringify(verifier)} (${tasks.length} task(s))\n`);
    process.exitCode = 1;
  }
} finally {
  await ctx.close();
}
