// Which skills a session actually used. A model often skips the Skill tool and
// reads or runs a skill's files directly, and its final reply rarely names the
// skill it used (arXiv 2610.11647: 0.9% of substituted runs), so the trace is
// the record. Skill use is any of:
// - invoke: the Skill tool (or an adapter's `payload.skill` on a skill-load
//   call), or Claude Code restoring an invoked skill (harness.loaded invoked_skills);
// - read: a Read, or a shell reader (cat, head, sed, …), of a file under `skills/<name>/`;
// - run: a shell command whose program is an interpreter (python, node, bash, …)
//   or the script itself, with a path under `skills/<name>/` as its first argument.
// Pure over a session's events; nothing is executed.
import type { AgentEvent } from "../schema/index.ts";
import { stripHeredocs } from "./intent.ts";
import { commandOf, FLAGS } from "./sessions.ts";

export type SkillScope = "project" | "nested" | "personal" | "plugin" | "bundled" | "unknown";
export type SkillVia = "invoke" | "read" | "run";

export interface SkillUse {
  /** The skill's name; plugin skills are qualified `<plugin>:<name>`. */
  name: string;
  scope: SkillScope;
  /** The skill's directory, when a path named it. One SkillUse per root: two copies of one skill are two entries. */
  root?: string;
  via: SkillVia[];
  firstEventId: string;
  firstTs: number;
  calls: number;
  /** First used before the session's first file change (or edit call). */
  beforeFirstChange: boolean;
}

export interface SkillUseReport {
  used: SkillUse[];
  /** Name of the skill used first. */
  first?: string;
}

export interface SkillUseOpts {
  cwd?: string;
  home?: string;
}

/** The event kinds skillUse reads: load just these to recompute a stored session's skills. */
export const SKILL_EVENT_KINDS = ["tool.start", "notification", "file.change"];

/** Tags a session gets: `skill:<name>` in first-use order, at most this many. */
export const SKILL_TAG_MAX = 10;
export const SKILL_TAG_PREFIX = "skill:";

const READ_TOOLS = new Set(["read", "view", "read_file", "read_many_files", "notebookread"]);
const SHELL_READERS = new Set(["cat", "head", "tail", "sed", "less", "more", "nl", "bat"]);
const INTERPRETERS = new Set(["python", "python3", "node", "bash", "sh", "zsh", "deno", "bun", "ruby", "perl", "uv", "npx", "tsx"]);
const EDIT_TOOLS = /^(?:write|edit|multiedit|multi_edit|notebookedit|notebook_edit|str_replace|str_replace_editor|str_replace_based_edit_tool|search_replace|replace|edit_file|write_file|create_file|write_to_file|replace_in_file|apply_patch|patch|delete_file)$/;
/** A plugin's files: `.../plugins/cache/<marketplace>/…` or `.../plugins/marketplaces/<marketplace>/…`. */
const PLUGIN_DIR = /\/plugins\/(cache|marketplaces)\/([^/]+)\/(.*)$/;
/** A skill's name: a plain directory name (no `…`, quotes or other markup). */
const SKILL_NAME = /^\w[\w.-]*$/;

/** A home directory when none is given: macOS, Linux and Windows user dirs, and root's. */
const HOME_DIR = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)\/(.*)$/;
/** A skills dir relative to home: `.claude/skills`, `.config/opencode/skills`. */
const PERSONAL_SKILLS = /^\.[^/]+\/(?:[^/]+\/)?skills$/;

const posix = (p: string) => p.replace(/\\/g, "/");
const trimSlash = (p: string) => p.replace(/\/+$/, "");
const dotDir = (s: string | undefined) => !!s && s.startsWith(".") && s !== "." && s !== "..";

/**
 * The skill a path is in: `<base>/skills/<name>/…`, where `<base>` is an agent's
 * dot dir (`.claude`, `.agents`, `.codex`, `.config/opencode`, …) or a plugin's
 * files. A `skills/` folder anywhere else (a repo's source, a reference checkout)
 * holds no installed skill. Containers inside a skills dir are skipped: dot dirs
 * (Codex's `.system/`) and Codex's `synced/<id>/`. A file path must go past the
 * skill's directory; `dir` accepts the directory itself (a harness's skill source).
 */
