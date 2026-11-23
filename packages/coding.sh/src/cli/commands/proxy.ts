// coding.sh proxy: local pass-through for the Anthropic and OpenAI APIs that
// logs every model call into the store. stdout gets the environment that
// points an agent at it; one line per call goes to stderr.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runningCli } from "../../mcp/launch.ts";
import { isLoopbackHost } from "../../otel/receiver.ts";
import { budgetStatuses, readBudgets, type Budget } from "../../budget/index.ts";
import { budgetGuard, enforceable } from "../../proxy/budget.ts";
import { startLocalProxy } from "../../proxy/index.ts";
import { DEFAULT_PROXY_PORT } from "../../proxy/server.ts";
import { chainedUpstreams, clearProxyState, pidAlive, probeProxy, proxyEnv, proxyLogPath, proxySettings, proxyUrl, readProxyState, requestStop, upstreamProblem, writeProxyState, type ProxyState } from "../../proxy/state.ts";
import type { AgentEvent } from "../../schema/index.ts";
import { port as portFlag, str, withContext } from "../common.ts";
import { version } from "../meta.ts";
import { UsageError } from "../args.ts";
import { CliError, usd } from "../output.ts";
import { cliCommand, envLine } from "../next-steps.ts";
import type { CommandContext } from "../types.ts";
import { until } from "./budget.ts";

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
    if (running.port === s.port) throw new CliError(`A coding.sh proxy is already running on ${running.url} (pid ${running.pid})`, { reason: "already_running", next: ["Stop it:", cliCommand(c.env, ["proxy", "stop"])] });
  }
  if (c.flags.background) {
    const st = await startInBackground(c.env, c.flags, s.port);
    if (out.json) out.data({ url: st.url, pid: st.pid, env: proxyEnv(st.url), log: proxyLogPath(c.env) });
    else out.print(st.url);
    out.note(`Started in the background (pid ${st.pid}); log: ${proxyLogPath(c.env)}`);
    return 0;
  }

  const enforce = c.flags["enforce-budget"] === true;
  let budgets: Budget[] = [];
  try {
    if (enforce) budgets = readBudgets(c.env);
  } catch (e) {
    throw new CliError(`Can't read the budgets: ${(e as Error).message}`, { reason: "bad_budgets", next: ["See them:", cliCommand(c.env, ["budget", "list"])] });
  }
  return withContext(c, async (ctx) => {
    // budgets.json is read with the spend, so a budget set while the proxy runs applies within 30 s.
    // Only the spend of a budget a call can match is read: a --repo or --where one never blocks.
    const budget = enforce ? budgetGuard({ load: (now) => budgetStatuses(ctx.index, readBudgets(ctx.env).filter(enforceable), now), onError: (e) => out.warn(e.message) }) : undefined;
    let proxy;
    // `proxy stop` asks this proxy to stop with a POST that carries this secret, which only the
    // state file holds.
    const secret = randomBytes(32).toString("hex");
    let stopAsked = (): void => {};
    const asked = new Promise<"asked">((resolve) => (stopAsked = () => resolve("asked")));
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
        stop: { secret, onStop: () => stopAsked() },
        onError: (e) => out.warn(`not recorded: ${e.message}`),
        onEvent: c.flags.quiet ? undefined : (e) => out.note(callLine(e)),
        budget,
        onBlock: budget ? (b) => out.warn(`blocked a call: budget ${b.status.budget.id} is over its limit (${usd(b.status.spendUsd)} of ${usd(b.status.budget.limitUsd)}); resets in ${until(b.status.resetsAt)}`) : undefined,
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        // The same command on a free port: a detached child names --background, as the user ran it.
        const again = ["proxy"];
        if (c.env[DETACHED_ENV] === "1") again.push("--background");
        again.push(...startFlags(c.flags), "--port", "0");
        throw new CliError(`Can't start the proxy: port ${s.port} is in use`, { reason: "port_in_use", next: ["Pick another port:", cliCommand(c.env, again)] });
      }
      throw new CliError(`Can't start the proxy: ${(e as Error).message}`, { reason: "proxy_failed" });
    }
    // A client dials 127.0.0.1 even when the proxy listens on every interface.
    const url = proxyUrl(proxy.port, proxy.host);
    await writeProxyState({ pid: process.pid, url, host: proxy.host, port: proxy.port, startedAt: Date.now(), upstreams: s.upstreams, secret }, c.env);
    const vars = proxyEnv(url);
    if (out.json) out.data({ url, host: proxy.host, port: proxy.port, env: vars, upstreams: s.upstreams });
    else for (const [k, v] of Object.entries(vars)) out.print(envLine(c.env, k, v));
    if (!isLoopbackHost(proxy.host)) out.warn(`Listening on ${proxy.host}: the proxy has no auth, so anyone who can reach this port can send calls through it`);
    out.note(`Ready on ${url} (Anthropic → ${s.upstreams.anthropic}, OpenAI → ${s.upstreams.openai})`);
    if (enforce) out.note(`Enforcing budgets: a call a budget over its limit applies to gets a 429 (${enforcingCount(budgets)}; ${cliCommand(c.env, ["budget", "status"])})`);
    out.note(ctx.config.capture.mode === "metadata" ? "Capture mode metadata: no prompts or responses are stored" : "Logging every call; auth headers are forwarded, never stored");
    // A detached child (proxy --background) has no terminal for Ctrl-C to reach.
    out.note(c.env[DETACHED_ENV] === "1" ? `Stop with: ${cliCommand(c.env, ["proxy", "stop"])}` : "Press Ctrl-C to stop");
    const signalled = new Promise<"signal">((resolve) => c.signal.addEventListener("abort", () => resolve("signal"), { once: true }));
    const how = await Promise.race([asked, signalled]);
    if (how === "asked") out.note("Stopping: proxy stop asked. The calls in flight finish first");
    await proxy.close();
    clearProxyState(process.pid, c.env);
    return how === "asked" ? 0 : 130;
  });
}

