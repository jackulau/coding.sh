// Install/uninstall planners for JSON hook configs (nested Claude-shaped and
// flat Cursor-shaped). They plan FileChanges; applyChanges() writes them.
import type { FileChange } from "../../core/types.ts";
import { applyChanges, isObject, parseJsonObject, planEdit, planJsonEdit, readTextIfExists, stringifyJsonLike, type ApplyOpts } from "./files.ts";
import { exactUninstall, existedBeforeInstall, forgetInstall, recordInstall, restoreForInstall } from "./installs.ts";
import {
  buildHookCommand,
  listFlatHooks,
  listNestedHooks,
  mergeFlatHooks,
  mergeNestedHooks,
  stripFlatHooks,
  stripNestedHooks,
  type FlatHookSpec,
  type NestedHookSpec,
} from "./hooks.ts";

export interface HookEventSpec {
  event: string;
  /** Matcher for tool events ("*"); omitted for lifecycle events. */
  matcher?: string;
  /** Seconds (Claude/Codex) or the agent's own unit; omitted when the agent default is fine. */
  timeout?: number;
  /** Extra hook.mjs flags, e.g. ["--echo-continue"]. */
  extraArgs?: string[];
  /** Agent event name passed to hook.mjs when it differs from the config key. */
  hookEventName?: string;
}

export interface JsonHooksInstall {
  agent: string;
  file: string;
  hookCommand: string;
  events: HookEventSpec[];
  /** Add `_codingsh: true` (only for agents that tolerate unknown keys). */
  marker: boolean;
  /** Top-level object fields to ensure (e.g. { version: 1 } for Cursor). */
  ensure?: Record<string, unknown>;
  /** Build the hook object for a spec (nested) or entry (flat). */
  hookObject?: (command: string, e: HookEventSpec) => Record<string, unknown>;
}

function defaultHook(command: string, e: HookEventSpec): Record<string, unknown> {
  const h: Record<string, unknown> = { type: "command", command };
  if (e.timeout !== undefined) h.timeout = e.timeout;
  return h;
}

function commandFor(o: JsonHooksInstall, e: HookEventSpec): string {
  return buildHookCommand(o.hookCommand, o.agent, e.hookEventName ?? e.event, e.extraArgs);
}

const describe = (o: { agent: string; events: HookEventSpec[] }, verb: string) =>
  `${verb} coding.sh ${o.agent} hooks (${o.events.map((e) => e.event).join(", ")})`;

/** Plan: merge our nested hooks into `file` → { hooks: { Event: [{matcher, hooks:[…]}] } }. */
export function planNestedInstall(o: JsonHooksInstall): FileChange | undefined {
  const specs: NestedHookSpec[] = o.events.map((e) => {
    const s: NestedHookSpec = { event: e.event, hook: (o.hookObject ?? defaultHook)(commandFor(o, e), e) };
    if (e.matcher !== undefined) s.matcher = e.matcher;
    return s;
  });
  return planJsonEdit(
    o.file,
    (cfg) => {
      for (const [k, v] of Object.entries(o.ensure ?? {})) if (cfg[k] === undefined) cfg[k] = v;
      cfg.hooks = mergeNestedHooks(cfg.hooks, specs, { agent: o.agent, marker: o.marker });
      return cfg;
    },
    describe(o, "install"),
  );
}

/**
 * Plan: remove our nested hooks from `file`. While the file is exactly what
 * coding.sh last wrote, the original bytes come back (or the file is deleted
 * when coding.sh created it); otherwise only our entries are stripped.
 */
export function planNestedUninstall(agent: string, file: string, emptyShape: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): FileChange | undefined {
  return planHookUninstall(agent, file, emptyShape, env, (hooks) => (listNestedHooks(hooks, { agent }).length ? stripNestedHooks(hooks, { agent }) : undefined));
}

/** Plan: merge our flat hooks into `file` → { hooks: { event: [{command, …}] } }. */
export function planFlatInstall(o: JsonHooksInstall): FileChange | undefined {
  const specs: FlatHookSpec[] = o.events.map((e) => ({ event: e.event, entry: (o.hookObject ?? ((c) => ({ command: c })))(commandFor(o, e), e) }));
  return planJsonEdit(
    o.file,
    (cfg) => {
      for (const [k, v] of Object.entries(o.ensure ?? {})) if (cfg[k] === undefined) cfg[k] = v;
      cfg.hooks = mergeFlatHooks(cfg.hooks, specs, { agent: o.agent, marker: o.marker });
      return cfg;
    },
    describe(o, "install"),
  );
}