function skillDir(path: string, dir = false): { base: string; root: string; name: string } | undefined {
  const p = posix(path);
  for (const m of p.matchAll(/(?:^|\/)skills\//g)) {
    const base = p.slice(0, m.index + m[0].length - 1);
    const parents = base.split("/").slice(0, -1);
    if (!dotDir(parents.at(-1)) && !dotDir(parents.at(-2)) && !PLUGIN_DIR.test(base)) continue;
    const rest = p.slice(m.index + m[0].length).split("/");
    let i = 0;
    while (dotDir(rest[i])) i++;
    if (rest[i] === "synced" && rest[i + 2]) i += 2;
    const name = rest[i];
    if (!name || !SKILL_NAME.test(name)) continue;
    if (!dir && !rest[i + 1]) continue;
    return { base, root: `${base}/${rest.slice(0, i + 1).join("/")}`, name };
  }
  return undefined;
}

/** `frontend-design:frontend-design` → `frontend-design`: a plugin named for its one skill. */
const skillName = (name: string) => {
  const [plugin, skill, ...more] = name.split(":");
  return !more.length && skill !== undefined && plugin === skill ? skill : name;
};

interface Hit {
  name: string;
  scope: SkillScope;
  root?: string;
  via: SkillVia;
  e: AgentEvent;
}

/** Scope and qualified name of a skill directory path. */
function classify(path: string, o: SkillUseOpts, dir = false): { name: string; scope: SkillScope; root: string } | undefined {
  const d = skillDir(path, dir);
  if (!d) return undefined;
  const { base, root, name } = d;
  const plugin = PLUGIN_DIR.exec(base);
  if (plugin) {
    const rest = plugin[3]!.split("/");
    // cache/<marketplace>/<plugin>/<version>/skills/<name>; marketplaces/<marketplace>/[plugins/<plugin>/]skills/<name>
    const owner = plugin[1] === "cache" ? (rest[0] ?? plugin[2]!) : rest[0] === "plugins" && rest[1] ? rest[1] : plugin[2]!;
    return { name: skillName(`${owner}:${name}`), scope: "plugin", root };
  }
  const home = o.home ? trimSlash(posix(o.home)) : undefined;
  const cwd = o.cwd ? trimSlash(posix(o.cwd)) : undefined;
  const absolute = base.startsWith("/") || base.startsWith("~/") || /^[A-Za-z]:\//.test(base);
  const underCwd = !!cwd && base.startsWith(`${cwd}/`);
  const homeRel = home && base.startsWith(`${home}/`) ? base.slice(home.length + 1) : base.startsWith("~/") ? base.slice(2) : HOME_DIR.exec(base)?.[1];
  // ~/.claude/skills, ~/.agents/skills, ~/.codex/skills, ~/.config/opencode/skills, … (unless the session runs inside that dir's project)
  if (homeRel !== undefined && PERSONAL_SKILLS.test(homeRel) && !(underCwd && cwd !== home)) return { name, scope: "personal", root };
  const rel = underCwd ? root.slice(cwd!.length + 1) : absolute ? undefined : root;
  if (rel !== undefined) return { name, scope: /^\.[^/]+\/skills$/.test(underCwd ? base.slice(cwd!.length + 1) : base) ? "project" : "nested", root: cwd ? `${cwd}/${rel}` : root };
  return { name, scope: "unknown", root };
}

/** Claude Code's skill source names in invoked_skills: `projectSettings:<n>`, `userSettings:<n>`, `plugin:<p>:<n>`, `bundled:<n>`. */
function sourceScope(source: string): SkillScope | undefined {
  const kind = /^([A-Za-z]+):/.exec(source)?.[1];
  if (kind === "projectSettings") return "project";
  if (kind === "userSettings") return "personal";
  if (kind === "plugin") return "plugin";
  if (kind === "bundled") return "bundled";
  if (kind === "policySettings" || kind === "managed") return "unknown";
  return undefined;
}

/** Skill paths an argv names: the first literal path argument (no `$`, backticks, globs or `..`). */
function firstPathArg(argv: string[]): string | undefined {
  for (const a of argv) {
    if (a.startsWith("-")) continue;
    if (/[$`*?[\]]/.test(a) || a.split("/").includes("..")) return undefined;
    return a;
  }
  return undefined;
}

/** Shell segments of a command, unquoted tokens per segment; undefined segments for substitutions. */
function shellSegments(cmd: string): string[][] {
  return stripHeredocs(cmd)
    .split(/&&|\|\||[;|\n]/)
    .filter((s) => !/\$\(|`|<\(/.test(s))
    .map((s) =>
      s
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.replace(/^['"]|['"]$/g, "")),
    )
    .filter((s) => s.length);
}

/** Skill hits of one shell command: reads (cat …/skills/x/SKILL.md) and runs (python3 …/skills/x/scripts/a.py). */
function shellHits(cmd: string): { path: string; via: SkillVia }[] {
  const out: { path: string; via: SkillVia }[] = [];
  for (const argv of shellSegments(cmd)) {
    const prog = argv[0]!;
    const base = prog.split("/").pop()!;
    if (SHELL_READERS.has(base)) {
      if (base === "sed" && argv.some((a) => /^-[a-z]*i/.test(a))) continue;
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i]!;
        // `cat > .claude/skills/x/SKILL.md` writes the file.
        if (/^\d*>>?$/.test(a)) i++;
        else if (!a.startsWith("-") && !/^\d*>/.test(a) && skillDir(a) && !/[$`*?]/.test(a) && !a.split("/").includes("..")) out.push({ path: a, via: "read" });
      }
    } else if (INTERPRETERS.has(base)) {
      const arg = firstPathArg(argv.slice(1));
      if (arg && skillDir(arg)) out.push({ path: arg, via: "run" });
    } else if (skillDir(prog) && !/[$`*?]/.test(prog) && !prog.split("/").includes("..")) {
      out.push({ path: prog, via: "run" });
    }
  }
  return out;
}

const toolOf = (e: AgentEvent): string => (typeof e.payload.tool === "string" ? e.payload.tool : "");
const strs = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

const inputPath = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  for (const k of ["file_path", "filePath", "path", "absolute_path", "target_file"]) if (typeof i[k] === "string" && i[k]) return i[k] as string;
  return undefined;
};

/** The skills a session used, from its events (any order). */
export function skillUse(events: readonly AgentEvent[], o: SkillUseOpts = {}): SkillUseReport {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
  const opts: SkillUseOpts = { cwd: o.cwd ?? sorted.find((e) => e.cwd)?.cwd, home: o.home };
  const hits: Hit[] = [];
  // Where Claude Code says a skill came from: the Skill tool's base directory, invoked_skills sources.
  const origin = new Map<string, { scope: SkillScope; root?: string }>();
  const invoked = new Set<string>();
  let firstChange = Infinity;
  for (const e of sorted) {
    if (e.kind === "file.change") firstChange = Math.min(firstChange, e.ts);
    if (e.kind === "notification" && e.payload.kind === "harness.loaded") {
      const skills = strs(e.payload.skills).map(skillName);
      const sources = strs(e.payload.sources);
      skills.forEach((name, i) => {
        const src = sources[i];
        if (!src) return;
        const c = classify(src, opts, true);
        const scope = sourceScope(src);
        if (c) origin.set(name, { scope: c.scope, root: c.root });
        else if (scope) origin.set(name, { scope });
      });
      // A skill restored after a compaction or resume was invoked, even when its Skill call is not in the events (a slash command).
      if (e.payload.loadedBy === "invoked_skills") for (const name of skills) if (!invoked.has(name)) hits.push({ name, scope: origin.get(name)?.scope ?? "unknown", root: origin.get(name)?.root, via: "invoke", e });
      continue;
    }
    if (e.kind !== "tool.start" || e.payload.wrapper === true) continue;
    const tool = toolOf(e);
    const t = tool.toLowerCase();
    if (EDIT_TOOLS.test(t)) {
      firstChange = Math.min(firstChange, e.ts);
      continue;
    }
    const input = e.payload.input as Record<string, unknown> | undefined;
    const tagged = strs(e.payload.skill).concat(strs(e.payload.skills));
    const named = t === "skill" ? strs(input?.skill ?? input?.name ?? input?.command) : [];
    const invokeNames = t === "skill" ? [...new Set([...named, ...tagged])] : [];
    for (const raw of invokeNames) {
      const name = skillName(raw);
      invoked.add(name);
      hits.push({ name, scope: raw.includes(":") ? "plugin" : "unknown", via: "invoke", e });
    }
    if (invokeNames.length) continue;
    const paths: { path: string; via: SkillVia }[] = [];
    const p = inputPath(input);
    if (p && READ_TOOLS.has(t)) paths.push({ path: p, via: "read" });
    const cmd = commandOf(input);
    if (cmd && !p) paths.push(...shellHits(cmd));
    for (const h of paths) {
      const c = classify(h.path, opts);
      if (c) hits.push({ name: c.name, scope: c.scope, root: c.root, via: h.via, e });
    }
    // payload.skill on a non-Skill call (an adapter's skill-load tag on a read) with no path to place it.
    if (!paths.length) for (const raw of tagged) hits.push({ name: skillName(raw), scope: raw.includes(":") ? "plugin" : "unknown", via: "read", e });
  }

  // One entry per (name, root). A hit without a root (a Skill call) joins its name's
  // origin root when one is known, else the name's first rooted entry, else stands alone.
  const entries: SkillUse[] = [];
  const rootsOf = new Map<string, SkillUse[]>();
  const add = (h: Hit, root: string | undefined, scope: SkillScope) => {
    const list = rootsOf.get(h.name) ?? [];
    let u = list.find((x) => x.root === root) ?? (root === undefined ? list[0] : list.find((x) => x.root === undefined));
    if (!u) {
      u = { name: h.name, scope, ...(root !== undefined ? { root } : {}), via: [], firstEventId: h.e.id, firstTs: h.e.ts, calls: 0, beforeFirstChange: false };
      list.push(u);
      entries.push(u);
      rootsOf.set(h.name, list);
    } else if (root !== undefined && u.root === undefined) {
      u.root = root;
      if (u.scope === "unknown" || scope !== "unknown") u.scope = scope;
    }
    if (!u.via.includes(h.via)) u.via.push(h.via);
    u.calls++;
  };
  for (const h of hits) {
    const o = h.root === undefined ? origin.get(h.name) : undefined;
    add(h, h.root ?? o?.root, h.root !== undefined ? h.scope : (o?.scope ?? h.scope));
  }
  for (const u of entries) u.beforeFirstChange = u.firstTs < firstChange;
  entries.sort((a, b) => a.firstTs - b.firstTs);
  return { used: entries, ...(entries.length ? { first: entries[0]!.name } : {}) };
}

/** Session tags and flags from skill use: `skill:<name>` (first-use order, at most SKILL_TAG_MAX) and skill-copy-conflict. */
export function skillFlags(r: SkillUseReport): string[] {
  const names = [...new Set(r.used.map((u) => u.name))];
  const flags = names.slice(0, SKILL_TAG_MAX).map((n) => `${SKILL_TAG_PREFIX}${n}`);
  const roots = new Map<string, Set<string>>();
  for (const u of r.used) if (u.root) roots.set(u.name, (roots.get(u.name) ?? new Set()).add(u.root));
  if ([...roots.values()].some((s) => s.size > 1)) flags.push(FLAGS.skillCopyConflict);
  return flags;
}

/**
 * What foldSkills keeps of a session's events for skillUse: the events that can
 * name a skill, the first file change or edit call, and the first cwd. It grows
 * with the session's skill use, not its length. Serializable (node:v8).
 */
export interface SkillState {
  events: AgentEvent[];
  /** The first event's cwd (skillUse's fallback when the session has none). */
  cwd?: string;
  changed: boolean;
}

export function skillState(): SkillState {
  return { events: [], changed: false };
}

/** Folds the next event, in time order: keeps it when skillUse could read a skill from it. */
export function foldSkills(s: SkillState, e: AgentEvent): void {
  if (!s.cwd && e.cwd) s.cwd = e.cwd;
  if (e.kind === "notification") {
    if (e.payload.kind === "harness.loaded") s.events.push(e);
    return;
  }
  if (e.kind !== "tool.start" && e.kind !== "file.change") return;
  if (e.kind === "file.change" || (e.payload.wrapper !== true && EDIT_TOOLS.test(toolOf(e).toLowerCase()))) {
    // Only the first one's time matters (beforeFirstChange).
    if (!s.changed) s.events.push(e);
    s.changed = true;
    return;
  }
  if (e.payload.wrapper === true) return;
  // Every hit names `skills/` in a path or command, or comes from the Skill tool or a skill tag.
  if (toolOf(e).toLowerCase() === "skill" || e.payload.skill !== undefined || e.payload.skills !== undefined || JSON.stringify(e.payload.input ?? null).includes("skills")) s.events.push(e);
}

/** skillUse over the events folded so far, for a session whose cwd is `cwd`. */
export function skillUseOf(s: SkillState, cwd?: string): SkillUseReport {
  return skillUse(s.events, { cwd: cwd ?? s.cwd });
}