/** `2 set`, or `1 of 2 set can block a call: …` when a --repo or --where budget, which never blocks, is among them. */
function enforcingCount(budgets: readonly Budget[]): string {
  const can = budgets.filter(enforceable).length;
  return can === budgets.length ? `${can} set` : `${can} of ${budgets.length} set can block a call: one with --repo or --where never does`;
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
  const args = [...process.execArgv, script, "proxy", ...startFlags(flags), "--port", String(flags.port ?? port)];
  const logPath = proxyLogPath(env);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const from = fstatSync(log).size;
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: { ...env, NODE_OPTIONS: undefined, [DETACHED_ENV]: "1" } });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const st = readProxyState(env);
    if (st && st.pid === child.pid && (await probeProxy(st.url))) return st;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  // A child that exited printed why (a port in use, budgets it can't read): say that, with its next steps.
  const failed = child.exitCode !== null ? printedError(readFrom(logPath, from)) : undefined;
  if (failed) throw new CliError(failed.message, { reason: "proxy_failed", next: failed.next.length ? failed.next : ["See its log:", logPath] });
  throw new CliError("The background proxy did not start", { reason: "proxy_failed", next: ["See its log:", logPath] });
}

/** The flags a proxy starts with, as arguments: `--host`, the upstreams and `--enforce-budget`. Not `--port`. */
function startFlags(flags: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const k of ["host", "anthropic-upstream", "openai-upstream"]) {
    const v = flags[k];
    if (v !== undefined) args.push(`--${k}`, String(v));
  }
  if (flags["enforce-budget"] === true) args.push("--enforce-budget");
  return args;
}

/** Up to 8 KB of a file from byte `from` on: what a detached child wrote to its log. */
function readFrom(path: string, from: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(8192);
      return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, from));
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** The last error in a CLI run's output, colored or not: its `✗ message` line and the next steps indented under it. */
function printedError(text: string): { message: string; next: string[] } | undefined {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\u001b\[[\d;]*m/g, "").split(/\r?\n/);
  const at = lines.findLastIndex((l) => l.startsWith("✗ "));
  if (at < 0) return undefined;
  const next: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("    ")) next.push(l.trim());
    else if (!l.startsWith("  ")) break;
  }
  return { message: lines[at]!.slice(2), next };
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

/** Why `init --proxy` routes no agent to the configured port, and the command that fixes it. */
export interface RoutePortProblem {
  reason: string;
  fix: [benefit: string, command: string];
}

/**
 * Why `init --proxy` can't point agents at the configured port, or undefined when it can: this
 * home's proxy runs there, or the port is free for ensureRunning to start one on. Another program
 * on the port would get the agents' calls. Port 0 changes each time the proxy starts. While this
 * home's proxy runs on another port, nothing starts one on the configured port.
 */
