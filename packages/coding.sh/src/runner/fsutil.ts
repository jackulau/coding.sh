// Path-safety helpers: overlay and hidden-file writes must never escape their root.
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BlobRef, BlobStore } from "../core/types.ts";

export class PathEscapeError extends Error {}

/** Resolve rel under root; throw if it is absolute, empty, or climbs out. */
export function safeJoin(root: string, rel: string): string {
  if (rel === "" || isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) throw new PathEscapeError(`refusing path ${JSON.stringify(rel)}`);
  const abs = resolve(root, rel);
  const r = relative(resolve(root), abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) throw new PathEscapeError(`path ${JSON.stringify(rel)} escapes ${root}`);
  if (r.split(sep).includes(".git")) throw new PathEscapeError(`refusing to touch .git (${rel})`);
  return abs;
}

/** After mkdir, make sure no symlinked parent redirected us outside root. */
export async function assertInsideReal(root: string, abs: string): Promise<void> {
  const realRoot = await realpath(root);
  const realParent = await realpath(dirname(abs));
  const r = relative(realRoot, realParent);
  if (r.startsWith("..") || isAbsolute(r)) throw new PathEscapeError(`${abs} resolves outside ${root} via a symlink`);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new PathEscapeError(`refusing to write through symlink ${abs}`);
  } catch (e) {
    if (e instanceof PathEscapeError) throw e;
  }
}

export async function safeWrite(root: string, rel: string, data: Uint8Array | string): Promise<string> {
  const abs = safeJoin(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await assertInsideReal(root, abs);
  await writeFile(abs, data);
  return abs;
}

/** Copy verifier-only files (relative path → blob) into dir. */
export async function writeHiddenFiles(dir: string, files: Record<string, BlobRef>, blobs: BlobStore): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, ref] of Object.entries(files)) {
    const data = await blobs.get(ref);
    if (!data) throw new Error(`hidden file ${rel}: blob ${ref} not found`);
    await safeWrite(dir, rel, data);
    written.push(rel);
  }
  return written;
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

