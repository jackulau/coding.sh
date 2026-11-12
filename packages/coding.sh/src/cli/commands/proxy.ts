// coding.sh proxy: local pass-through for the Anthropic and OpenAI APIs that
// logs every model call into the store. stdout gets the environment that
// points an agent at it; one line per call goes to stderr.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runningCli } from "../../mcp/launch.ts";
import { isLoopbackHost } from "../../otel/receiver.ts";
import { startLocalProxy } from "../../proxy/index.ts";
import { chainedUpstreams, clearProxyState, pidAlive, probeProxy, proxyEnv, proxyLogPath, proxySettings, proxyUrl, readProxyState, upstreamProblem, writeProxyState, type ProxyState } from "../../proxy/state.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { port as portFlag, str, withContext } from "../common.ts";
import { version } from "../meta.ts";
import { UsageError } from "../args.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

const fmtTokens = (n: number | undefined): string => (n === undefined ? "-" : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

/** One stderr line per call: client, model, status, time, tokens. */
export function callLine(e: AgentEvent): string {
  const p = e.payload;
  const u = e.usage ?? {};
  const status = typeof p.statusCode === "number" ? String(p.statusCode) : String(p.errorClass ?? "err");
  const secs = e.durationMs !== undefined ? `${(e.durationMs / 1000).toFixed(1)}s` : "";
  const cache = u.cacheReadTokens || u.cacheWriteTokens ? ` cache r${fmtTokens(u.cacheReadTokens)}/w${fmtTokens(u.cacheWriteTokens)}` : "";
  const tokens = e.kind === "llm.call" ? ` in ${fmtTokens(u.inputTokens)} out ${fmtTokens(u.outputTokens)}${cache}` : "";
  const cost = typeof u.costUsd === "number" ? ` $${u.costUsd.toFixed(4)}` : "";
  return `${String(p.client ?? e.agent)} ${String(p.api)} ${e.model ?? "?"} ${status} ${secs}${tokens}${cost}  ${e.sessionId.slice(0, 12)}`;
}

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "status") return status(c);
  if (c.action === "stop") return stop(c);
  if (c.action === "env") return env(c);
  return start(c);
}

function settingsOf(c: CommandContext) {
  const flagPort = c.flags.port !== undefined ? portFlag(c.flags.port, 0) : undefined;
  const flags = { port: flagPort, host: str(c.flags.host), anthropic: str(c.flags["anthropic-upstream"]), openai: str(c.flags["openai-upstream"]) };
  // An upstream that is not an http(s) URL would fail on the first call; say so now, naming where it came from.
  for (const p of ["anthropic", "openai"] as const) {
    const problem = flags[p] !== undefined ? upstreamProblem(flags[p]!) : undefined;
    if (problem) throw new UsageError(`--${p}-upstream ${problem}: ${flags[p]}`, { reason: "invalid_value" });
  }
  const s = proxySettings(c.env, flags);
  for (const p of ["anthropic", "openai", "chatgpt"] as const) {
    const problem = upstreamProblem(s.upstreams[p]);
    if (problem) throw new UsageError(`proxy.${p}_upstream in config.toml ${problem}: ${s.upstreams[p]}`, { reason: "invalid_value" });
  }
  return s;
}

