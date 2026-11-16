// DIAGNOSTICS ONLY (throwaway branch). Loaded into every test process by test-ci.mjs when
// CSH_TRACE_DIR is set. Gives the process a trace function, logs its start and end, and logs
// event-loop lag (the viewer server and the DevTools socket share this loop).
import { mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CSH_TRACE_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `p-${process.pid}.jsonl`), "a");
  const now = () => Math.round((performance.timeOrigin + performance.now()) * 10) / 10;
  const trace = (ev, data) => {
    try {
      writeSync(fd, JSON.stringify({ t: now(), pid: process.pid, ev, ...data }) + "\n");
    } catch {}
  };
  globalThis.__cshTrace = trace;
  globalThis.__cshNow = now;
  const file = process.argv.slice(1).filter((a) => /\.test\.ts$/.test(a));
  trace("proc-start", { ppid: process.ppid, ctx: process.env.NODE_TEST_CONTEXT ?? "", files: file.length > 3 ? file.length : file, bootMs: Math.round(performance.now()) });
  let last = performance.now();
  setInterval(() => {
    const t = performance.now();
    if (t - last > 350) trace("lag", { ms: Math.round(t - last - 100) });
    last = t;
  }, 100).unref();
  process.on("exit", (code) => {
    const c = process.cpuUsage();
    trace("proc-end", { code, userMs: Math.round(c.user / 1000), sysMs: Math.round(c.system / 1000), upMs: Math.round(performance.now()) });
  });
}
