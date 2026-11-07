// Verdict cache keyed by (judge version, input hash). Rerunning an experiment
// or a calibration with an unchanged judge on unchanged inputs costs nothing
// and returns byte-identical verdicts. Only verdicts are stored — never keys,
// headers, or anything else from the request.
import { mkdir, readdir, readFile, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../core/ids.ts";
import { paths } from "../core/paths.ts";
import { writeFileAtomic } from "../datasets/store.ts";
import type { Citation } from "../datasets/types.ts";

export interface CachedVerdict {
  score: number;
  pass: boolean;
  confidence: number;
  reason?: string;
  citations?: Citation[];
  /** Model that answered (as reported by the provider). */
  model: string;
  /** Raw reply text, for audit. */
  raw: string;
  ts: number;
}

export interface JudgeCache {
  get(judgeVersion: string, inputHash: string): Promise<CachedVerdict | undefined>;
  set(judgeVersion: string, inputHash: string, v: CachedVerdict): Promise<void>;
}

export class MemoryJudgeCache implements JudgeCache {
  readonly map = new Map<string, CachedVerdict>();
  async get(j: string, h: string) {
    return this.map.get(`${j}\u001f${h}`);
  }
  async set(j: string, h: string, v: CachedVerdict) {
    this.map.set(`${j}\u001f${h}`, v);
  }
}

/** Default size cap for the on-disk judge cache (gc drops least-recently-used entries past it). */
export const DEFAULT_JUDGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** <dir>/<sha(judgeVersion)[0:16]>/<hash[0:2]>/<hash>.json; dir defaults to <data root>/judge-cache. */
export class FileJudgeCache implements JudgeCache {
  readonly dir: string;
  constructor(dir: string = paths().judgeCache) {
    this.dir = dir;
  }

  /** Cache under the data root of `env` (CODING_SH_HOME aware). */
  static forEnv(env: NodeJS.ProcessEnv = process.env): FileJudgeCache {
    return new FileJudgeCache(paths(env).judgeCache);
  }

  private file(judgeVersion: string, inputHash: string): string {
    if (!/^[0-9a-f]{16,128}$/.test(inputHash)) throw new Error("judge cache: input hash must be hex");
    return join(this.dir, sha256Hex(judgeVersion).slice(0, 16), inputHash.slice(0, 2), `${inputHash}.json`);
  }

  async get(judgeVersion: string, inputHash: string): Promise<CachedVerdict | undefined> {
    const f = this.file(judgeVersion, inputHash);
    try {
      const v = JSON.parse(await readFile(f, "utf8")) as CachedVerdict;
      // A hit refreshes mtime, so size-capped gc evicts least-recently-used entries.
      const now = new Date();
      await utimes(f, now, now).catch(() => {});
      return v;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (e instanceof SyntaxError) return undefined; // torn/corrupt entry: treat as a miss
      throw e;
    }
  }

  async set(judgeVersion: string, inputHash: string, v: CachedVerdict): Promise<void> {
    const f = this.file(judgeVersion, inputHash);
    await mkdir(join(f, ".."), { recursive: true });
    await writeFileAtomic(f, JSON.stringify({ judgeVersion, ...v }) + "\n");
  }
}

export interface JudgeCacheGcResult {
  scanned: number;
  /** Entries removed (or that would be, in a dry run). */
  deleted: number;
  bytes: number;
  /** Bytes left after gc. */
  keptBytes: number;
}

/**
 * Size-capped gc: when the cache holds more than `maxBytes`, deletes the least
 * recently used entries (oldest mtime first) until it fits. Missing dir = empty.
 */
export async function gcJudgeCache(dir: string, opts: { maxBytes?: number; dryRun?: boolean } = {}): Promise<JudgeCacheGcResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_JUDGE_CACHE_MAX_BYTES;
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const ent of entries) {
      const p = join(d, ent.name);
      if (ent.isDirectory() && depth < 2) await walk(p, depth + 1);
      else if (ent.isFile() && ent.name.endsWith(".json")) {
        const s = await stat(p).catch(() => undefined);
        if (s) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await walk(dir, 0);
  let total = files.reduce((n, f) => n + f.size, 0);
  const result: JudgeCacheGcResult = { scanned: files.length, deleted: 0, bytes: 0, keptBytes: total };
  if (total <= maxBytes) return result;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
  for (const f of files) {
    if (total <= maxBytes) break;
    if (!opts.dryRun) await unlink(f.path).catch(() => {});
    total -= f.size;
    result.deleted++;
    result.bytes += f.size;
  }
  result.keptBytes = total;
  return result;
}
