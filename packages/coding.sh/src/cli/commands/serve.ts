// coding.sh serve: the production server (docs/PRODUCTION.md §1). One port for
// OTLP + native ingest, the viewer, /healthz, /readyz and /metrics. stdout gets the
// URL (or one JSON document) once ready; logs go to stderr. `keygen` prints a new
// key; `healthcheck` probes a running server for Docker.
import { ConfigError } from "../../core/config.ts";
import { generateKey, sha256 } from "../../server/auth.ts";
import { checkExposure, DEFAULT_SERVE_PORT, resolveServeConfig, ServeRefusal, type ServeConfig, type ServeRole } from "../../server/config.ts";
import { applyFirstStartKeys, firstStartText, loadOrCreateKeys, wantsFirstStartKeys, type FirstStartKeys } from "../../server/first-start.ts";
import { isProjectId } from "../../server/project.ts";
import { num, str } from "../common.ts";
import { UsageError } from "../args.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "keygen") return keygen(c);
  if (c.action === "healthcheck") return healthcheck(c);
  return serve(c);
}

function flagPort(c: CommandContext): number | undefined {
  const p = num(c.flags.port);
  if (p !== undefined && (!Number.isInteger(p) || p < 0 || p > 65535)) throw new UsageError(`--port must be 0-65535, got ${p}`, { reason: "invalid_value" });
  return p;
}

function resolve(c: CommandContext): ServeConfig {
  const config = str(c.flags.config);
  try {
    return resolveServeConfig(
      {
        host: str(c.flags.host),
        port: flagPort(c),
        config,
        role: str(c.flags.role) as ServeRole | undefined,
        insecure: c.flags.insecure === true ? true : undefined,
      },
      c.env,
    );
  } catch (e) {
    if (e instanceof ConfigError) {
      throw new CliError(`Invalid serve configuration: ${e.message}`, { reason: "invalid_config", exitCode: 2, next: ["See every setting in docs/PRODUCTION.md §1.1"] });
    }
    throw e;
  }
}

async function serve(c: CommandContext): Promise<number> {
  const { out } = c;
  const config = str(c.flags.config);
  if (config) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(config)) throw new UsageError(`Config file not found: ${config}`, { reason: "not_found" });
  }
  const cfg = resolve(c);
  // A public bind with no credentials at all makes (or reuses) its own pair of keys instead of refusing.
  let firstStart: FirstStartKeys | undefined;
  if (wantsFirstStartKeys(cfg)) {
    try {
      firstStart = loadOrCreateKeys(c.env);
    } catch (e) {
      if (e instanceof ConfigError) throw new CliError(`Invalid serve configuration: ${e.message}`, { reason: "invalid_config", exitCode: 2 });
      throw e;
    }
    applyFirstStartKeys(cfg, firstStart);
  }
  try {
    checkExposure(cfg);
  } catch (e) {
    if (e instanceof ServeRefusal) throw new UsageError(e.message, { reason: "insecure_bind" });
    throw e;
  }

  const { startServe } = await import("../../server/serve.ts");
  let handle;
  try {
    handle = await startServe(cfg);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new CliError(`Can't start the server: port ${cfg.port} is in use`, { reason: "port_in_use", next: ["Pick another port:", "coding.sh serve --port 0"] });
    }
    throw e;
  }

  const { body } = await handle.ready();
  const keys = firstStart ? { keys: { ingest: firstStart.ingest, read: firstStart.read, file: firstStart.file, created: firstStart.created } } : {};
  if (out.json) out.data({ url: handle.url, host: handle.host, port: handle.port, role: cfg.role, ready: body, ...keys });
  else {
    out.print(handle.url);
    // stdout, after the URL: the human channel `docker logs` shows (stderr carries JSON logs).
    if (firstStart) for (const l of firstStartText(firstStart, handle.url)) out.print(l);
  }

  // Graceful shutdown: the first SIGTERM/SIGINT drains and exits 0; a second exits at once.
  let signals = 0;
  let onSignal: (sig: NodeJS.Signals) => void = () => {};
  const stopped = new Promise<void>((resolveStop) => {
    onSignal = (sig) => {
      signals++;
      if (signals > 1) process.exit(sig === "SIGINT" ? 130 : 143);
      resolveStop();
    };
    c.signal.addEventListener("abort", () => resolveStop(), { once: true });
  });
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await stopped;
    await handle.shutdown();
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  return 0;
}

function keygen(c: CommandContext): number {
  const { out } = c;
  const read = c.flags.read === true;
  const project = str(c.flags.project) ?? "default";
  if (read ? project !== "*" && !isProjectId(project) : !isProjectId(project)) {
    throw new UsageError(`--project must match ^[a-z0-9][a-z0-9-]{0,62}$${read ? ' (or "*" for every project)' : ""}, got ${JSON.stringify(project)}`, { reason: "invalid_value" });
  }
  const key = generateKey(read ? "read" : "ingest");
  const hash = `sha256:${sha256(key)}`;
  const kind = read ? "read" : "ingest";
  if (out.json) {
    out.data({ key, sha256: hash, project, kind });
    return 0;
  }
  out.print(key);
  out.note("Shown once. Store it in the client's secret manager.");
  out.note("");
  out.note("Server env:");
  out.note(`  ${read ? "CODING_SH_READ_KEYS" : "CODING_SH_INGEST_KEYS"}=${project}:${hash}`);
  out.note("Or in the config file:");
  if (read) out.note(`  [serve.viewer]\n    read_keys = [{ project = "${project}", key = "${hash}" }]`);
  else out.note(`  [[serve.projects]]\n    id = "${project}"\n    ingest_keys = ["${hash}"]`);
  return 0;
}

function defaultHealthUrl(c: CommandContext): string {
  let port = DEFAULT_SERVE_PORT;
  try {
    port = resolve(c).port;
  } catch {
    const p = Number(c.env.CODING_SH_PORT ?? c.env.PORT);
    if (Number.isInteger(p) && p > 0 && p <= 65535) port = p;
  }
  return `http://127.0.0.1:${port}/healthz`;
}

async function healthcheck(c: CommandContext): Promise<number> {
  const { out } = c;
  const url = str(c.flags.url) ?? defaultHealthUrl(c);
  const timeout = num(c.flags.timeout) ?? 3000;
  let status = 0;
  let error: string | undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeout)) });
    status = res.status;
    await res.arrayBuffer().catch(() => {});
  } catch (e) {
    error = (e as Error).name === "TimeoutError" ? `no answer within ${timeout} ms` : ((e as Error & { cause?: Error }).cause?.message ?? (e as Error).message);
  }
  const ok = status === 200;
  if (out.json) out.data({ ok, url, status: status || null, ...(error ? { error } : {}) });
  else if (ok) out.ok(`${url} answered 200`);
  else out.fail(`${url} ${error ?? `answered ${status}`}`);
  return ok ? 0 : 1;
}
