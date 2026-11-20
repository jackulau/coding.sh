// Every on-disk location coding.sh uses. CODING_SH_HOME overrides the root so
// tests, CI and eval runs never touch a user's real data.
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.CODING_SH_HOME;
  return h ? resolve(expandHome(h, env)) : join(userHome(env), ".coding.sh");
}

export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

export function expandHome(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (p === "~") return userHome(env);
  if (p.startsWith("~/")) return join(userHome(env), p.slice(2));
  return p;
}

export function paths(env: NodeJS.ProcessEnv = process.env) {
  const root = dataHome(env);
  // resolve() or join() made root, so it is normalized, and a plain name after the separator is
  // what join(root, name) returns. The hook calls paths() on every event, and in its short-lived
  // process its join() calls took 0.2 to 0.5 ms (test/core/paths.test.ts checks the values).
  const r = root.endsWith(sep) ? root : root + sep;
  const bin = r + "bin";
  const spool = r + "spool";
  return {
    root,
    config: r + "config.toml",
    bin,
    hook: bin + sep + "hook.mjs",
    /** The POSIX sh fast path agents run outside Windows (spool/hook.sh); it hands what it does not cover to hook.mjs. */
    hookSh: bin + sep + "hook.sh",
    /** Text file holding the absolute path of the installed dist/cli.mjs (the hook starts background ingests with it). */
    cliPointer: bin + sep + "cli-path",
    /** Stable MCP entry agents run with `node`: starts the CLI named in cli-path (see mcp/launch.ts). */
    mcpLauncher: bin + sep + "mcp.mjs",
    spool,
    spoolErrors: spool + sep + "errors.log",
    index: r + "index.db",
    blobs: r + "blobs",
    repos: r + "repos",
    runs: r + "runs",
    backups: r + "backups",
    judgeCache: r + "judge-cache",
    /** Recorded model calls for `exp run --record/--replay` (src/llmcache). */
    llmCache: r + "llm-cache",
    /** Left by a background ingest that failed, until one works again (core/ingest-health.ts). */
    ingestStopped: r + "ingest-stopped.json",
    /** Claude Code's last plan usage reading, saved by `coding.sh statusline` (src/quota). */
    quota: r + "quota.json",
    /** Cross-process ingest lock (see core/lock.ts). */
    ingestLock: spool + sep + ".ingest.lock",
    /** Held for a whole re-parse run (core/reparse.ts), so one runs at a time. */
    reparseLock: r + "reparse.lock",
    /** Held while past sessions are imported (init, `ingest --backfill --background`); the viewer reads it. */
    importLock: r + "import.lock",
    /** Held while a transcript import stores events and sends them to `[[sinks]]` (core/ingest.ts backfill), so one does at a time. */
    sinkLock: r + "sinks.lock",
    /** Held while an ingest reads the transcripts of tail-read agents (cli/common.ts tailIngest), so one process does at a time. */
    tailLock: r + "tail.lock",
    /** Hook ownership for agents whose config files carry no coding.sh marker. */
    installs: r + "installs.json",
    /** Monitors and their cursors, spend and last errors (src/monitor, `coding.sh monitor`). */
    monitors: r + "monitors.json",
    /** Alert definitions, their states and their signing secrets (src/alerts, `coding.sh alert`); mode 600. */
    alerts: r + "alerts.json",
    /** The running `coding.sh proxy` (pid, url); see proxy/state.ts. */
    proxyState: r + "proxy.json",
    proxyLog: r + "proxy.log",
    /** Agents `init --proxy` routed through the proxy; while it exists, the hook restarts a stopped proxy. */
    proxyInstalls: r + "proxy-installs.json",
    /** Spend budgets set with `coding.sh budget set` (src/budget). */
    budgets: r + "budgets.json",
    /** Week and month spend the status line reuses for up to 60 s (src/budget statuslineStatuses). */
    budgetSpend: r + "budget-spend.json",
    /** Acks and snoozes of `coding.sh work` items (core/work-overlay.ts). */
    work: r + "work.json",
  };
}
