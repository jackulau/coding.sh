// The files inside a Python wheel (.whl, a zip) or sdist (.tar.gz), for the
// secret scan: it reads what ships, not only the loose build output. Zero
// dependencies: node:zlib inflates; the zip and tar layouts are read by hand.
import { gunzipSync, inflateRawSync } from "node:zlib";

/** Each file in a zip as { name, data }. Stored and deflated entries; others are skipped. */
export function* zipEntries(buf) {
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) yield { name, data: raw };
    else if (method === 8) yield { name, data: inflateRawSync(raw) };
  }
}

/** Each regular file in a gzipped tar as { name, data }. */
export function* tarGzEntries(buf) {
  const tar = gunzipSync(buf);
  let longName;
  for (let p = 0; p + 512 <= tar.length; ) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const field = (o, l) => header.toString("utf8", o, o + l).replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const data = tar.subarray(p + 512, p + 512 + size);
    longName = undefined;
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "\0") yield { name, data };
    p += 512 + Math.ceil(size / 512) * 512;
  }
}

/** The entries of a .whl, .zip or .tar.gz file, or undefined for another kind of file. */
export function archiveEntries(file, buf) {
  if (/\.(?:whl|zip)$/i.test(file)) return zipEntries(buf);
  if (/\.(?:tar\.gz|tgz)$/i.test(file)) return tarGzEntries(buf);
  return undefined;
}
