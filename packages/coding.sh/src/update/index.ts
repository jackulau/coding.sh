// Update alerts, the update-notifier way: a command never waits on the network.
//
//   notice(env, out)      after a command: prints one dim stderr line from the
//                         cached result, then (at most once per 24 h) spawns a
//                         detached child that refreshes the cache for next time.
//   checkForUpdate(env)   awaited, throttled check for long-running processes
//                         (viewer, MCP server); never throws.
//   getUpdateStatus(env)  the small read model the viewer and MCP server serve.
//
// No network at all when CI is set, NO_UPDATE_NOTIFIER is set,
// CODING_SH_NO_UPDATE_CHECK=1, or config.toml has `[update] check = false`.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../cli/meta.ts";
import { paths } from "../core/paths.ts";
import { parseToml } from "../core/toml.ts";
import { refreshUpdateCache, type RefreshArgs, type UpdateCache } from "./refresh.ts";
import { isNewer } from "./semver.ts";

export type { UpdateCache } from "./refresh.ts";
export { compareSemver, isNewer, parseSemver } from "./semver.ts";

export const REPO = "jackulau/coding.sh";
export const NPM_NAME = "coding.sh";
export const GITHUB_API = "https://api.github.com";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;
export const UPDATE_COMMAND = "coding.sh update";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export interface UpdateOptions {
  /** Clock override (tests). */
  now?: () => number;
  /** fetch override (tests). */
  fetch?: typeof fetch;
  /** Running version override (tests). Default: the package version. */
  current?: string;
  /** Per-request timeout (default 1500 ms). */
  timeoutMs?: number;
  /** Endpoint overrides (tests). */
  githubApi?: string;
  npmRegistry?: string;
}

export function cacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).root, "update.json");
}

export function readCache(env: NodeJS.ProcessEnv = process.env): UpdateCache {
  try {
    const v = JSON.parse(readFileSync(cacheFile(env), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as UpdateCache) : {};
  } catch {
    return {};
  }
}

function writeCache(env: NodeJS.ProcessEnv, cache: UpdateCache): void {
  const file = cacheFile(env);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // best effort: a read-only home only means the notice may repeat
  }
}

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "TF_BUILD"].some((k) => truthy(env[k]));
}

/**
 * Why update checks are off, or undefined when they are on:
 * "ci", "NO_UPDATE_NOTIFIER", "CODING_SH_NO_UPDATE_CHECK" or "config".
 */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NO_UPDATE_NOTIFIER !== undefined) return "NO_UPDATE_NOTIFIER";
  if (truthy(env.CODING_SH_NO_UPDATE_CHECK)) return "CODING_SH_NO_UPDATE_CHECK";
  if (isCI(env)) return "ci";
  try {
    const root = parseToml(readFileSync(paths(env).config, "utf8"));
    const update = root.update;
    if (update && typeof update === "object" && !Array.isArray(update) && (update as Record<string, unknown>).check === false) return "config";
  } catch {
    // no config, or one `coding.sh doctor` will complain about
  }
  return undefined;
}

/** True when the last attempt is older than the 24 h check interval. */
export function isStale(cache: UpdateCache, now: number): boolean {
  const last = cache.attemptedAt ?? cache.checkedAt;
  return typeof last !== "number" || !(now - last < CHECK_INTERVAL_MS) || last > now + 60_000;
}

function refreshArgs(env: NodeJS.ProcessEnv, current: string, opts: UpdateOptions, now: number): RefreshArgs {
  return {
    file: cacheFile(env),
    current,
    repo: REPO,
    npmName: NPM_NAME,
    githubApi: opts.githubApi ?? GITHUB_API,
    npmRegistry: opts.npmRegistry ?? NPM_REGISTRY,
    timeoutMs: opts.timeoutMs ?? CHECK_TIMEOUT_MS,
    now,
    userAgent: `coding.sh/${current} (+https://github.com/${REPO})`,
  };
}

export interface CheckOptions extends UpdateOptions {
  /** Ignore the 24 h throttle and the opt-outs (explicit `coding.sh update`). */
  force?: boolean;
}

/**
 * Awaited check: returns the cache, refreshed from the network when it is older
 * than 24 h (or `force`). Never throws; opt-outs skip the network.
 */
export async function checkForUpdate(env: NodeJS.ProcessEnv = process.env, opts: CheckOptions = {}): Promise<UpdateCache> {
  try {
    const now = (opts.now ?? Date.now)();
    const cache = readCache(env);
    if (!opts.force && (updateChecksDisabled(env) || !isStale(cache, now))) return cache;
    return await refreshUpdateCache(refreshArgs(env, opts.current ?? version(), opts, now), opts.fetch ?? globalThis.fetch);
  } catch (e) {
    return { ...readCache(env), error: e instanceof Error ? e.message : String(e) };
  }
}