/** Plan: remove our flat hooks (exact restore as for nested); `emptyShape` (e.g. {version:1}) counts as empty. */
export function planFlatUninstall(agent: string, file: string, emptyShape: Record<string, unknown> = {}, commandKeys?: string[], env: NodeJS.ProcessEnv = process.env): FileChange | undefined {
  return planHookUninstall(agent, file, emptyShape, env, (hooks) => (listFlatHooks(hooks, { agent, commandKeys }).length ? stripFlatHooks(hooks, { agent, commandKeys }) : undefined));
}

/**
 * Shared uninstall planner. `strip` returns the hooks map without ours, or
 * undefined when the file holds none of ours (then nothing changes). A file
 * left in `emptyShape` is deleted only when coding.sh created it (or, for
 * installs made before installs.json tracked hook files, when we cannot tell).
 */
function planHookUninstall(
  agent: string,
  file: string,
  emptyShape: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  strip: (hooks: unknown) => Record<string, unknown> | undefined,
): FileChange | undefined {
  const text = readTextIfExists(file);
  if (text === undefined) return undefined;
  const cfg = parseJsonObject(file, text);
  if (!isObject(cfg.hooks)) return undefined;
  const stripped = strip(cfg.hooks);
  if (stripped === undefined) return undefined;
  const rest = structuredClone(cfg);
  if (Object.keys(stripped).length) rest.hooks = stripped;
  else delete rest.hooks;
  const summary = `remove coding.sh ${agent} hooks`;
  const exact = exactUninstall(file, text, rest, { env, ignore: emptyShape });
  if (exact) return planEdit(file, text, exact.after, `${summary} (${exact.summary})`);
  const empty = isEmptyShape(rest, emptyShape) && !existedBeforeInstall(file, env);
  return planEdit(file, text, empty ? undefined : stringifyJsonLike(rest, text), summary);
}

function isEmptyShape(cfg: Record<string, unknown>, shape: Record<string, unknown>): boolean {
  const keys = Object.keys(cfg);
  return keys.every((k) => k in shape && JSON.stringify(cfg[k]) === JSON.stringify(shape[k]));
}

/** True when `file` contains at least one of our hook entries (nested or flat layout). */
export function hasOurHooks(agent: string, file: string, commandKeys?: string[]): boolean {
  return textHasOurHooks(agent, file, readTextIfExists(file), commandKeys);
}

/** hasOurHooks over a file's text (undefined = missing). */
export function textHasOurHooks(agent: string, file: string, text: string | undefined, commandKeys?: string[]): boolean {
  if (text === undefined) return false;
  let cfg: Record<string, unknown>;
  try {
    cfg = parseJsonObject(file, text);
  } catch {
    return false;
  }
  return listNestedHooks(cfg.hooks, { agent, commandKeys }).length > 0 || listFlatHooks(cfg.hooks, { agent, commandKeys }).length > 0;
}

/**
 * applyChanges for a hook install into the user's config: each write is
 * recorded in installs.json with its hash and what uninstall can restore
 * byte-for-byte (the pre-install backup, or "created by coding.sh").
 */
export function applyHookInstall(changes: (FileChange | undefined)[], opts: ApplyOpts, commandKeys?: string[]): Promise<FileChange[]> {
  const env = opts.env ?? process.env;
  const now = Date.now();
  return applyChanges(changes, {
    ...opts,
    onApplied(c, backup) {
      if (c.action === "delete") return forgetInstall(c.path, env);
      const pristine = !textHasOurHooks(opts.agent, c.path, c.before, commandKeys);
      recordInstall(opts.agent, c.path, c.after ?? "", env, now, restoreForInstall(c.path, c.before, pristine, backup, env));
    },
  });
}

/** applyChanges for a hook uninstall: drops the installs.json record of each file it touched. */
export function applyHookUninstall(changes: (FileChange | undefined)[], opts: ApplyOpts): Promise<FileChange[]> {
  const env = opts.env ?? process.env;
  return applyChanges(changes, { ...opts, onApplied: (c) => forgetInstall(c.path, env) });
}
