// The files a harness audit covers, and the audit over a store. Lists memory
// and instruction files on disk (read-only): the agents' user dirs (Claude
// auto-memory, ~/.claude, ~/.codex, ~/.agents, ~/.gemini) and the directories
// the sessions ran in, their parents up to the home, and nested CLAUDE.md or
// AGENTS.md a few levels below. Then auditMemory over what the sessions' events
// say: from the session rows (stats.memoryUse) when every stored session was
// folded by this build, else from the events themselves.
import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentId } from "../schema/index.ts";
import type { IndexStore } from "./types.ts";
import { run } from "./git.ts";
import { REFOLD_CURSOR } from "./ingest.ts";
import { foldStamp } from "./sessions.ts";
import { auditMemory, homeKey, importPaths, isScoped, memoryKind, skillListingBytes, type MemoryAudit, type MemoryFileInfo, type MemorySession } from "./memory-audit.ts";
import { MEMORY_EVENT_KINDS, memoryEventOf, type MemoryEvent } from "./memory-events.ts";

export { MEMORY_EVENT_KINDS };

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

/** A path's stat, or undefined when it can't be read: missing, a dangling link, no permission, or a Windows reparse point Node can't follow (EUNKNOWN). */
function stat(p: string) {
  try {
    return statSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

const isFile = (p: string) => stat(p)?.isFile() === true;
const isDir = (p: string) => stat(p)?.isDirectory() === true;

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A dir's entries with their types, so only links and unknown types cost a stat. */
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Whether an entry is a dir or a file, following links (a Windows junction is a link). */
function kind(dir: string, e: Dirent): "dir" | "file" | undefined {
  if (e.isDirectory()) return "dir";
  if (e.isFile()) return "file";
  // A link, or a type the file system didn't report (every check false): stat it.
  if (!e.isSymbolicLink() && (e.isBlockDevice() || e.isCharacterDevice() || e.isFIFO() || e.isSocket())) return undefined;
  const st = stat(join(dir, e.name));
  return st?.isDirectory() ? "dir" : st?.isFile() ? "file" : undefined;
}

// The listing is a generator that yields after each directory it reads: run to the end it is
// the synchronous listMemoryFiles, and listMemoryFilesAsync lets the event loop run between
// directories (a Ctrl-C stops it), which matters on a slow file system such as WSL's /mnt/c.
type Steps<T> = Generator<void, T, void>;

/** Files under a dir matching `test`, at most `depth` levels down. */
function* walk(dir: string, test: (rel: string) => boolean, depth: number, out: string[], rel = ""): Steps<void> {
  if (depth < 0) return;
  const list = entries(dir);
  yield;
  for (const e of list) {
    const p = join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    const k = kind(dir, e);
    if (k === "dir") yield* walk(p, test, depth - 1, out, r);
    else if (k === "file" && test(r)) out.push(p);
  }
}

/** `skills/<name>/SKILL.md` under a skills dir. */
function* skillFiles(dir: string): Steps<string[]> {
  const list = names(dir);
  yield;
  return list.map((n) => join(dir, n, "SKILL.md")).filter(isFile);
}

const NESTED_NAMES = ["CLAUDE.md", "AGENTS.md"];
/** Names compare as the file system does: case-blind on Windows and macOS. */
const sameName = process.platform === "win32" || process.platform === "darwin" ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;

/**
 * CLAUDE.md / AGENTS.md below a dir (not in it), skipping dot dirs and build output. Breadth first, so the
 * cap drops the deepest dirs. A dir it lists is checked from its own listing; a dir below the depth limit
 * costs a stat per name, and counts toward the cap too: a session can run in a home or temp dir with
 * thousands of subdirs.
 */
function* nested(root: string): Steps<string[]> {
  const out: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 1 }];
  for (let i = 0; i < queue.length && i < NESTED_DIR_CAP; i++) {
    const { dir, depth } = queue[i]!;
    if (depth > NESTED_DEPTH) {
      for (const f of NESTED_NAMES) if (isFile(join(dir, f))) out.push(join(dir, f));
      yield;
      continue;
    }
    const list = entries(dir);
    yield;
    if (i > 0) for (const f of NESTED_NAMES) if (list.some((e) => sameName(e.name, f) && kind(dir, e) === "file")) out.push(join(dir, f));
    for (const e of list) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      if (kind(dir, e) === "dir") queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return out;
}

/** The first 4 KB (or `max` bytes), for frontmatter. */
function head(path: string, max = 4096): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(max);
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

/** The memory and instruction files on disk that a Claude Code memory file pulls in with `@path` imports, as keys. */
function importsOf(path: string, size: number, home: string): string[] {
  const out: string[] = [];
  for (const p of importPaths(head(path, Math.min(size, IMPORT_READ_BYTES)))) {
    const target = p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : resolve(dirname(path), p);
    const k = homeKey(target, home);
    if (memoryKind(k) && isFile(target) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** How much of a memory file is read for its imports. */
const IMPORT_READ_BYTES = 256 * 1024;

/** One file's audit info, or undefined when it is not a memory or instruction file on disk. */
export function fileInfo(path: string, home: string): MemoryFileInfo | undefined {
  const st = stat(path);
  if (!st?.isFile()) return undefined;
  const key = homeKey(path, home);
  const kind = memoryKind(key);
  if (!kind) return undefined;
  // Imported files can import too: every context file and rule keeps its imports; the audit follows them from a CLAUDE.md or rule.
  const imports = kind === "context" || kind === "rule" ? importsOf(path, st.size, home) : [];
  const withImports = imports.length ? { imports } : {};
  if (kind !== "rule" && kind !== "skill") return { key, bytes: st.size, ...withImports };
  const text = head(path);
  const listing = kind === "skill" ? skillListingBytes(text) : undefined;
  return { key, bytes: st.size, ...(isScoped(text) ? { scoped: true } : {}), ...(listing !== undefined && listing < st.size ? { loadBytes: listing } : {}), ...withImports };
}

/** Memory and instruction files on disk: the agents' user dirs and the session directories. */
export function listMemoryFiles(dirs: MemoryDirs, sessionDirs: readonly string[]): MemoryFileInfo[] {
  const steps = memoryFileSteps(dirs, sessionDirs);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * listMemoryFiles that hands the event loop a turn once `sliceMs` (20) has passed since the last,
 * so a signal is seen, and stops with the signal's reason once `signal` aborts.
 */
export async function listMemoryFilesAsync(dirs: MemoryDirs, sessionDirs: readonly string[], o: { signal?: AbortSignal; sliceMs?: number } = {}): Promise<MemoryFileInfo[]> {
  const steps = memoryFileSteps(dirs, sessionDirs);
  const slice = o.sliceMs ?? 20;
  let last = performance.now();
  for (;;) {
    o.signal?.throwIfAborted();
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - last >= slice) {
      await new Promise((ok) => setImmediate(ok));
      last = performance.now();
    }
  }
}

function* memoryFileSteps(dirs: MemoryDirs, sessionDirs: readonly string[]): Steps<MemoryFileInfo[]> {
  const paths: string[] = [];
  const { home, claudeDir, codexDir } = dirs;
  paths.push(join(claudeDir, "CLAUDE.md"));
  yield* walk(join(claudeDir, "rules"), (r) => r.endsWith(".md"), 4, paths);
  paths.push(...(yield* skillFiles(join(claudeDir, "skills"))));
  // Most project dirs have no memory/: a stat that finds nothing costs about half a readdir that
  // throws, and a store can hold tens of thousands of project dirs.
  for (const p of names(join(claudeDir, "projects"))) {
    const dir = join(claudeDir, "projects", p, "memory");
    if (isDir(dir)) yield* walk(dir, (r) => r.endsWith(".md"), 3, paths);
    else yield;
  }
  paths.push(join(codexDir, "AGENTS.md"), join(codexDir, "AGENTS.override.md"));
  paths.push(...(yield* skillFiles(join(codexDir, "skills"))), ...(yield* skillFiles(join(home, ".agents", "skills"))));
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
      yield* walk(join(d, ".claude", "rules"), (r) => r.endsWith(".md"), 4, paths);
      for (const s of [".claude/skills", ".agents/skills"]) paths.push(...(yield* skillFiles(join(d, s))));
    }
    paths.push(...(yield* nested(dir)));
  }
  const out = new Map<string, MemoryFileInfo>();
  for (const p of paths) {
    const f = fileInfo(p, home);
    if (f) out.set(f.key, f);
    yield;
  }
  return [...out.values()];
}

/** A key's path on this machine (`~/…` under the home). */
export const localPath = (key: string, home: string): string => (key === "~" ? home : key.startsWith("~/") ? join(home, key.slice(2)) : key);

export interface MemoryAuditOptions {
  agent?: AgentId;
  since?: number;
  env?: NodeJS.ProcessEnv;
  /** Stops the audit (with the signal's reason) once aborted: a Ctrl-C. */
  signal?: AbortSignal;
}

/**
 * What the audit reads of each session's events (core/memory-events.ts), by
 * session id: one narrow read when the store has it (IndexStore.memoryEvents),
 * else each session's events of the three kinds, narrowed here.
 */
export async function memoryEventsOf(index: IndexStore, sessionIds: readonly string[]): Promise<Map<string, MemoryEvent[]>> {
  const by = new Map<string, MemoryEvent[]>(sessionIds.map((id) => [id, []]));
  if (index.memoryEvents) {
    for (const e of await index.memoryEvents(sessionIds)) by.get(e.sessionId)?.push(e);
    return by;
  }
  for (const [id, list] of by) {
    for (const e of await index.listEvents(id, { kinds: MEMORY_EVENT_KINDS })) {
      const m = memoryEventOf(e);
      if (m) list.push(m);
    }
  }
  return by;
}

/**
 * Whether every session row in the store carries this build's stats.memoryUse: the refold cursor
 * (core/reparse.ts) holds this build's fold stamp once all were folded by it. Until then, or in a
 * store nothing keeps that cursor for, the audit reads the events.
 */
export const memoryUseFolded = async (index: IndexStore): Promise<boolean> => (await index.getCursor(REFOLD_CURSOR)) === foldStamp();

/**
 * When each file in a session's repo first existed: the time of the commit that added it (one
 * `git log` per repo), or, for a file git does not track, when it was made on disk. Files
 * outside every repo keep no time: their start-time loads are counted as before.
 */
async function addSince(files: MemoryFileInfo[], sessions: readonly MemorySession[], home: string, signal?: AbortSignal): Promise<void> {
  const roots = [...new Set(sessions.map((s) => s.repoRoot).filter((r): r is string => !!r))].map((r) => r.replace(/\\/g, "/").replace(/\/+$/, ""));
  for (const root of roots) {
    signal?.throwIfAborted();
    const mine = files.filter((f) => localPath(f.key, home).replace(/\\/g, "/").startsWith(`${root}/`));
    if (!mine.length) continue;
    const rel = (f: MemoryFileInfo) => localPath(f.key, home).replace(/\\/g, "/").slice(root.length + 1);
    const r = await run(["log", "--diff-filter=A", "--format=%x00%ct", "--name-only", "--", ...mine.map(rel)], { cwd: root, allowFail: true, timeoutMs: 10_000 }).catch(() => undefined);
    if (!r || r.code !== 0) continue;
    // Newest first: the last time seen for a path is its first add.
    const added = new Map<string, number>();
    let ts = 0;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("\0")) ts = Number(line.slice(1)) * 1000;
      else if (line.trim()) added.set(line.trim(), ts);
    }
    for (const f of mine) {
      const t = added.get(rel(f));
      if (t !== undefined) f.since = t;
      else {
        const st = stat(localPath(f.key, home));
        const made = st ? Math.min(st.birthtimeMs || Infinity, st.mtimeMs) : undefined;
        if (made !== undefined && Number.isFinite(made)) f.since = made;
      }
    }
  }
}

