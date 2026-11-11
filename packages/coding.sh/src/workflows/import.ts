// Import Claude Code workflow runs from disk into the workflow store, and their
// agent transcripts into the index as child sessions (so the viewer's session
// timeline opens them). Unchanged run dirs are skipped by signature, before their agent
// transcripts are read.
//
// The Claude Code adapter's backfill walks transcripts only three levels deep,
// so workflow run dirs (five levels) are not picked up there; this importer
// covers them until the adapter globs `<session dir>/**/journal.jsonl` itself.
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { BlobStore, IndexStore } from "../core/types.ts";
import type { Prices } from "../core/pricing.ts";
import type { CaptureProfile } from "../core/ingest.ts";
import { claudeConfigDir } from "../adapters/claude-code.ts";
import { copiedRunOwner, findClaudeWorkflowDirs, loadClaudeWorkflowDir, peekClaudeWorkflowDir, type ClaudeWorkflowDir } from "./sources/claude-workflow.ts";
import type { WorkflowStore } from "./store.ts";
import { buildWorkflowTree, restat, type WorkflowTree } from "./tree.ts";
import type { WorkflowRun } from "./types.ts";

/** Claude Code's workflow concurrency cap on this machine: min(16, cpus − 2). */
export function defaultClaudeCap(): number {
  return Math.min(16, Math.max(1, availableParallelism() - 2));
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "projects");
}

export interface ImportOpts {
  /** Projects dir, project dir, session dir or run dir. */
  root: string;
  store: WorkflowStore;
  /** When given, agent transcripts are written as child sessions. */
  index?: IndexStore;
  blobs?: BlobStore;
  /** Re-import even when the run dir is unchanged. */
  force?: boolean;
  concurrencyCap?: number;
  maxInlineBytes?: number;
  /** Price agent calls that carry tokens but no reported cost (see LoadOpts.prices). */
  prices?: Prices;
  /** Redact, strip (metadata mode) and price agent events as ingest does (see LoadOpts.profile). */
  profile?: CaptureProfile;
  onRun?: (run: WorkflowRun) => void;
}

export interface ImportResult {
  found: number;
  imported: WorkflowRun[];
  skipped: number;
  /** Run dirs that are copies of a run another session wrote (imported once, from that session). */
  copies: number;
  errors: { path: string; error: string }[];
}

// Events per index write. Each write is one transaction, and committing it flushes the
// full-text index; at 500 per write, commits were most of a large import's time.
const PUT_BATCH = 20_000;

export async function importClaudeWorkflows(o: ImportOpts): Promise<ImportResult> {
  const found = await findClaudeWorkflowDirs(o.root);
  const res: ImportResult = { found: found.length, imported: [], skipped: 0, copies: 0, errors: [] };
  // A run dir copied under a second session (fork, resumed or symlinked run) is the
  // same run: import it once, from the session that wrote it, so its agents are
  // stored once and the run keeps its first host.
  const dirs: ClaudeWorkflowDir[] = [];
  const seen = new Set<string>();
  for (const d of found) {
    const owner = await copiedRunOwner(d);
    if (owner) res.copies++;
    const use = owner ?? d;
    if (seen.has(use.runDir)) continue;
    seen.add(use.runDir);
    dirs.push(use);
  }
  const resumed: WorkflowTree[] = [];
  for (const d of dirs) {
    try {
      // An unchanged run dir is skipped before its transcripts are read: they are most of the bytes.
      if (!o.force) {
        const peek = await peekClaudeWorkflowDir(d);
        if ((await o.store.signatureOf(peek.runId)) === peek.signature) {
          res.skipped++;
          continue;
        }
      }
      const loaded = await loadClaudeWorkflowDir(d, {
        ...(o.blobs ? { blobs: o.blobs } : {}),
        concurrencyCap: o.concurrencyCap ?? defaultClaudeCap(),
        ...(o.maxInlineBytes !== undefined ? { maxInlineBytes: o.maxInlineBytes } : {}),
        ...(o.prices ? { prices: o.prices } : {}),
        ...(o.profile ? { profile: o.profile } : {}),
      });
      const tree = buildWorkflowTree(loaded.sources);
      tree.run.source = { kind: "journal", path: d.runDir, signature: loaded.signature };
      if (o.index) {
        for (let i = 0; i < loaded.events.length; i += PUT_BATCH) await o.index.putEvents(loaded.events.slice(i, i + PUT_BATCH));
        for (const s of loaded.sessions) await o.index.upsertSession(s);
      }
      // Experiment tags survive a re-import of the same run dir.
      const prev = await o.store.getRun(tree.run.id);
      if (prev) {
        for (const k of ["variant", "experimentId", "caseId", "attempt"] as const) if (prev.run[k] !== undefined) (tree.run as unknown as Record<string, unknown>)[k] = prev.run[k];
        tree.run.tags = [...new Set([...prev.run.tags, ...tree.run.tags])];
      }
      await o.store.putRun(tree.run, tree.nodes, { outputs: tree.outputs, runOutput: tree.runOutput, ...(loaded.sources.script !== undefined ? { script: loaded.sources.script } : {}) });
      res.imported.push(tree.run);
      if (tree.run.resumedFrom) resumed.push(tree);
    } catch (e) {
      res.errors.push({ path: d.runDir, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Second pass: resumed runs get what their cache hits saved, once every base is stored.
  for (const tree of resumed) {
    const base = await o.store.getRun(tree.run.resumedFrom!);
    if (!base) continue;
    restat(tree, base);
    await o.store.putRun(tree.run, tree.nodes);
  }
  for (const run of res.imported) o.onRun?.(run);
  return res;
}
