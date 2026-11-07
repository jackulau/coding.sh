// Did a harness item (a rule, a skill, a context file) reach the agent's
// context in a session? Cortex (arXiv 2610.14216 §1, §4) measures every item
// by exposure: a path-scoped rule fires when the agent touches a matching file,
// a skill is listed or opened, and unknown exposure never counts as "did not
// fire". This is the minimal reader the compare item gate needs; `harness
// usage` (AA-1) builds on it. Pure: no I/O.
import { createHash } from "node:crypto";
import { commandOf } from "./sessions.ts";
import { inputPaths, pathEndsWith } from "./rules.ts";
import type { AgentEvent } from "../schema/index.ts";
import { matchGlob } from "../runner/glob.ts";

export type FrontmatterValue = string | boolean | string[];

/**
 * YAML-ish frontmatter between leading `---` lines: string scalars (quoted or
 * not), booleans, `[a, b]` inline lists and `- a` block lists. Malformed
 * input gives `{data: {}}`; it never throws.
 */
export function parseFrontmatter(text: string): { data: Record<string, FrontmatterValue>; bodyStart: number } {
  const data: Record<string, FrontmatterValue> = {};
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data, bodyStart: 0 };
  const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
  let list: string[] | undefined;
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$|^-\s+(.*)$/.exec(line);
    if (item && list) {
      list.push(unquote(item[1] ?? item[2] ?? ""));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      list = undefined;
      continue;
    }
    const key = kv[1] as string;
    const raw = (kv[2] as string).replace(/\s+#.*$/, "").trim();
    list = undefined;
    if (raw === "") {
      list = [];
      data[key] = list;
    } else if (/^\[.*\]$/.test(raw)) {
      data[key] = raw
        .slice(1, -1)
        .split(",")
        .map(unquote)
        .filter((s) => s !== "");
    } else if (raw === "true" || raw === "false") data[key] = raw === "true";
    else data[key] = unquote(raw);
  }
  return { data, bodyStart: m[0].length };
}

export interface HarnessItem {
  /** First 12 hex of sha256(path). */
  id: string;
  path: string;
  kind: "context" | "rule" | "skill";
  name: string;
  /** always: loaded every session; path: only after a matching file is touched; requested: only when asked for. */
  tier: "always" | "path" | "requested";
  globs: string[];
}

const CONTEXT = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);

