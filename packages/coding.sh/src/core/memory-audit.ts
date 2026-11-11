// Which memory and instruction files agents actually use (harness audit).
// For each file (Claude auto-memory, CLAUDE.md, AGENTS.md, rules, skills), the
// sessions that loaded it, read it with a tool and wrote it, from captured
// events only:
// - loaded: a harness.loaded event (nested CLAUDE.md, a listed skill), or a file
//   the agent loads at start for the session's directory (Claude Code: CLAUDE.md
//   up the tree, unscoped rules, the project's MEMORY.md, the skill list; Codex:
//   AGENTS.md from the repo root down), counted only for files on disk;
// - read: a read tool (Read, view, …) or a shell reader (cat, head, sed, …) on the
//   path, or invoking the skill;
// - wrote: a file.change, an edit tool, or a shell write (> file, tee, sed -i).
// Paths under a home directory are keyed `~/…`, so sessions recorded on another
// machine (or user) match the files here. Pure: the caller lists the files.
//
// What an event says is read in one place (memoryOps), so the audit can take a
// session's events or what the session fold kept of them (Session.stats.memoryUse,
// core/memory-use.ts) and count the same.
import { posix } from "node:path";
import type { AgentEvent, MemoryUse } from "../schema/index.ts";
import { harnessItem, parseFrontmatter } from "./exposure.ts";
import { shellWrites, stripHeredocs } from "./intent.ts";
import { HARNESS_LOADED, INPUT_PATH_KEYS, MEMORY_PATH_TEXT, SKILL_TOOL } from "./memory-events.ts";
import { commandOf } from "./sessions.ts";

export type MemoryKind = "memory" | "context" | "rule" | "skill";
export type MemoryFlag = "never-read" | "write-only" | "loaded-not-read";

/** A file on disk, keyed like the audit (`~/…` under the home). */
export interface MemoryFileInfo {
  key: string;
  bytes: number;
  /** Rules and skills with `paths`/`globs` frontmatter load only for matching files. */
  scoped?: boolean;
  /** What loading it puts in context when that is less than the file: a skill's name and description. */
  loadBytes?: number;
  /** When the file first existed (ms): its first commit, or when it was made if git does not track it. A session that started before it never loaded it at start. */
  since?: number;
}

/** The events of one session that the audit reads. */
export interface MemorySession {
  id: string;
  /** The session its counts go to: a subagent counts as its root session, with its own directory and events. */
  rootId?: string;
  agent: string;
  cwd?: string;
  repoRoot?: string;
  startedAt: number;
  events: readonly Pick<AgentEvent, "kind" | "ts" | "payload">[];
  /** The session's stats.memoryUse, from a session folded with it: read instead of `events`. */
  uses?: readonly MemoryUse[];
}

export interface MemoryRow {
  path: string;
  kind: MemoryKind;
  exists: boolean;
  bytes?: number;
  /** bytes / 4, rounded up. */
  tokens?: number;
  /** Sessions that loaded it (events or start-time loads). */
  loaded: number;
  /** Of those, sessions where only the start-time rule says it loaded. */
  loadedAtStart: number;
  read: number;
  wrote: number;
  lastRead?: number;
  lastWrite?: number;
  /** Tokens per load × loaded: what loading it cost over the window (for a skill, its name and description). */
  loadTokens?: number;
  flags: MemoryFlag[];
}

export interface MemoryAudit {
  sessions: number;
  files: MemoryRow[];
  totals: {
    files: number;
    bytes: number;
    loadTokens: number;
    /** Sessions that loaded, read or wrote at least one audited file. */
    sessionsLoading: number;
    sessionsReading: number;
    sessionsWriting: number;
    neverRead: number;
    writeOnly: number;
    loadedNotRead: number;
  };
}

export interface MemoryAuditOpts {
  /** This machine's home directory (posix or Windows). */
  home?: string;
  /** Claude Code's config dir as a key (default `~/.claude`). */
  claudeDir?: string;
  /** Codex's home as a key (default `~/.codex`). */
  codexDir?: string;
}

