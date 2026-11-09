// Every on-disk location coding.sh uses. CODING_SH_HOME overrides the root so
// tests, CI and eval runs never touch a user's real data.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  return {
    root,
    config: join(root, "config.toml"),
    bin: join(root, "bin"),
    hook: join(root, "bin", "hook.mjs"),
    /** The POSIX sh fast path agents run outside Windows (spool/hook.sh); it hands what it does not cover to hook.mjs. */
    hookSh: join(root, "bin", "hook.sh"),
    /** Text file holding the absolute path of the installed dist/cli.mjs (the hook starts background ingests with it). */
    cliPointer: join(root, "bin", "cli-path"),
    /** Stable MCP entry agents run with `node`: starts the CLI named in cli-path (see mcp/launch.ts). */
    mcpLauncher: join(root, "bin", "mcp.mjs"),
    spool: join(root, "spool"),
    spoolErrors: join(root, "spool", "errors.log"),
    index: join(root, "index.db"),
    blobs: join(root, "blobs"),
    repos: join(root, "repos"),
    runs: join(root, "runs"),
    backups: join(root, "backups"),
    judgeCache: join(root, "judge-cache"),
    /** Recorded model calls for `exp run --record/--replay` (src/llmcache). */
    llmCache: join(root, "llm-cache"),
    /** Cross-process ingest lock (see core/lock.ts). */
    ingestLock: join(root, "spool", ".ingest.lock"),
    /** Held for a whole re-parse run (core/reparse.ts), so one runs at a time. */
    reparseLock: join(root, "reparse.lock"),
    /** Held while past sessions are imported (init, `ingest --backfill --background`); the viewer reads it. */
    importLock: join(root, "import.lock"),
    /** Hook ownership for agents whose config files carry no coding.sh marker. */
    installs: join(root, "installs.json"),
    /** The running `coding.sh proxy` (pid, url); see proxy/state.ts. */
    proxyState: join(root, "proxy.json"),
    proxyLog: join(root, "proxy.log"),
    /** Agents `init --proxy` routed through the proxy; while it exists, the hook restarts a stopped proxy. */
    proxyInstalls: join(root, "proxy-installs.json"),
  };
}
