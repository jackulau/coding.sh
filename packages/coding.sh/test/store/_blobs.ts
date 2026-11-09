// File blob stores for tests: opened stores to close before a temp dir is
// removed (Windows will not delete the open pack database), and back-dating
// a blob for gc's age guard, whether it is a pack row or a file.
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { FsBlobStore, PACK_FILE } from "../../src/store/fs-blobs.ts";

const opened: FsBlobStore[] = [];

export function fsBlobs(root: string, opts?: ConstructorParameters<typeof FsBlobStore>[1]): FsBlobStore {
  return track(new FsBlobStore(root, opts));
}

/** Adds a store (a subclass, say) to the ones `closeBlobs` closes. */
export function track<T extends FsBlobStore>(s: T): T {
  opened.push(s);
  return s;
}

/** Closes every store `fsBlobs` or `track` saw. Call it in `after`, before removing the temp dirs. */
export async function closeBlobs(): Promise<void> {
  await Promise.all(opened.splice(0).map((s) => s.close()));
}

export async function ageBlob(blobs: FsBlobStore, ref: string, days: number): Promise<void> {
  const t = Date.now() - days * 86_400_000;
  const file = blobs.pathFor(ref);
  if (existsSync(file)) utimesSync(file, new Date(t), new Date(t));
  const pack = join(blobs.root, PACK_FILE);
  if (!existsSync(pack)) return;
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(pack);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE blobs SET mtime = ? WHERE ref = ?").run(t, Buffer.from(ref, "hex"));
  } finally {
    db.close();
  }
}
