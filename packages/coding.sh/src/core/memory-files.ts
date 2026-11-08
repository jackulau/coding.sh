// The files a harness audit covers, and the audit over a store. Lists memory
// and instruction files on disk (read-only): the agents' user dirs (Claude
// auto-memory, ~/.claude, ~/.codex, ~/.agents, ~/.gemini) and the directories
// the sessions ran in, their parents up to the home, and nested CLAUDE.md or
// AGENTS.md a few levels below. Then auditMemory over the sessions' events.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../schema/index.ts";
import type { IndexStore } from "./types.ts";
import { auditMemory, homeKey, isScoped, memoryKind, skillListingBytes, type MemoryAudit, type MemoryFileInfo, type MemorySession } from "./memory-audit.ts";

/** Event kinds the audit reads. */
export const MEMORY_EVENT_KINDS = ["tool.start", "notification", "file.change"];

const CONTEXT_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md", ".claude/CLAUDE.md"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor", "out", "coverage", "__pycache__"]);
/** Directories visited below one session directory when looking for nested CLAUDE.md / AGENTS.md. */
const NESTED_DIR_CAP = 2000;
const NESTED_DEPTH = 3;

/** Whether a file belongs to an agent's harness (for --agent). */
export function forAgent(key: string, agent: string): boolean {
  const base = key.split("/").pop() ?? "";
  if (agent === "claude-code") return base.startsWith("CLAUDE") || key.includes("/.claude/");
  if (agent === "codex") return base.startsWith("AGENTS") || key.includes("/.codex/") || key.includes("/.agents/");
  if (agent === "gemini-cli") return base === "GEMINI.md" || key.includes("/.gemini/");
  if (agent === "cursor") return base.startsWith("AGENTS") || key.includes("/.cursor/");
  return base.startsWith("AGENTS") || key.includes("/.agents/");
}

const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() === true;
const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Files under a dir matching `test`, at most `depth` levels down. */
function walk(dir: string, test: (rel: string) => boolean, depth: number, out: string[], rel = ""): void {
  if (depth < 0) return;
  for (const n of names(dir)) {
    const p = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) walk(p, test, depth - 1, out, r);
    else if (st?.isFile() && test(r)) out.push(p);
  }
}

/** `skills/<name>/SKILL.md` under a skills dir. */
const skillFiles = (dir: string): string[] => names(dir).map((n) => join(dir, n, "SKILL.md")).filter(isFile);

/** CLAUDE.md / AGENTS.md below a dir (not in it), skipping dot dirs and build output. */
function nested(root: string): string[] {
  const out: string[] = [];
  let visited = 0;
  const go = (dir: string, depth: number) => {
    if (depth > NESTED_DEPTH || visited >= NESTED_DIR_CAP) return;
    visited++;
    for (const n of names(dir)) {
      if (n.startsWith(".") || SKIP_DIRS.has(n)) continue;
      const p = join(dir, n);
      if (!isDir(p)) continue;
      for (const f of ["CLAUDE.md", "AGENTS.md"]) if (isFile(join(p, f))) out.push(join(p, f));
      go(p, depth + 1);
    }
  };
  go(root, 1);
  return out;
}

/** The first 4 KB, for frontmatter. */
function head(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface MemoryDirs {
  home: string;
  /** Claude Code's config dir (CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeDir: string;
  /** Codex's home (CODEX_HOME, else ~/.codex). */
  codexDir: string;
}

export function memoryDirs(env: NodeJS.ProcessEnv = process.env): MemoryDirs {
  const home = env.HOME || env.USERPROFILE || homedir();
  return { home, claudeDir: env.CLAUDE_CONFIG_DIR || join(home, ".claude"), codexDir: env.CODEX_HOME || join(home, ".codex") };
}

/** One file's audit info, or undefined when it is not a memory or instruction file on disk. */
export function fileInfo(path: string, home: string): MemoryFileInfo | undefined {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) return undefined;
  const key = homeKey(path, home);
  const kind = memoryKind(key);
  if (!kind) return undefined;
  if (kind !== "rule" && kind !== "skill") return { key, bytes: st.size };
  const text = head(path);
  const listing = kind === "skill" ? skillListingBytes(text) : undefined;
  return { key, bytes: st.size, ...(isScoped(text) ? { scoped: true } : {}), ...(listing !== undefined && listing < st.size ? { loadBytes: listing } : {}) };
}