const CONTEXT = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md"]);
const AUTO_MEMORY = /(?:^|\/)\.claude\/projects\/[^/]+\/memory\/.+\.md$/;
const READ_TOOLS = new Set(["read", "view", "read_file", "read_many_files", "notebookread", "open_file"]);
const EDIT_TOOLS = /^(?:write|edit|multiedit|multi_edit|notebookedit|notebook_edit|str_replace|str_replace_editor|str_replace_based_edit_tool|search_replace|replace|edit_file|write_file|create_file|write_to_file|replace_in_file|delete_file)$/;
const SHELL_READERS = new Set(["cat", "head", "tail", "sed", "less", "more", "nl", "bat"]);
/** A home directory in a recorded path: macOS, Linux, Windows user dirs and root's. */
const HOME_DIR = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/;

const slash = (p: string) => p.replace(/\\/g, "/");

/** What kind of memory or instruction file a path is, if any. */
export function memoryKind(path: string): MemoryKind | undefined {
  const p = slash(path);
  if (AUTO_MEMORY.test(p)) return "memory";
  if (CONTEXT.has(p.split("/").pop() ?? "")) return "context";
  const item = harnessItem(p, "");
  return item?.kind === "rule" ? "rule" : item?.kind === "skill" ? "skill" : undefined;
}

/** `~/…` for a path under `home` or under any recorded home dir; else the path, with forward slashes. */
export function homeKey(path: string, home?: string): string {
  const p = slash(path).replace(/\/+$/, "");
  if (p === "~" || p.startsWith("~/")) return p;
  const h = home ? slash(home).replace(/\/+$/, "") : undefined;
  if (h && (p === h || p.startsWith(`${h}/`))) return `~${p.slice(h.length)}`;
  const m = HOME_DIR.exec(p);
  return m ? `~${p.slice(m[0].length)}` : p;
}

/** Whether a frontmatter scopes a rule or skill to some files (`paths`, `globs`, `applyTo`). */
export function isScoped(text: string): boolean {
  const fm = parseFrontmatter(text).data;
  return [fm.paths, fm.globs, fm.applyTo].some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "" && v.trim() !== "**"));
}

/** A skill's listing, what agents load at start: `name: description` from its frontmatter, in bytes. */
export function skillListingBytes(text: string): number | undefined {
  const fm = parseFrontmatter(text).data;
  const name = typeof fm.name === "string" ? fm.name : "";
  const desc = typeof fm.description === "string" ? fm.description : "";
  return name || desc ? Buffer.byteLength(`${name}: ${desc}`) : undefined;
}

/** Claude Code's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** A dir and its parents up to the root (or to `top`, inclusive). */
function ancestors(dir: string, top?: string): string[] {
  const out: string[] = [];
  let d = slash(dir).replace(/\/+$/, "") || "/";
  for (;;) {
    out.push(d);
    if (top !== undefined && d === top) break;
    const up = posix.dirname(d);
    if (up === d || up === "." || (/^[A-Za-z]:$/.test(up) && d === up)) break;
    d = up;
  }
  return out;
}

const isAbs = (p: string) => p.startsWith("/") || p.startsWith("~/") || /^[A-Za-z]:\//.test(p);

