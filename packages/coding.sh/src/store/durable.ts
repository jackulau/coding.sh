// Crash-safe file replacement: temp file, fsync, rename, fsync the directory.
// After a crash or power loss the path holds the old content or the new, never
// a torn or empty file, and a completed write survives.
import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Atomically replaces `path` with `data` and makes the result durable. */
export async function writeFileDurable(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dirname(path));
}

/** fsync a directory so a rename or a new entry in it survives a power loss. */
export async function syncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch (err) {
    // Windows cannot open or fsync a directory; there the rename is as durable as it gets.
    if (!["EISDIR", "EPERM", "EINVAL", "EACCES", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await fh?.close();
  }
}
