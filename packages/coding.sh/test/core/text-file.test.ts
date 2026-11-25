// decodeText and readTextFile: a file Windows PowerShell wrote (UTF-16 with a byte order mark, or
// UTF-8 with one) reads as the same text as a plain UTF-8 file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { decodeText, readTextFile, readTextFileSync } from "../../src/core/text-file.ts";

// Non-ASCII in the BMP and outside it (a surrogate pair in UTF-16), and a CRLF as PowerShell writes.
const TEXT = '{"input":"café ✓ \u{1F600}"}\r\n';
const bom8 = (s: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")]);
const le16 = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const be16 = (s: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, "utf16le").swap16()]);

describe("decodeText", () => {
  test("plain UTF-8 and empty bytes read as they are", () => {
    assert.equal(decodeText(Buffer.from(TEXT, "utf8")), TEXT);
    assert.equal(decodeText(Buffer.alloc(0)), "");
  });

  test("drops a UTF-8 byte order mark, so JSON.parse takes the text", () => {
    assert.equal(decodeText(bom8(TEXT)), TEXT);
    assert.equal(decodeText(bom8("")), "");
    assert.deepEqual(JSON.parse(decodeText(bom8(TEXT))), JSON.parse(TEXT));
  });

  test("reads UTF-16 in either byte order, without its byte order mark", () => {
    assert.equal(decodeText(le16(TEXT)), TEXT);
    assert.equal(decodeText(be16(TEXT)), TEXT);
    assert.equal(decodeText(le16("")), "");
    assert.equal(decodeText(be16("")), "");
  });

  test("an odd last byte of UTF-16 is dropped, and the caller's bytes stay as they were", () => {
    assert.equal(decodeText(Buffer.concat([le16("ab"), Buffer.from([0x61])])), "ab");
    const bytes = Buffer.concat([be16("ab"), Buffer.from([0x00])]);
    const copy = Buffer.from(bytes);
    assert.equal(decodeText(bytes), "ab");
    assert.deepEqual(bytes, copy, "the UTF-16BE swap works on a copy");
  });

  test("a U+FEFF after the first character is text, not a byte order mark", () => {
    assert.equal(decodeText(Buffer.from("a﻿b", "utf8")), "a﻿b");
  });
});

describe("readTextFile and readTextFileSync", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "csh-text-file-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("read each encoding from disk as the same text", async () => {
    const encodings: [string, Buffer][] = [["plain", Buffer.from(TEXT, "utf8")], ["utf8-bom", bom8(TEXT)], ["utf16le", le16(TEXT)], ["utf16be", be16(TEXT)]];
    for (const [name, bytes] of encodings) {
      const file = join(dir, `${name}.json`);
      writeFileSync(file, bytes);
      assert.equal(await readTextFile(file), TEXT, name);
      assert.equal(readTextFileSync(file), TEXT, name);
    }
  });

  test("a missing file fails with ENOENT, as readFile does", async () => {
    const file = join(dir, "missing.json");
    await assert.rejects(readTextFile(file), { code: "ENOENT" });
    assert.throws(() => readTextFileSync(file), { code: "ENOENT" });
  });
});