export async function routePortProblem(env: NodeJS.ProcessEnv): Promise<RoutePortProblem | undefined> {
  const s = proxySettings(env);
  const setPort = async (from: number) => {
    const free = await freePortFrom(s.host, from);
    return free === undefined ? `${cliCommand(env, ["config", "set", "proxy.port"])} <port>` : cliCommand(env, ["config", "set", "proxy.port", String(free)]);
  };
  if (s.port === 0) return { reason: "proxy.port is 0, which gives the proxy a new port each time it starts", fix: ["Pick a port that stays", await setPort(DEFAULT_PROXY_PORT)] };
  const st = readProxyState(env);
  const ours = st && pidAlive(st.pid) && (await probeProxy(st.url)) ? st : undefined;
  if (ours?.port === s.port) return undefined;
  const failed = await listenError(s.host, s.port);
  if (failed?.code === "EADDRINUSE") {
    const other = await probeProxy(proxyUrl(s.port, s.host));
    const who = other ? `another coding.sh proxy${typeof other.pid === "number" ? ` (pid ${other.pid})` : ""}` : "another program";
    return { reason: `port ${s.port} is in use by ${who}`, fix: ["Pick another port", await setPort(s.port + 1)] };
  }
  if (failed) return { reason: `the proxy can't listen on port ${s.port}: ${failed.message}`, fix: ["Pick another port", await setPort(s.port + 1)] };
  if (ours) return { reason: `the coding.sh proxy runs on port ${ours.port} (pid ${ours.pid}), not on port ${s.port}, which proxy.port sets`, fix: ["Stop it", cliCommand(env, ["proxy", "stop"])] };
  return undefined;
}

/** Why a server can't listen on `host`:`port` now, as the proxy would, or undefined when it can. */
function listenError(host: string, port: number): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e));
    server.listen(port, host, () => server.close(() => resolve(undefined)));
  });
}

/** The first of 20 ports from `from` on that a server can listen on, or undefined. */
async function freePortFrom(host: string, from: number): Promise<number | undefined> {
  for (let p = from; p < from + 20 && p <= 65535; p++) if (!(await listenError(host, p))) return p;
  return undefined;
}

/** How long `proxy stop` waits for a proxy it asked to stop while the calls in flight finish. */
const STOP_WAIT_MS = 10_000;

/**
 * Stops the proxy `st` names. It is asked first, over its own port with the secret from its state
 * file: it stops listening, lets the calls in flight finish, clears its state and exits. One still
 * running after `waitMs` is ended (`cut`), and so is one that can't be asked: an older version
 * wrote no secret, or nothing answered.
 */
export async function stopProxy(st: ProxyState, env: NodeJS.ProcessEnv, waitMs = STOP_WAIT_MS): Promise<{ cut: boolean }> {
  const asked = typeof st.secret === "string" && st.secret !== "" && (await requestStop(st.url, st.secret)) === 200;
  if (asked && (await exited(st.pid, waitMs))) {
    clearProxyState(st.pid, env);
    return { cut: false };
  }
  // On Windows either signal ends the process at once. Elsewhere SIGTERM stops it as Ctrl-C does;
  // SIGKILL ends one that was asked and is still running, which a SIGTERM would not.
  try {
    process.kill(st.pid, asked ? "SIGKILL" : "SIGTERM");
  } catch {
    // it exited in between
  }
  if (!(await exited(st.pid, 5000))) throw new CliError(`The proxy (pid ${st.pid}) did not stop`, { reason: "proxy_failed" });
  clearProxyState(st.pid, env);
  return { cut: asked };
}

/** Whether `pid` exits within `ms`. */
async function exited(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
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
    out.next("Start it", cliCommand(c.env, ["proxy", "--background"]));
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
  const { cut } = await stopProxy(st, c.env);
  out.ok(`Stopped the proxy on ${st.url}`);
  if (cut) out.warn(`It was still finishing calls after ${STOP_WAIT_MS / 1000} s, so it was ended`);
  return 0;
}

async function env(c: CommandContext): Promise<number> {
  const { out } = c;
  const s = settingsOf(c);
  const st = readProxyState(c.env);
  const url = st && pidAlive(st.pid) ? st.url : `http://127.0.0.1:${s.port}`;
  const vars = proxyEnv(url);
  if (out.json) out.data({ url, env: vars });
  else for (const [k, v] of Object.entries(vars)) out.print(envLine(c.env, k, v));
  // The lines name the URL whether or not a proxy answers there. Say so on stderr: stdout is
  // for eval or Invoke-Expression and stays the same.
  if (!out.json && !(await probeProxy(url))) out.warn(`No proxy answers on ${url}. Start it: ${cliCommand(c.env, ["proxy", "--background"])}`);
  return 0;
}
