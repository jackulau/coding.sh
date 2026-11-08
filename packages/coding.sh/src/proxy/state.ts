// The running proxy's state file (~/.coding.sh/proxy.json) and settings.
// `coding.sh proxy` writes it while it runs; `proxy status`, `proxy stop`,
// `doctor` and `init --proxy` read it. Settings come from flags, then the
// `[proxy]` table of config.toml, then defaults.
import { readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { atomicWrite } from "../adapters/_shared/files.ts";
import { readUserConfigTable } from "../core/config.ts";
import { paths } from "../core/paths.ts";
import { DEFAULT_PROXY_PORT, DEFAULT_UPSTREAMS, type Upstreams } from "./server.ts";

export interface ProxyState {
  pid: number;
  url: string;
  host: string;
  port: number;
  startedAt: number;
  upstreams: Upstreams;
}

export const proxyStatePath = (env: NodeJS.ProcessEnv = process.env): string => join(paths(env).root, "proxy.json");
export const proxyLogPath = (env: NodeJS.ProcessEnv = process.env): string => join(paths(env).root, "proxy.log");

export function readProxyState(env: NodeJS.ProcessEnv = process.env): ProxyState | undefined {
  try {
    const s = JSON.parse(readFileSync(proxyStatePath(env), "utf8")) as ProxyState;
    return typeof s.pid === "number" && typeof s.url === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function writeProxyState(state: ProxyState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWrite(proxyStatePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

/** Removes the state file if it still names `pid` (another proxy may have replaced it). */
export function clearProxyState(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  if (readProxyState(env)?.pid !== pid) return;
  try {
    rmSync(proxyStatePath(env), { force: true });
  } catch {
    // best effort
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** GET <url>/__codingsh/health; resolves the parsed body, or undefined when nothing answers. */
export function probeProxy(url: string, timeoutMs = 1000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL("/__codingsh/health", url);
    } catch {
      resolve(undefined);
      return;
    }
    const req = request({ hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port, path: u.pathname, method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          resolve(res.statusCode === 200 && body.service === "coding.sh proxy" ? body : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

export interface ProxySettings {
  host: string;
  port: number;
  upstreams: Upstreams;
}

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** [proxy] in config.toml: port, host, anthropic_upstream, openai_upstream. */
export function proxySettings(env: NodeJS.ProcessEnv = process.env, flags: { port?: number; host?: string; anthropic?: string; openai?: string } = {}): ProxySettings {
  let t: Record<string, unknown> = {};
  try {
    const table = readUserConfigTable(env).table.proxy;
    if (table && typeof table === "object" && !Array.isArray(table)) t = table as Record<string, unknown>;
  } catch {
    // a broken config is reported by the commands that load it
  }
  const port = flags.port ?? (typeof t.port === "number" ? t.port : DEFAULT_PROXY_PORT);
  return {
    host: flags.host ?? strOf(t.host) ?? "127.0.0.1",
    port,
    upstreams: {
      anthropic: flags.anthropic ?? strOf(t.anthropic_upstream) ?? DEFAULT_UPSTREAMS.anthropic,
      openai: flags.openai ?? strOf(t.openai_upstream) ?? DEFAULT_UPSTREAMS.openai,
      chatgpt: strOf(t.chatgpt_upstream) ?? DEFAULT_UPSTREAMS.chatgpt,
    },
  };
}

/** The URL agents point at for a proxy on this port. */
export const proxyUrl = (port: number, host = "127.0.0.1"): string => `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host}:${port}`;

/** Environment that points SDK clients at the proxy. */
export function proxyEnv(url: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: url, OPENAI_BASE_URL: `${url}/v1` };
}
