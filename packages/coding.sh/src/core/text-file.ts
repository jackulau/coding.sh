// Text from a file a person names on the command line: a JSON spec, a dataset, labels, the values
// to purge. Windows PowerShell 5.1 writes UTF-16 with a byte order mark through `>` and Out-File,
// and UTF-8 with one through `Out-File -Encoding utf8`. Read as plain UTF-8, the first gives text
// with a NUL after every ASCII letter and the second a leading U+FEFF that JSON.parse refuses.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * Bytes as text. A UTF-8 byte order mark is dropped, and bytes that start with a UTF-16 one (either
 * byte order) are read as UTF-16 without it. Anything else is UTF-8.
 */
export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.toString("utf8", 3);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le", 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // A copy, so swapping the byte pairs leaves the caller's buffer alone; an odd last byte is dropped.
    const le = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
    return le.swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

/** A file's text, decoded as decodeText does. */
export async function readTextFile(path: string): Promise<string> {
  return decodeText(await readFile(path));
}

/** readTextFile, synchronously. A number is a file descriptor: 0 reads stdin. */
export function readTextFileSync(path: string | number): string {
  return decodeText(readFileSync(path));
}
