// Hook-entry helpers shared by every hook-based adapter.
//
// Every adapter installs the same command:
//   node "<~/.coding.sh/bin/hook.mjs>" <agent-id> <EventName> [flags]
// Our entries are recognized by a `_codingsh: true` marker where the format
// tolerates unknown keys, and always by the command itself (path to our
// hook.mjs + agent id), so uninstall removes only what we added.
import { paths } from "../../core/paths.ts";
import { isObject } from "./files.ts";

export const MARKER_KEY = "_codingsh";
/** Comment tag used in formats without unknown-key tolerance (TOML, JS). */
export const MARKER_COMMENT = "coding.sh";

/** Quote a path for a hook command line (POSIX sh and cmd.exe both accept double quotes). */
export function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `node "<hook>" <agent> <event> [extra…]` — the path is always quoted. */
export function buildHookCommand(hookPath: string, agent: string, event: string, extra: string[] = []): string {
  const quoted = `"${hookPath.replace(/(["\\$`])/g, "\\$1")}"`;
  return ["node", quoted, agent, event, ...extra.map(quoteArg)].join(" ");
}

/** Argv form of the same command, for formats that take an array (e.g. OpenCode plugins). */
export function hookArgv(hookPath: string, agent: string, event: string, extra: string[] = []): string[] {
  return ["node", hookPath, agent, event, ...extra];
}