async function start(c: CommandContext): Promise<number> {
  const { out } = c;
  const s = settingsOf(c);
  const running = readProxyState(c.env);
  if (running && pidAlive(running.pid) && (await probeProxy(running.url))) {
    if (c.flags.background) {
      if (out.json) out.data({ url: running.url, pid: running.pid, env: proxyEnv(running.url), alreadyRunning: true });
      else out.print(running.url);
      out.note(`Already running (pid ${running.pid})`);
      return 0;
    }
    if (running.port === s.port) throw new CliError(`A coding.sh proxy is already running on ${running.url} (pid ${running.pid})`, { reason: "already_running", next: ["Stop it:", "coding.sh proxy stop"] });
  }
  if (c.flags.background) {
    const st = await startInBackground(c.env, c.flags, s.port);
    if (out.json) out.data({ url: st.url, pid: st.pid, env: proxyEnv(st.url), log: proxyLogPath(c.env) });
    else out.print(st.url);
    out.note(`Started in the background (pid ${st.pid}); log: ${proxyLogPath(c.env)}`);
    return 0;
  }

  return withContext(c, async (ctx) => {
    let proxy;
    try {
      proxy = await startLocalProxy({
        config: ctx.config,
        index: ctx.index,
        blobs: ctx.blobs,
        env: ctx.env,
        host: s.host,
        port: s.port,
        upstreams: s.upstreams,
        allowRemote: c.flags.host !== undefined && s.host !== "127.0.0.1",
        info: { version: version(), pid: process.pid },
        onError: (e) => out.warn(`not recorded: ${e.message}`),
        onEvent: c.flags.quiet ? undefined : (e) => out.note(callLine(e)),
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") throw new CliError(`Can't start the proxy: port ${s.port} is in use`, { reason: "port_in_use", next: ["Pick another port:", "coding.sh proxy --port 0"] });
      throw new CliError(`Can't start the proxy: ${(e as Error).message}`, { reason: "proxy_failed" });
    }
    // A client dials 127.0.0.1 even when the proxy listens on every interface.
    const url = proxyUrl(proxy.port, proxy.host);
    await writeProxyState({ pid: process.pid, url, host: proxy.host, port: proxy.port, startedAt: Date.now(), upstreams: s.upstreams }, c.env);
    const vars = proxyEnv(url);
    if (out.json) out.data({ url, host: proxy.host, port: proxy.port, env: vars, upstreams: s.upstreams });
    else for (const [k, v] of Object.entries(vars)) out.print(`export ${k}=${v}`);
    if (!isLoopbackHost(proxy.host)) out.warn(`Listening on ${proxy.host}: the proxy has no auth, so anyone who can reach this port can send calls through it`);
    out.note(`Ready on ${url} (Anthropic → ${s.upstreams.anthropic}, OpenAI → ${s.upstreams.openai})`);
    out.note(ctx.config.capture.mode === "metadata" ? "Capture mode metadata: no prompts or responses are stored" : "Logging every call; auth headers are forwarded, never stored");
    // A detached child (proxy --background) has no terminal for Ctrl-C to reach.
    out.note(c.env[DETACHED_ENV] === "1" ? "Stop with: coding.sh proxy stop" : "Press Ctrl-C to stop");
    await new Promise<void>((resolve) => c.signal.addEventListener("abort", () => resolve(), { once: true }));
    await proxy.close();
    clearProxyState(process.pid, c.env);
    return 130;
  });
}

/** Set on the detached child that `proxy --background` starts. */
const DETACHED_ENV = "CODING_SH_PROXY_DETACHED";

/**
 * Starts `coding.sh proxy` detached (stdout/stderr to
 * ~/.coding.sh/proxy.log) with the given flags and waits until it answers.
 * Also used by `init --proxy`.
 */
export async function startInBackground(env: NodeJS.ProcessEnv, flags: Record<string, unknown>, port: number): Promise<ProxyState> {
  // The CLI this process runs (a bundle's cli.mjs, through the bin symlink of a global install,
  // or src/cli/main.ts from a checkout), never some other script.
  const argv1 = process.argv[1];
  const script = runningCli(argv1) ?? (argv1 && basename(argv1) === "main.ts" ? argv1 : undefined);
  if (!script) throw new CliError("Can't find the coding.sh CLI to start in the background", { reason: "proxy_failed" });
  // No --quiet: the log keeps one line per call.
  const args = [...process.execArgv, script, "proxy"];
  for (const k of ["port", "host", "anthropic-upstream", "openai-upstream"]) {
    const v = flags[k];
    if (v !== undefined) args.push(`--${k}`, String(v));
  }
  if (flags.port === undefined) args.push("--port", String(port));
  mkdirSync(dirname(proxyLogPath(env)), { recursive: true });
  const log = openSync(proxyLogPath(env), "a");
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: { ...env, NODE_OPTIONS: undefined, [DETACHED_ENV]: "1" } });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const st = readProxyState(env);
    if (st && st.pid === child.pid && (await probeProxy(st.url))) return st;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new CliError("The background proxy did not start", { reason: "proxy_failed", next: ["See its log:", proxyLogPath(env)] });
}

/**
 * The running proxy, or one just started in the background on the configured
 * port. A running proxy that would send a chained agent's calls somewhere else
 * (it started before `init --proxy` chained through a base URL) is restarted.
 */
export async function ensureRunning(env: NodeJS.ProcessEnv): Promise<{ state: ProxyState; started: boolean; restarted?: boolean }> {
  const running = readProxyState(env);
  const s = proxySettings(env);
  if (running && pidAlive(running.pid) && (await probeProxy(running.url))) {
    const chained = chainedUpstreams(env);
    const stale = (["anthropic", "openai"] as const).some((p) => chained[p] !== undefined && running.upstreams?.[p] !== s.upstreams[p]);
    if (!stale) return { state: running, started: false };
    await stopProxy(running, env);
    return { state: await startInBackground(env, {}, s.port), started: true, restarted: true };
  }
  return { state: await startInBackground(env, {}, s.port), started: true };
}

async function stopProxy(st: ProxyState, env: NodeJS.ProcessEnv): Promise<void> {
  process.kill(st.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(st.pid)) await sleep(50);
  if (pidAlive(st.pid)) throw new CliError(`The proxy (pid ${st.pid}) did not stop`, { reason: "proxy_failed" });
  clearProxyState(st.pid, env);
}

async function status(c: CommandContext): Promise<number> {
  const { out } = c;
  const st = readProxyState(c.env);
  const alive = !!st && pidAlive(st.pid);
  const health = st && alive ? await probeProxy(st.url) : undefined;
  if (out.json) {
    out.data({ running: !!health, ...(st ? { url: st.url, pid: st.pid, port: st.port, startedAt: new Date(st.startedAt).toISOString(), upstreams: st.upstreams } : {}) });
    return health ? 0 : 1;
  }
  if (!health) {
    out.row("proxy", st ? `not answering on ${st.url}` : "not running", "warn");
    out.next("Start it", "coding.sh proxy --background");
    return 1;
  }
  out.row("proxy", `${st!.url} (pid ${st!.pid})`, "ok");
  out.row("anthropic", st!.upstreams.anthropic);
  out.row("openai", st!.upstreams.openai);
  return 0;
}

async function stop(c: CommandContext): Promise<number> {
  const { out } = c;
  const st = readProxyState(c.env);
  if (!st || !pidAlive(st.pid)) {
    if (st) clearProxyState(st.pid, c.env);
    out.note("No proxy is running");
    return 0;
  }
  await stopProxy(st, c.env);
  out.ok(`Stopped the proxy on ${st.url}`);
  return 0;
}

async function env(c: CommandContext): Promise<number> {
  const { out } = c;
  const s = settingsOf(c);
  const st = readProxyState(c.env);
  const url = st && pidAlive(st.pid) ? st.url : `http://127.0.0.1:${s.port}`;
  const vars = proxyEnv(url);
  if (out.json) out.data({ url, env: vars });
  else for (const [k, v] of Object.entries(vars)) out.print(`export ${k}=${v}`);
  return 0;
}
