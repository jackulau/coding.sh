// The MCP harness_audit tool: `coding.sh harness audit` (which memory files,
// CLAUDE.md/AGENTS.md, rules and skills sessions loaded and read, and what
// loading them costs per session), and with check: true `coding.sh refine
// check` on the uncommitted edits. Read-only: the agent trims with its own
// tools. The refine loop runs agent sessions for minutes, so the audit returns
// its command instead of running it.
import { relative } from "node:path";
import type { Context } from "../core/context.ts";
import { isHarnessPath } from "../core/harness-paths.ts";
import { localPath, memoryAudit, memoryDirs } from "../core/memory-files.ts";
import type { MemoryRow } from "../core/memory-audit.ts";
import type { AgentId } from "../schema/index.ts";
import { parseSince } from "../cli/args.ts";
import { iso } from "./data.ts";
import { ToolError } from "./protocol.ts";

type Obj = Record<string, unknown>;

export interface AuditArgs {
  since?: string | undefined;
  agent?: string | undefined;
  limit?: number | undefined;
}

/** The repo's git root, or undefined outside a repo. */
async function gitRootOf(cwd: string): Promise<string | undefined> {
  const { gitRoot } = await import("../cli/commands/exp-ab.ts");
  return gitRoot(cwd);
}

/**
 * The refine run that cuts this repo's costliest instruction file (by load tokens over
 * the window; else refine's default target) and keeps a cut only while the suite's pass
 * rate holds. Undefined outside a repo or when the repo has no harness file.
 */
async function refineNext(rows: readonly MemoryRow[], root: string | undefined, o: { home: string; cwd: string }): Promise<{ command: string; suite: boolean } | undefined> {
  if (!root) return undefined;
  const { harnessFilesIn } = await import("../cli/commands/exp-ab.ts");
  if (!harnessFilesIn(root).length) return undefined;
  const target = rows
    .map((r) => ({ r, abs: localPath(r.path, o.home) }))
    .filter(({ r, abs }) => r.exists && isHarnessPath(relative(root, abs).replace(/\\/g, "/")))
    .sort((a, b) => (b.r.loadTokens ?? 0) - (a.r.loadTokens ?? 0))
    .map(({ abs }) => relative(o.cwd, abs).replace(/\\/g, "/"))[0];
  const { loadSuite, suiteDirs } = await import("../eval/suite-spec.ts");
  let suite: string | undefined;
  for (const d of suiteDirs(root)) {
    const s = await loadSuite(d).catch(() => undefined);
    if (s?.kind === "tasks") {
      suite = s.spec.name;
      break;
    }
  }
  return { command: `coding.sh refine run --suite ${suite ?? "<name>"}${target ? ` --target ${target}` : ""} --objective size`, suite: suite !== undefined };
}

/** harness_audit: per file, the sessions that loaded, read and wrote it; unused and costly first. */
export async function auditReport(ctx: Context, a: AuditArgs, c: { cwd: string; env: NodeJS.ProcessEnv; now: number }): Promise<Obj> {
  const text = a.since ?? "30d";
  let since: number;
  try {
    since = parseSince(text, c.now);
  } catch {
    throw new ToolError(`since must be a duration like 30d or 12h, or an ISO date: got ${JSON.stringify(text)}`);
  }
  const { home } = memoryDirs(c.env);
  const r = await memoryAudit(ctx.index, { since, env: c.env, ...(a.agent ? { agent: a.agent as AgentId } : {}) });
  const t = r.totals;
  const limit = a.limit ?? 20;
  // Flagged files first, then the costliest to load (the CLI table's order).
  const rows = [...r.files].sort((x, y) => Number(y.flags.length > 0) - Number(x.flags.length > 0) || (y.loadTokens ?? 0) - (x.loadTokens ?? 0));
  const refine = await refineNext(r.files, await gitRootOf(c.cwd), { home, cwd: c.cwd });
  return {
    since: iso(since),
    sessions: r.sessions,
    ...(r.sessions && t.loadTokens ? { loadTokensPerSession: Math.round(t.loadTokens / r.sessions) } : {}),
    unused: { neverRead: t.neverRead, writeOnly: t.writeOnly, loadedNotRead: t.loadedNotRead },
    files: rows.slice(0, limit).map((f) => ({
      path: localPath(f.path, home),
      kind: f.kind,
      ...(f.exists ? { tokens: f.tokens } : { gone: true }),
      loaded: f.loaded,
      read: f.read,
      wrote: f.wrote,
      ...(f.loadTokens ? { loadTokens: f.loadTokens } : {}),
      ...(f.lastRead !== undefined ? { lastRead: iso(f.lastRead) } : {}),
      flags: f.flags,
    })),
    ...(rows.length > limit ? { more: rows.length - limit } : {}),
    ...(refine ? { next: [refine.command] } : {}),
    ...(refine && !refine.suite ? { note: "refine run needs an eval suite of repo tasks: build one with eval_init (source: sessions), then pass its name." } : {}),
  };
}

/** harness_audit check: true: did the uncommitted harness edits delete, reword or relax a protected line? */
export async function auditCheck(c: { cwd: string; env: NodeJS.ProcessEnv }): Promise<Obj> {
  const root = await gitRootOf(c.cwd);
  if (!root) throw new ToolError("check compares the uncommitted CLAUDE.md, AGENTS.md, rule and skill edits with git HEAD: run the server inside the repo.");
  const [{ harnessFilesIn, resolveArm, sameFiles }, { checkProtected }, { refineProtectConfig }] = await Promise.all([import("../cli/commands/exp-ab.ts"), import("../refine/protect.ts"), import("../refine/config.ts")]);
  let cfg;
  try {
    cfg = refineProtectConfig(c.env, c.cwd);
  } catch (e) {
    throw new ToolError(`The [refine] config is invalid: ${(e as Error).message}`);
  }
  const current = harnessFilesIn(root);
  // git:HEAD reads git only; the store context is for harness bundles.
  const head = await resolveArm("git:HEAD", { cwd: c.cwd, root, base: current, flag: "a", ctx: { index: { getBundle: async () => undefined }, blobs: undefined } as never });
  const r = checkProtected(head.files, current, { protect: [...(cfg.protect ?? [])], autoProtect: cfg.autoProtect !== false });
  const first = r.rejections[0]?.protected;
  return {
    check: {
      ok: r.ok,
      changed: !sameFiles(head.files, current),
      protected: r.protected.length,
      rejections: r.rejections.map((x) => ({ reason: x.reason, line: `${x.protected.path}:${x.protected.line}`, text: x.protected.text, ...(x.added ? { added: `${x.added.path}:${x.added.line}` } : {}) })),
    },
    ...(first ? { next: ["Restore the line, or ask the user to allow it:", `coding.sh refine check --allow-protected-edit ${first.path}:${first.line}`] } : {}),
  };
}