export type Spawner = (command: string, args: string[], options: { detached: boolean; stdio: "ignore"; windowsHide: boolean; env: NodeJS.ProcessEnv }) => { unref(): void };

export interface ScheduleOptions extends UpdateOptions {
  spawn?: Spawner;
}

/**
 * Starts a detached background refresh when the cache is stale and checks are
 * on. Records the attempt first so concurrent commands do not pile up children.
 * Returns true when a child was started.
 */
export function scheduleUpdateCheck(env: NodeJS.ProcessEnv = process.env, opts: ScheduleOptions = {}): boolean {
  try {
    if (updateChecksDisabled(env)) return false;
    const now = (opts.now ?? Date.now)();
    const cache = readCache(env);
    if (!isStale(cache, now)) return false;
    writeCache(env, { ...cache, attemptedAt: now });
    const args = refreshArgs(env, opts.current ?? version(), opts, now);
    // The child gets this function's own source: the bundle is a single file, so there is no worker script to point at.
    const script = `(${refreshUpdateCache.toString()})(JSON.parse(process.argv[1])).catch(() => {});`;
    const run = opts.spawn ?? (spawn as unknown as Spawner);
    const child = run(process.execPath, ["-e", script, JSON.stringify(args)], { detached: true, stdio: "ignore", windowsHide: true, env: { ...env, NODE_OPTIONS: undefined } });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ terminal notice

export interface NoticeOutput {
  json: boolean;
  style?(s: string, style: "faint", stream: "err"): string;
}

export interface NoticeOptions extends ScheduleOptions {
  stderr?: { write(s: string): unknown; isTTY?: boolean };
  /** The command that just ran; `update` never nags about itself. */
  command?: string;
}

/** The notice text, e.g. "Update available 0.1.0 → 0.2.0 · run: coding.sh update". */
export function noticeText(current: string, latest: string): string {
  return `Update available ${current} → ${latest} · run: ${UPDATE_COMMAND}`;
}

/**
 * Call once after a command finishes. Prints at most one dim stderr line
 * (TTY only, not --json, not CI, not opted out, once per day per version),
 * then schedules a background refresh if the cache is stale. Never throws,
 * never waits on the network. Returns true when it printed.
 */
export function notice(env: NodeJS.ProcessEnv, out: NoticeOutput, opts: NoticeOptions = {}): boolean {
  try {
    const stderr = opts.stderr ?? process.stderr;
    if (out.json || stderr.isTTY !== true || opts.command === "update") return false;
    if (updateChecksDisabled(env)) return false;
    const now = (opts.now ?? Date.now)();
    const current = opts.current ?? version();
    const cache = readCache(env);
    let printed = false;
    const latest = cache.latest;
    if (latest && isNewer(latest, current)) {
      const last = cache.notified;
      const recent = last !== undefined && last.version === latest && now - last.at < NOTICE_INTERVAL_MS && last.at <= now;
      if (!recent) {
        const text = noticeText(current, latest);
        stderr.write((out.style ? out.style(text, "faint", "err") : text) + "\n");
        // Written before the refresh child starts, so its copy keeps this record.
        writeCache(env, { ...cache, notified: { version: latest, at: now } });
        printed = true;
      }
    }
    scheduleUpdateCheck(env, opts);
    return printed;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ read model

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Release page / changelog. */
  url: string | null;
  /** Release notes (untrusted text). */
  notes: string | null;
  /** What `npm install -g` would install. */
  install: string | null;
  checkedAt: number | null;
  /** Why checks are off (see updateChecksDisabled), or null. */
  disabled: string | null;
  /** Last check failure, or null. */
  error: string | null;
  /** The command that installs the update. */
  command: string;
}

export interface StatusOptions extends CheckOptions {
  /** "if-stale" (default) checks the network when the cache is older than 24 h; "never" only reads the cache. */
  refresh?: "if-stale" | "never" | "force";
}

export function statusFromCache(cache: UpdateCache, current: string, disabled: string | undefined): UpdateStatus {
  const latest = cache.latest ?? null;
  return {
    current,
    latest,
    updateAvailable: latest !== null && isNewer(latest, current),
    url: cache.url ?? null,
    notes: cache.notes ?? null,
    install: cache.install ?? null,
    checkedAt: cache.checkedAt ?? null,
    disabled: disabled ?? null,
    error: cache.error ?? null,
    command: UPDATE_COMMAND,
  };
}

/** Current vs latest for the viewer and the MCP server. Never throws. */
export async function getUpdateStatus(env: NodeJS.ProcessEnv = process.env, opts: StatusOptions = {}): Promise<UpdateStatus> {
  const current = opts.current ?? version();
  const disabled = updateChecksDisabled(env);
  const refresh = opts.refresh ?? "if-stale";
  const cache = refresh === "never" ? readCache(env) : await checkForUpdate(env, { ...opts, current, force: refresh === "force" });
  return statusFromCache(cache, current, disabled);
}