/** Memory and instruction files on disk: the agents' user dirs and the session directories. */
export function listMemoryFiles(dirs: MemoryDirs, sessionDirs: readonly string[]): MemoryFileInfo[] {
  const paths: string[] = [];
  const { home, claudeDir, codexDir } = dirs;
  paths.push(join(claudeDir, "CLAUDE.md"));
  walk(join(claudeDir, "rules"), (r) => r.endsWith(".md"), 4, paths);
  paths.push(...skillFiles(join(claudeDir, "skills")));
  for (const p of names(join(claudeDir, "projects"))) walk(join(claudeDir, "projects", p, "memory"), (r) => r.endsWith(".md"), 3, paths);
  paths.push(join(codexDir, "AGENTS.md"), join(codexDir, "AGENTS.override.md"));
  paths.push(...skillFiles(join(codexDir, "skills")), ...skillFiles(join(home, ".agents", "skills")));
  paths.push(join(home, ".gemini", "GEMINI.md"));
  const seen = new Set<string>();
  const h = home.replace(/[\\/]+$/, "");
  for (const dir of sessionDirs) {
    if (!isDir(dir)) continue;
    // The dir and its parents up to the home (just the dir outside the home).
    const chain: string[] = [];
    for (let d = dir; ; ) {
      chain.push(d);
      const up = join(d, "..");
      if (up === d || !(up === h || up.startsWith(h + "/") || up.startsWith(h + "\\")) || d === h) break;
      d = up;
    }
    for (const d of chain) {
      if (seen.has(d)) continue;
      seen.add(d);
      for (const n of CONTEXT_NAMES) paths.push(join(d, n));
      walk(join(d, ".claude", "rules"), (r) => r.endsWith(".md"), 4, paths);
      for (const s of [".claude/skills", ".agents/skills"]) paths.push(...skillFiles(join(d, s)));
    }
    paths.push(...nested(dir));
  }
  const out = new Map<string, MemoryFileInfo>();
  for (const p of paths) {
    const f = fileInfo(p, home);
    if (f) out.set(f.key, f);
  }
  return [...out.values()];
}

/** A key's path on this machine (`~/…` under the home). */
export const localPath = (key: string, home: string): string => (key === "~" ? home : key.startsWith("~/") ? join(home, key.slice(2)) : key);

export interface MemoryAuditOptions {
  agent?: AgentId;
  since?: number;
  env?: NodeJS.ProcessEnv;
}

/** The harness audit over a store: sessions since `since` (subagents folded into their root), files on disk. */
export async function memoryAudit(index: IndexStore, o: MemoryAuditOptions = {}): Promise<MemoryAudit & { since?: number; agent?: string }> {
  const dirs = memoryDirs(o.env);
  const all = await index.listSessions({ ...(o.agent ? { agent: o.agent } : {}), ...(o.since !== undefined ? { since: o.since } : {}) });
  const byId = new Map(all.map((s) => [s.id, s]));
  const rootOf = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const p = byId.get(cur)?.parent?.sessionId;
      if (!p || !byId.has(p)) break;
      cur = p;
    }
    return cur;
  };
  // A subagent counts as its root session but keeps its own directory (a worktree, say) and events.
  const list: MemorySession[] = [];
  for (const s of all) {
    const root = rootOf(s.id);
    const events = await index.listEvents(s.id, { kinds: MEMORY_EVENT_KINDS });
    list.push({ id: s.id, agent: s.agent, startedAt: s.startedAt, events, ...(root !== s.id ? { rootId: root } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.repo?.root ? { repoRoot: s.repo.root } : {}) });
  }
  const cwds = [...new Set(list.map((s) => s.cwd).filter((c): c is string => !!c))].map((c) => localPath(homeKey(c, dirs.home), dirs.home));
  const keep = (f: MemoryFileInfo) => !o.agent || forAgent(f.key, o.agent);
  const files = listMemoryFiles(dirs, cwds).filter(keep);
  const opts = { home: dirs.home, claudeDir: homeKey(dirs.claudeDir, dirs.home), codexDir: homeKey(dirs.codexDir, dirs.home) };
  let report = auditMemory(list, files, opts);
  // Files the sessions touched that the listing missed (outside the dirs it walks): stat them here.
  const extra = report.files.filter((r) => !r.exists).flatMap((r) => fileInfo(localPath(r.path, dirs.home), dirs.home) ?? []);
  if (extra.length) report = auditMemory(list, [...files, ...extra], opts);
  return { ...report, ...(o.since !== undefined ? { since: o.since } : {}), ...(o.agent ? { agent: o.agent } : {}) };
}