const HOOK_CMD_RE = /\bnode(?:\.exe)?["']?\s+["']?([^"']*?hook\.mjs)["']?\s+([A-Za-z0-9_-]+)(?:\s|$)/;

/** Parse a command we generated: hook path + agent id, else undefined. */
export function parseHookCommand(cmd: unknown): { hookPath: string; agent: string } | undefined {
  if (typeof cmd !== "string") return undefined;
  const m = HOOK_CMD_RE.exec(cmd);
  if (!m || !m[1] || !m[2]) return undefined;
  return { hookPath: m[1].replace(/\\(["\\$`])/g, "$1"), agent: m[2] };
}

/**
 * True when `cmd` invokes coding.sh's hook for `agent` (any agent when omitted).
 * Accepts our default path (…/.coding.sh/bin/hook.mjs), the current
 * CODING_SH_HOME hook path, or any `knownHookPaths`.
 */
export function isCodingShCommand(cmd: unknown, agent?: string, knownHookPaths: string[] = [], env: NodeJS.ProcessEnv = process.env): boolean {
  const p = parseHookCommand(cmd);
  if (!p) return false;
  if (agent && p.agent !== agent) return false;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const hp = norm(p.hookPath);
  if (/(^|\/)\.?coding\.sh\/bin\/hook\.mjs$/.test(hp)) return true;
  return [paths(env).hook, ...knownHookPaths].some((k) => norm(k) === hp);
}

/** An entry is ours when it carries the marker or runs our hook command. */
export function isOurEntry(entry: unknown, agent: string, commandKeys: string[] = ["command"], knownHookPaths: string[] = []): boolean {
  if (!isObject(entry)) return false;
  if (entry[MARKER_KEY] === true) return true;
  return commandKeys.some((k) => isCodingShCommand(entry[k], agent, knownHookPaths));
}

// ---------------------------------------------------------------- nested (Claude-shaped)

/**
 * One hook registration in the Claude-shaped layout used by Claude Code, Codex
 * hooks.json, Droid, Qwen, Gemini:
 *   hooks.<event> = [{ matcher?, hooks: [{ type: "command", command, timeout? }] }]
 */
export interface NestedHookSpec {
  event: string;
  matcher?: string;
  /** The hook object itself, e.g. { type: "command", command, timeout }. */
  hook: Record<string, unknown>;
}

export interface MergeOpts {
  agent: string;
  /** Add `_codingsh: true` to our hook objects (only where the agent tolerates unknown keys). */
  marker: boolean;
  /** Keys on a hook object that hold the command (default ["command"]). */
  commandKeys?: string[];
  knownHookPaths?: string[];
}

function ourHookFilter(o: MergeOpts) {
  return (h: unknown) => isOurEntry(h, o.agent, o.commandKeys ?? ["command"], o.knownHookPaths ?? []);
}

/** Removes our hook objects from a nested hooks map; drops emptied groups/events. */
export function stripNestedHooks(hooks: unknown, o: Omit<MergeOpts, "marker">): Record<string, unknown> {
  const isOurs = ourHookFilter({ ...o, marker: false });
  const out: Record<string, unknown> = {};
  if (!isObject(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const inner = g.hooks.filter((h) => !isOurs(h));
      if (inner.length === g.hooks.length) kept.push(g);
      else if (inner.length > 0) kept.push({ ...g, hooks: inner });
      // A group whose hooks were all ours is dropped entirely.
    }
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** Our current registrations in a nested hooks map, as comparable specs. */
export function listNestedHooks(hooks: unknown, o: Omit<MergeOpts, "marker">): NestedHookSpec[] {
  const isOurs = ourHookFilter({ ...o, marker: false });
  const found: NestedHookSpec[] = [];
  if (!isObject(hooks)) return found;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (!isOurs(h) || !isObject(h)) continue;
        const spec: NestedHookSpec = { event, hook: h };
        if (typeof g.matcher === "string") spec.matcher = g.matcher;
        found.push(spec);
      }
    }
  }
  return found;
}

function withMarker(hook: Record<string, unknown>, marker: boolean): Record<string, unknown> {
  return marker ? { ...hook, [MARKER_KEY]: true } : { ...hook };
}

const specKey = (s: NestedHookSpec) => JSON.stringify([s.event, s.matcher ?? null, Object.entries(s.hook).sort(([a], [b]) => a.localeCompare(b))]);

/**
 * Merges our hooks into a nested hooks map. Idempotent: when exactly our specs
 * are already present the original object is returned unchanged; otherwise our
 * old entries are stripped and the new ones appended after the user's (so
 * position-keyed state such as Codex trust hashes of user hooks never shifts).
 */
export function mergeNestedHooks(hooks: unknown, specs: NestedHookSpec[], o: MergeOpts): Record<string, unknown> {
  const desired = specs.map((s) => ({ ...s, hook: withMarker(s.hook, o.marker) }));
  const current = listNestedHooks(hooks, o);
  const a = current.map(specKey).sort();
  const b = desired.map(specKey).sort();
  if (isObject(hooks) && a.length === b.length && a.every((k, i) => k === b[i])) return hooks;
  const out = stripNestedHooks(hooks, o);
  for (const s of desired) {
    const group: Record<string, unknown> = {};
    if (s.matcher !== undefined) group.matcher = s.matcher;
    group.hooks = [s.hook];
    const list = Array.isArray(out[s.event]) ? (out[s.event] as unknown[]) : [];
    out[s.event] = [...list, group];
  }
  return out;
}

// ---------------------------------------------------------------- flat (Cursor/Copilot-shaped)

/** Flat layout: hooks.<event> = [{ command, … }] (Cursor, Copilot, Goose plugins). */
export interface FlatHookSpec {
  event: string;
  entry: Record<string, unknown>;
}

export function stripFlatHooks(hooks: unknown, o: Omit<MergeOpts, "marker">): Record<string, unknown> {
  const isOurs = ourHookFilter({ ...o, marker: false });
  const out: Record<string, unknown> = {};
  if (!isObject(hooks)) return out;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      out[event] = list;
      continue;
    }
    const kept = list.filter((e) => !isOurs(e));
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

export function listFlatHooks(hooks: unknown, o: Omit<MergeOpts, "marker">): FlatHookSpec[] {
  const isOurs = ourHookFilter({ ...o, marker: false });
  const found: FlatHookSpec[] = [];
  if (!isObject(hooks)) return found;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) if (isOurs(e) && isObject(e)) found.push({ event, entry: e });
  }
  return found;
}

const flatKey = (s: FlatHookSpec) => JSON.stringify([s.event, Object.entries(s.entry).sort(([a], [b]) => a.localeCompare(b))]);

/** Flat-layout counterpart of mergeNestedHooks (same idempotency and ordering rules). */
export function mergeFlatHooks(hooks: unknown, specs: FlatHookSpec[], o: MergeOpts): Record<string, unknown> {
  const desired = specs.map((s) => ({ event: s.event, entry: withMarker(s.entry, o.marker) }));
  const a = listFlatHooks(hooks, o).map(flatKey).sort();
  const b = desired.map(flatKey).sort();
  if (isObject(hooks) && a.length === b.length && a.every((k, i) => k === b[i])) return hooks;
  const out = stripFlatHooks(hooks, o);
  for (const s of desired) {
    const list = Array.isArray(out[s.event]) ? (out[s.event] as unknown[]) : [];
    out[s.event] = [...list, s.entry];
  }
  return out;
}
