/**
 * Rewrites a spool side file (`<agent>/raw/<id>.json`, a hook payload too long
 * for its spool line) with its secrets redacted, once ingest has committed the
 * line that names it. The file stays: a re-parse (core/reparse.ts) and a sink
 * that was behind read the line's payload from it again, and they get the
 * redacted payload, as stored events and blobs hold. A file with nothing to
 * redact is left as it is.
 */
import { chmod, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { redactBlobValue, redactionTally, type Redactor } from "./redact.ts";

/** True when the file was rewritten. A file that can't be read or written is left alone (never throws). */
export async function scrubRawFile(path: string, redactor: Redactor): Promise<boolean> {
  const tmp = `${path}.scrub-${process.pid}`;
  try {
    const text = await readFile(path, "utf8");
    // The reader parses a side file as JSON when it can, else keeps the text (core/spool-read.ts).
    let value: unknown = text;
    let json = false;
    try {
      value = JSON.parse(text);
      json = true;
    } catch {
      // not JSON: redact the text
    }
    const clean = json ? redactBlobValue(redactor, value, redactionTally()) : redactor.string(text, redactionTally());
    if (clean === text || (json && clean === JSON.stringify(value))) return false;
    const before = await stat(path);
    // Same name, mode and times: the file is the same payload with markers in place of secrets.
    await writeFile(tmp, clean, { mode: 0o600, flag: "wx" });
    await chmod(tmp, before.mode & 0o777);
    await utimes(tmp, before.atime, before.mtime);
    await rename(tmp, path);
    return true;
  } catch {
    await unlink(tmp).catch(() => {});
    return false;
  }
}
