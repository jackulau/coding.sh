// `coding.sh init --remote <url> --key <ingest key>`: send this machine's sessions to a team's
// `coding.sh serve`. It writes one http sink named "team" (endpoint <url>/v1/ingest, the key as a
// Bearer header) into ~/.coding.sh/config.toml, replacing an earlier "team" sink and keeping
// every other line. The server is asked first, so a wrong URL or key fails before anything is written.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../core/config.ts";
import { INGEST_KEY_PREFIX, READ_KEY_PREFIX } from "../server/auth.ts";
import { UsageError } from "./args.ts";
import { CliError } from "./output.ts";

export const REMOTE_SINK = "team";

export interface Remote {
  /** Base URL, no trailing slash. */
  url: string;
  key: string;
  mode: "full" | "metadata";
}

export function parseRemote(rawUrl: string, rawKey: string | undefined, rawMode: string | undefined): Remote {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new UsageError(`--remote must be the server's URL, such as https://obs.example.com, got ${JSON.stringify(rawUrl)}`, { reason: "invalid_value" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`--remote must be an http:// or https:// URL, got ${JSON.stringify(rawUrl)}`, { reason: "invalid_value" });
  if (u.search || u.hash || u.username || u.password) throw new UsageError("--remote takes the server's base URL, with no query, fragment or credentials (the key goes in --key)", { reason: "invalid_value" });
  const url = `${u.origin}${u.pathname.replace(/\/+$/, "").replace(/\/v1\/ingest$/, "")}`;
  const key = rawKey?.trim();
  if (!key) throw new UsageError("--remote needs the ingest key the server gave you: --key csh_ik_… (or CODING_SH_INGEST_KEY)", { reason: "missing_value" });
  if (key.startsWith(READ_KEY_PREFIX)) throw new UsageError("That is a read key (csh_rk_…), which opens the viewer. Sending sessions needs an ingest key (csh_ik_…)", { reason: "invalid_value" });
  if (!key.startsWith(INGEST_KEY_PREFIX) && key.length < 16) throw new UsageError("--key must be an ingest key (csh_ik_…)", { reason: "invalid_value" });
  if (/[\s"\\]/.test(key)) throw new UsageError("--key has a space, quote or backslash; copy the key again", { reason: "invalid_value" });
  const mode = rawMode ?? "metadata";
  if (mode !== "full" && mode !== "metadata") throw new UsageError(`--remote-mode must be "metadata" or "full", got ${JSON.stringify(mode)}`, { reason: "invalid_value" });
  return { url, key, mode };
}

/** The `[[sinks]]` block for the remote, as TOML lines. */
export function remoteSinkBlock(r: Remote): string[] {
  return [
    "[[sinks]] # written by coding.sh init --remote",
    `name = "${REMOTE_SINK}"`,
    'kind = "http"',
    `endpoint = ${JSON.stringify(`${r.url}/v1/ingest`)}`,
    `mode = "${r.mode}"${r.mode === "metadata" ? ' # "full" also sends prompts, code and tool output' : ""}`,
    `headers = { Authorization = ${JSON.stringify(`Bearer ${r.key}`)} }`,
  ];
}

const isHeader = (line: string) => /^\s*\[/.test(line);
const isSinksHeader = (line: string) => /^\s*\[\[\s*sinks\s*\]\]\s*(#.*)?$/.test(line);
const NAMED = new RegExp(`^\\s*name\\s*=\\s*["']${REMOTE_SINK}["']`);

/** Config text with the "team" sink added, or replaced in place; every other line is kept. */
export function withRemoteSink(text: string, r: Remote): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const block = remoteSinkBlock(r);
  for (let i = 0; i < lines.length; i++) {
    if (!isSinksHeader(lines[i]!)) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end]!)) end++;
    if (!lines.slice(i + 1, end).some((l) => NAMED.test(l))) continue;
    // Keep the blank lines and comments that trail the old block (they belong to what follows).
    let last = end - 1;
    while (last > i && (!lines[last]!.trim() || lines[last]!.trim().startsWith("#"))) last--;
    lines.splice(i, last - i + 1, ...block);
    return lines.join(nl);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return [...lines, ...(lines.length ? [""] : []), ...block, ""].join(nl);
}

/**
 * Posts an empty batch with the key. 200 means the server is there and takes the key; anything
 * else stops init with what to fix.
 */
export async function probeRemote(r: Remote, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<void> {
  const endpoint = `${r.url}/v1/ingest`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${r.key}` },
      body: '{"v":0,"events":[]}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const why = err.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : (err.cause?.message ?? err.message);
    throw new CliError(`Can't reach ${r.url}: ${why}. Nothing was changed`, { reason: "remote_unreachable", next: ["Check the URL, then try:", `curl -s ${r.url}/healthz`] });
  }
  if (res.status === 200) return;
  if (res.status === 401) {
    throw new CliError(`${r.url} refused the key. Nothing was changed`, { reason: "remote_unauthorized", next: ["Use an ingest key the server knows (csh_ik_…). The server prints its first key on start: docker logs <container>"] });
  }
  if (res.status === 404 || res.status === 405) {
    throw new CliError(`${endpoint} answered ${res.status}: that is not a coding.sh serve that takes ingest. Nothing was changed`, { reason: "remote_not_serve" });
  }
  throw new CliError(`${endpoint} answered ${res.status}. Nothing was changed`, { reason: "remote_error", next: ["Check the server:", `curl -s ${r.url}/readyz`] });
}

/** Loads the edited config with the real loader, so a sink that would not parse is never written. */
export function validateConfigText(text: string, env: NodeJS.ProcessEnv): void {
  const dir = mkdtempSync(join(tmpdir(), "codingsh-remote-"));
  try {
    const file = join(dir, "config.toml");
    writeFileSync(file, text, { mode: 0o600 });
    loadConfig({ env: { ...env, CODING_SH_STORE_URL: undefined, CODING_SH_BLOB_URL: undefined }, file });
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(`Can't add the team sink to the config: ${e.message}. Nothing was changed`, { reason: "invalid_config" });
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