/** Globs from a frontmatter value: a list, or a comma-separated string. */
function globsOf(v: FrontmatterValue | undefined): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * The harness item a bundle path holds, or undefined when the path is not an
 * instruction item (a hook script, a skill's helper file, MCP config).
 */
export function harnessItem(path: string, text: string): HarnessItem | undefined {
  const p = path.replace(/\\/g, "/").replace(/^~\//, "");
  const base = p.split("/").pop() ?? p;
  const id = createHash("sha256").update(path).digest("hex").slice(0, 12);
  const fm = parseFrontmatter(text).data;
  if (CONTEXT.has(base)) return { id, path, kind: "context", name: base, tier: "always", globs: [] };
  const rule = /(?:^|\/)\.claude\/rules\/(.+)\.md$/.exec(p);
  if (rule) {
    const globs = globsOf(fm.paths);
    return { id, path, kind: "rule", name: (rule[1] as string).split("/").pop() as string, tier: globs.length ? "path" : "always", globs };
  }
  const skill = /(?:^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p);
  if (skill) {
    const globs = globsOf(fm.paths);
    return { id, path, kind: "skill", name: typeof fm.name === "string" && fm.name ? fm.name : (skill[1] as string), tier: globs.length ? "path" : "always", globs };
  }
  const mdc = /(?:^|\/)\.cursor\/rules\/(.+)\.mdc$/.exec(p);
  if (mdc) {
    const globs = globsOf(fm.globs);
    return { id, path, kind: "rule", name: mdc[1] as string, tier: fm.alwaysApply === true ? "always" : globs.length ? "path" : "requested", globs };
  }
  const gh = /(?:^|\/)\.github\/instructions\/(.+)\.instructions\.md$/.exec(p);
  if (gh) {
    const globs = globsOf(fm.applyTo);
    return { id, path, kind: "rule", name: gh[1] as string, tier: globs.length && !globs.includes("**") ? "path" : "always", globs };
  }
  return undefined;
}

export type ExposureState = "in-context" | "listed" | "not" | "unknown";

export interface Exposure {
  state: ExposureState;
  /** always: an always-on item; inferred: from the session's tool calls; null when not in context. */
  via: "always" | "inferred" | null;
  /** Events that put the item in context. */
  eventIds: string[];
}

/** Repo-relative POSIX path, or the path as given when it is outside `cwd`. */
function rel(p: string, cwd: string | undefined): string {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const c = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  return c && s.startsWith(`${c}/`) ? s.slice(c.length + 1) : s;
}

/** Paths an event touched: tool inputs, path-like tokens in a shell command, @mentions in a user message. */
function touched(e: AgentEvent, cwd: string | undefined): string[] {
  const out: string[] = [];
  if (e.kind === "tool.start") {
    const input = (e.payload as { input?: unknown }).input;
    for (const v of inputPaths(input)) out.push(rel(v, cwd));
    const cmd = commandOf(input);
    if (cmd) for (const tok of cmd.split(/\s+/)) if (/[/.]/.test(tok) && !tok.startsWith("-")) out.push(rel(tok.replace(/^['"]|['"]$/g, ""), cwd));
  } else if (e.kind === "user.message") {
    const text = (e.payload as { text?: unknown }).text;
    if (typeof text === "string") for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) out.push(rel(m[1] as string, cwd));
  }
  return out;
}

const hasInput = (e: AgentEvent) => e.kind === "tool.start" && (e.payload as { input?: unknown }).input !== undefined;

/**
 * Whether `item` reached the agent's context in one session's events.
 * "unknown" (never "not") when the session has no events, or, for an item
 * that loads on a file touch or a request, no tool call that carries its input.
 */
export function itemExposure(item: HarnessItem, events: readonly AgentEvent[], o: { cwd?: string } = {}): Exposure {
  if (!events.length) return { state: "unknown", via: null, eventIds: [] };
  if (item.kind !== "skill" && item.tier === "always") return { state: "in-context", via: "always", eventIds: [] };
  const cwd = o.cwd ?? events.find((e) => e.cwd)?.cwd;
  const itemPath = rel(item.path.replace(/^~\//, ""), undefined);
  const skillDir = item.kind === "skill" ? itemPath.replace(/\/SKILL\.md$/, "/") : undefined;
  const dirName = skillDir?.split("/").at(-2);
  const opened: string[] = [];
  const matched: string[] = [];
  for (const e of events) {
    if (item.kind === "skill" && e.kind === "tool.start") {
      // payload.skill: the adapter's skill-load tag (#20); else a Skill tool call naming it.
      const p = e.payload as { tool?: unknown; input?: unknown; skill?: unknown };
      const input = p.input as Record<string, unknown> | undefined;
      const names = [item.name, dirName];
      const named = (v: unknown) => typeof v === "string" && names.includes(v);
      if (named(p.skill) || (p.tool === "Skill" && input && (named(input.skill) || named(input.name) || named(input.command)))) {
        opened.push(e.id);
        continue;
      }
    }
    for (const f of touched(e, cwd)) {
      if (pathEndsWith(f, itemPath) || (skillDir && (f.startsWith(skillDir) || f.includes(`/${skillDir}`)))) opened.push(e.id);
      else if (item.globs.some((g) => matchGlob(f, g))) matched.push(e.id);
    }
  }
  const known = events.some(hasInput) || events.some((e) => e.kind === "user.message");
  if (opened.length) return { state: "in-context", via: "inferred", eventIds: [...new Set(opened)] };
  if (item.kind === "skill") {
    if (item.tier === "always" || matched.length) return { state: known ? "listed" : "unknown", via: null, eventIds: [] };
  } else if (matched.length) return { state: "in-context", via: "inferred", eventIds: [...new Set(matched)] };
  return { state: known ? "not" : "unknown", via: null, eventIds: [] };
}