/** An absolute path for a path an event names, relative ones against the session's cwd. */
export function resolvePath(p: string, cwd: string | undefined): string | undefined {
  const s = slash(p.trim());
  if (!s || /[$`*?]/.test(s)) return undefined;
  if (isAbs(s)) return posix.normalize(s);
  return cwd ? posix.join(slash(cwd), s) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strs = (v: unknown): string[] => (typeof v === "string" && v ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

const inputPath = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  for (const k of INPUT_PATH_KEYS) if (typeof i[k] === "string" && i[k]) return i[k] as string;
  return undefined;
};

/** Shell segments as unquoted tokens (command substitutions dropped). */
function segments(cmd: string): string[][] {
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

/** Paths a shell command reads (cat, head, sed without -i, `< file`) and writes (shellWrites: `>`, tee, sed -i, cp/mv targets). */
export function shellPaths(cmd: string): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  for (const argv of segments(cmd)) {
    const prog = argv[0]!.split("/").pop()!;
    const inPlace = prog === "sed" && argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
    // sed's first operand is its script unless -e or -f gave one.
    let script = prog === "sed" && !argv.some((a) => /^-[a-zA-Z]*[ef]$/.test(a) || a.startsWith("--expression") || a.startsWith("--file"));
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if ((prog === "head" || prog === "tail") && /^-[nc]$/.test(a)) {
        i++;
        continue;
      }
      if (prog === "sed" && /^-[a-zA-Z]*[ef]$/.test(a)) {
        i++;
        continue;
      }
      if (script && !a.startsWith("-")) {
        script = false;
        continue;
      }
      if (/^\d*>/.test(a)) {
        if (/^\d*>>?$/.test(a)) i++; // the redirect's target is a write
        continue;
      }
      if (a.startsWith("<<")) continue; // a heredoc or here-string, not a file
      if (a.startsWith("<")) {
        const src = a.slice(1) || argv[++i];
        if (src) reads.push(src);
        continue;
      }
      if (!a.startsWith("-") && SHELL_READERS.has(prog) && !inPlace) reads.push(a);
    }
  }
  const writes = shellWrites(cmd).flatMap((w) => (w.renamedTo ? [w.path, w.renamedTo] : [w.path]));
  return { reads, writes };
}

/** A skill's name as its directory has it: without the plugin it came from (`tools:pdf` is `pdf`). */
const skillName = (name: string): string => name.split(":").pop()!;

/**
 * What one event says about memory and instruction files, in the order the
 * audit counts it: a path as the event wrote it (the audit resolves it against
 * the session's directory), or a skill by name.
 */
export function memoryOps(e: Pick<AgentEvent, "kind" | "ts" | "payload">): MemoryUse[] {
  const p = e.payload ?? {};
  const out: MemoryUse[] = [];
  const path = (use: MemoryUse["use"], path: string | undefined) => {
    if (path) out.push({ use, path, ts: e.ts });
  };
  const skill = (by: "tool" | "harness", name: string) => {
    if (skillName(name)) out.push({ use: "read", skill: skillName(name), by, ts: e.ts });
  };
  if (e.kind === "notification") {
    if (p.kind !== HARNESS_LOADED) return out;
    const by = p.loadedBy;
    if (by === "nested_memory") for (const f of strs(p.paths)) path("loaded", f);
    else if (by === "dynamic_skill") {
      const dir = str(p.dir);
      if (dir) for (const name of strs(p.skills)) path("loaded", `${dir}/${name}/SKILL.md`);
    } else if (by === "skill" || by === "invoked_skills") {
      // The skill's body entered the context: it was read.
      const sources = strs(p.sources).filter(isAbs);
      for (const dir of sources) path("read", `${dir}/SKILL.md`);
      if (!sources.length) for (const name of strs(p.skills)) skill("harness", name);
    }
    return out;
  }
  if (e.kind === "file.change") {
    path("wrote", str(p.path));
    path("wrote", str(p.movedTo));
    return out;
  }
  if (e.kind !== "tool.start" || p.wrapper === true) return out;
  const tool = (str(p.tool) ?? "").toLowerCase();
  const input = p.input;
  if (tool === SKILL_TOOL) {
    const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    for (const name of strs(i.skill ?? i.name ?? i.command)) skill("tool", name);
    return out;
  }
  const file = inputPath(input);
  if (file && READ_TOOLS.has(tool)) path("read", file);
  else if (file && EDIT_TOOLS.test(tool)) path("wrote", file);
  const cmd = file ? undefined : commandOf(input);
  // A command without the text names no memory file (core/memory-events.ts): not worth parsing.
  if (cmd?.includes(MEMORY_PATH_TEXT)) {
    const sh = shellPaths(cmd);
    for (const r of sh.reads) path("read", r);
    for (const w of sh.writes) path("wrote", w);
  }
  return out;
}

interface Touch {
  loaded: boolean;
  loadedAtStart: boolean;
  read: boolean;
  wrote: boolean;
  lastRead?: number;
  lastWrite?: number;
}

/** Audits the given files and every memory or instruction file the sessions touched. */
export function auditMemory(sessions: readonly MemorySession[], files: readonly MemoryFileInfo[], o: MemoryAuditOpts = {}): MemoryAudit {
  const claudeDir = o.claudeDir ?? "~/.claude";
  const codexDir = o.codexDir ?? "~/.codex";
  const onDisk = new Map(files.map((f) => [f.key, f]));
  const key = (p: string) => homeKey(p, o.home);
  // Skill files by skill name, for Skill tool calls that name no path.
  const skillsByName = new Map<string, string[]>();
  const addSkill = (k: string) => {
    const name = /\/skills\/([^/]+)\/SKILL\.md$/.exec(k)?.[1];
    if (!name) return;
    const list = skillsByName.get(name) ?? [];
    if (!list.includes(k)) list.push(k);
    skillsByName.set(name, list);
  };
  for (const f of files) addSkill(f.key);
  const usage = new Map<string, Map<string, Touch>>();
  const touch = (k: string, sid: string): Touch => {
    let by = usage.get(k);
    if (!by) usage.set(k, (by = new Map()));
    let t = by.get(sid);
    if (!t) by.set(sid, (t = { loaded: false, loadedAtStart: false, read: false, wrote: false }));
    return t;
  };
  const mark = (path: string | undefined, s: MemorySession, what: "loaded" | "read" | "wrote", ts: number) => {
    const abs = path ? resolvePath(path, s.cwd) : undefined;
    if (!abs) return;
    const k = key(abs);
    if (!memoryKind(k)) return;
    addSkill(k);
    const t = touch(k, s.rootId ?? s.id);
    if (what === "loaded") t.loaded = true;
    else if (what === "read") {
      t.read = true;
      t.lastRead = Math.max(t.lastRead ?? 0, ts);
    } else {
      t.wrote = true;
      t.lastWrite = Math.max(t.lastWrite ?? 0, ts);
    }
  };
  // Start-time loads, for files on disk only.
  const startLoad = (k: string, s: MemorySession) => {
    const f = onDisk.get(k);
    if (!f || f.scoped) return;
    // A session that started before the file existed could not load it.
    if (f.since !== undefined && s.startedAt < f.since) return;
    const t = touch(k, s.rootId ?? s.id);
    if (!t.loaded) t.loaded = t.loadedAtStart = true;
  };
  const skillsIn = (dirKey: string) => files.filter((f) => f.key.startsWith(`${dirKey}/`) && /^[^/]+\/SKILL\.md$/.test(f.key.slice(dirKey.length + 1))).map((f) => f.key);

  for (const s of sessions) {
    const cwd = s.cwd ? slash(s.cwd) : undefined;
    if (cwd && (s.agent === "claude-code" || s.agent === "codex")) {
      if (s.agent === "claude-code") {
        startLoad(`${claudeDir}/CLAUDE.md`, s);
        for (const f of files) if (f.key.startsWith(`${claudeDir}/rules/`)) startLoad(f.key, s);
        for (const k of skillsIn(`${claudeDir}/skills`)) startLoad(k, s);
        startLoad(`${claudeDir}/projects/${claudeProjectSlug(cwd)}/memory/MEMORY.md`, s);
        for (const d of ancestors(cwd).map(key)) {
          for (const n of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) startLoad(`${d === "/" ? "" : d}/${n}`, s);
          for (const f of files) if (f.key.startsWith(`${d === "/" ? "" : d}/.claude/rules/`)) startLoad(f.key, s);
          for (const k of skillsIn(`${d === "/" ? "" : d}/.claude/skills`)) startLoad(k, s);
        }
      } else {
        startLoad(onDisk.has(`${codexDir}/AGENTS.override.md`) ? `${codexDir}/AGENTS.override.md` : `${codexDir}/AGENTS.md`, s);
        for (const dir of [`${codexDir}/skills`, "~/.agents/skills"]) for (const k of skillsIn(dir)) startLoad(k, s);
        const root = s.repoRoot ? slash(s.repoRoot).replace(/\/+$/, "") : undefined;
        const dirs = root && (cwd === root || cwd.startsWith(`${root}/`)) ? ancestors(cwd, root) : [cwd];
        for (const d of dirs.map(key)) {
          startLoad(onDisk.has(`${d}/AGENTS.override.md`) ? `${d}/AGENTS.override.md` : `${d}/AGENTS.md`, s);
          for (const k of skillsIn(`${d}/.agents/skills`)) startLoad(k, s);
        }
      }
    }
    for (const op of s.uses ?? s.events.flatMap(memoryOps)) {
      if (op.path !== undefined) mark(op.path, s, op.use, op.ts);
      else if (op.skill !== undefined) {
        let named = skillsByName.get(op.skill) ?? [];
        // A Skill call names a dir under the agent's or the project's skills: the ones this session could see.
        if (op.by === "tool") named = named.filter((k) => k.startsWith(`${claudeDir}/`) || (!!s.cwd && ancestors(slash(s.cwd)).map(key).some((d) => k.startsWith(`${d}/.claude/skills/`))));
        for (const k of named) mark(k, s, "read", op.ts);
      }
    }
  }

  const keys = new Set([...files.map((f) => f.key), ...usage.keys()]);
  const rows: MemoryRow[] = [];
  const sessionsLoading = new Set<string>();
  const sessionsReading = new Set<string>();
  const sessionsWriting = new Set<string>();
  for (const k of keys) {
    const kind = memoryKind(k);
    if (!kind) continue;
    const by = usage.get(k) ?? new Map<string, Touch>();
    const f = onDisk.get(k);
    let loaded = 0;
    let loadedAtStart = 0;
    let read = 0;
    let wrote = 0;
    let lastRead: number | undefined;
    let lastWrite: number | undefined;
    let otherUse = 0;
    for (const [sid, t] of by) {
      if (t.loaded) {
        loaded++;
        sessionsLoading.add(sid);
      }
      if (t.loadedAtStart) loadedAtStart++;
      if (t.read) {
        read++;
        sessionsReading.add(sid);
      }
      if (t.wrote) {
        wrote++;
        sessionsWriting.add(sid);
      }
      if (t.lastRead !== undefined) lastRead = Math.max(lastRead ?? 0, t.lastRead);
      if (t.lastWrite !== undefined) lastWrite = Math.max(lastWrite ?? 0, t.lastWrite);
      if (!t.wrote && (t.read || t.loaded)) otherUse++;
    }
    const flags: MemoryFlag[] = [];
    // write-only: written, and no session that did not write it ever loaded or read it.
    if (wrote > 0 && otherUse === 0) flags.push("write-only");
    else if (f && kind === "skill" && loaded > 0 && read === 0) flags.push("loaded-not-read");
    // A file added after every session in the window started was never there to read: no flag.
    else if (f && loaded === 0 && read === 0 && !(f.since !== undefined && sessions.every((s) => s.startedAt < f.since!))) flags.push("never-read");
    const tokens = f ? Math.ceil(f.bytes / 4) : undefined;
    const loadTokens = f ? Math.ceil((f.loadBytes ?? f.bytes) / 4) * loaded : undefined;
    rows.push({
      path: k,
      kind,
      exists: !!f,
      ...(f ? { bytes: f.bytes, tokens } : {}),
      loaded,
      loadedAtStart,
      read,
      wrote,
      ...(lastRead !== undefined ? { lastRead } : {}),
      ...(lastWrite !== undefined ? { lastWrite } : {}),
      ...(loadTokens !== undefined ? { loadTokens } : {}),
      flags,
    });
  }
  const order: Record<MemoryKind, number> = { memory: 0, context: 1, rule: 2, skill: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || (b.loadTokens ?? 0) - (a.loadTokens ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const count = (flag: MemoryFlag) => rows.filter((r) => r.flags.includes(flag)).length;
  return {
    sessions: new Set(sessions.map((s) => s.rootId ?? s.id)).size,
    files: rows,
    totals: {
      files: rows.length,
      bytes: rows.reduce((a, r) => a + (r.bytes ?? 0), 0),
      loadTokens: rows.reduce((a, r) => a + (r.loadTokens ?? 0), 0),
      sessionsLoading: sessionsLoading.size,
      sessionsReading: sessionsReading.size,
      sessionsWriting: sessionsWriting.size,
      neverRead: count("never-read"),
      writeOnly: count("write-only"),
      loadedNotRead: count("loaded-not-read"),
    },
  };
}
