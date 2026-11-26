/**
 * Rewrites a spool side file (`<agent>/raw/<id>.json`, a hook payload too long
 * for its spool line) with its secrets redacted, once ingest has committed the
 * line that names it. The file stays: a re-parse (core/reparse.ts) and a sink
 * that was behind read the line's payload from it again, and they get the
 * redacted payload, as stored events and blobs hold. A file with nothing to
 * redact is left as it is.
 */
import { chmod, mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactBlobValue, redactForBlob, redactionTally, type RedactionTally, type Redactor } from "./redact.ts";
import { readSpoolFile } from "./spool-read.ts";

/**
 * Redacts the inline payloads of a spool file that ingest has read to its end
 * (a day that has passed: no hook appends to it any more). A line whose payload
 * holds a secret is overwritten in place with the redacted line, padded with
 * spaces to its old length; a redacted line that comes out longer moves its
 * payload to a `raw/` side file, named relative to the agent dir. A line that
 * is not valid JSON and holds a secret becomes spaces (readers skip it as they
 * did before). A torn fragment with a whole line glued on (core/spool-read.ts)
 * is checked up to where that line starts: one that holds a secret becomes a
 * blank line, spaces and a "\n", and the glued line is kept, redacted as any
 * other line. The file keeps its size and mtime, and every line still reads
 * from the offset where it started, so every cursor into it and every event id
 * built from an offset still holds.
 *
 * Returns how many lines were rewritten. A file that can't be read or written
 * is left alone (never throws).
 */
export async function scrubSpoolFile(spoolDir: string, path: string, redactorFor: (cwd: string | undefined) => Redactor): Promise<number> {
  const found = (redactor: Redactor, fn: (tally: RedactionTally) => unknown) => {
    const tally = redactionTally();
    const out = fn(tally);
    return Object.keys(tally.kinds).length ? out : undefined;
  };
  /** `text` goes over bytes [offset, end): the line without its "\n". */
  const edits: { offset: number; end: number; text: string }[] = [];
  /** Lines the reader reported; `kept` is where the whole line glued onto a torn fragment starts. */
  const bad: { offset: number; nextOffset: number; kept?: number }[] = [];
  try {
    for await (const { line, offset, nextOffset } of readSpoolFile(spoolDir, path, 0, { resolveRaw: false, onError: (e) => bad.push({ offset: e.offset, nextOffset: e.nextOffset }) })) {
      // The reader reports a fragment with a line glued on, then yields that line: the same nextOffset.
      const last = bad.at(-1);
      if (last?.nextOffset === nextOffset && offset > last.offset) last.kept = offset;
      if (line.raw === undefined) continue;
      const redactor = redactorFor(line.cwd);
      const clean = found(redactor, (tally) => redactForBlob(redactor, line.raw, tally));
      if (clean === undefined) continue;
      const end = nextOffset - 1;
      let text = JSON.stringify({ ...line, raw: clean });
      if (Buffer.byteLength(text) > end - offset) {
        const { raw: _raw, ...rest } = line;
        const name = `${line.ts}-scrub-${Math.random().toString(36).slice(2, 10)}.json`;
        text = JSON.stringify({ ...rest, rawFile: `raw/${name}` });
        if (Buffer.byteLength(text) > end - offset) text = JSON.stringify({ ...rest, raw: "" });
        else await writeSide(join(path, "..", "raw"), name, typeof clean === "string" ? clean : JSON.stringify(clean));
      }
      edits.push({ offset, end, text });
    }
    const fh = await open(path, "r+");
    try {
      const before = await fh.stat();
      for (const b of bad) {
        // A glued line is redacted as a line of its own above: only the fragment before it is checked here.
        const buf = Buffer.alloc((b.kept ?? b.nextOffset) - b.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, b.offset);
        const text = buf.toString("utf8", 0, bytesRead);
        const redactor = redactorFor(undefined);
        if (found(redactor, (tally) => redactor.string(text, tally)) === undefined) continue;
        // The fragment ends in a "\n": a blank line, so the glued line still reads from where it starts.
        if (b.kept !== undefined) edits.push({ offset: b.offset, end: b.kept, text: `${" ".repeat(b.kept - b.offset - 1)}\n` });
        // Spaces: a blank line, skipped as the bad one was. A torn last line has no "\n" to keep.
        else edits.push({ offset: b.offset, end: b.offset + bytesRead - (text.endsWith("\n") ? 1 : 0), text: "" });
      }
      for (const e of edits) {
        const buf = Buffer.alloc(e.end - e.offset, " ");
        if (Buffer.byteLength(e.text) > buf.length) continue; // never shift a byte of the next line
        buf.write(e.text);
        await fh.write(buf, 0, buf.length, e.offset);
      }
      if (edits.length) await fh.utimes(before.atime, before.mtime);
    } finally {
      await fh.close();
    }
    return edits.length;
  } catch {
    return 0;
  }
}

async function writeSide(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, name), body, { mode: 0o600, flag: "wx" });
}

/** JSON.stringify(v), or undefined for a value too deep to serialize (redaction replaced its deep part). */
function serialized(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

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
    if (clean === text || (json && clean === serialized(value))) return false;
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