/** The harness audit over a store: sessions since `since` (subagents folded into their root), files on disk. */
export async function memoryAudit(index: IndexStore, o: MemoryAuditOptions = {}): Promise<MemoryAudit & { since?: number; agent?: string }> {
  const dirs = memoryDirs(o.env);
  // Every agent's sessions, so a subagent folds into its root even when the root is another
  // agent's (Claude Code under T3 Code): --agent then counts the roots the plain audit counts.
  const window = await index.listSessions({ ...(o.since !== undefined ? { since: o.since } : {}) });
  const byId = new Map(window.map((s) => [s.id, s]));
  // --agent claude-code takes the Claude Code sessions a host app ran (T3 Code) too: they load its files.
  const all = o.agent ? window.filter((s) => s.agent === o.agent || s.provider === o.agent) : window;
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
  const events = (await memoryUseFolded(index)) ? undefined : await memoryEventsOf(index, all.map((s) => s.id));
  const list: MemorySession[] = [];
  for (const s of all) {
    const root = rootOf(s.id);
    const m: MemorySession = { id: s.id, agent: s.agent, startedAt: s.startedAt, events: events?.get(s.id) ?? [] };
    if (s.provider) m.provider = s.provider;
    if (root !== s.id) m.rootId = root;
    if (s.cwd) m.cwd = s.cwd;
    if (s.repo?.root) m.repoRoot = s.repo.root;
    if (!events) m.uses = s.stats.memoryUse ?? [];
    list.push(m);
  }
  const cwds = [...new Set(list.map((s) => s.cwd).filter((c): c is string => !!c))].map((c) => localPath(homeKey(c, dirs.home), dirs.home));
  let files = await listMemoryFilesAsync(dirs, cwds, { signal: o.signal });
  const opts = { home: dirs.home, claudeDir: homeKey(dirs.claudeDir, dirs.home), codexDir: homeKey(dirs.codexDir, dirs.home) };
  await addSince(files, list, dirs.home, o.signal);
  o.signal?.throwIfAborted();
  let report = auditMemory(list, files, opts);
  // Files the sessions touched that the listing missed (outside the dirs it walks): stat them here.
  const extra = report.files.filter((r) => !r.exists).flatMap((r) => fileInfo(localPath(r.path, dirs.home), dirs.home) ?? []);
  if (extra.length) report = auditMemory(list, (files = [...files, ...extra]), opts);
  if (o.agent) {
    // The agent's own files, and any file its sessions loaded, read or wrote (an AGENTS.md that a
    // CLAUDE.md imports): --agent keeps a subset of the plain audit's rows, with the same counts.
    const used = new Set(report.files.filter((r) => r.loaded || r.read || r.wrote).map((r) => r.path));
    const agent = o.agent;
    report = auditMemory(list, files.filter((f) => forAgent(f.key, agent) || used.has(f.key)), opts);
  }
  return { ...report, ...(o.since !== undefined ? { since: o.since } : {}), ...(o.agent ? { agent: o.agent } : {}) };
}
