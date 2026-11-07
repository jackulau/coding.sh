import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CsvError, parseCsv, parseCsvObjects, stringifyCsv } from "../../src/datasets/csv.ts";

describe("parseCsv", () => {
  it("parses plain records", () => {
    assert.deepEqual(parseCsv("a,b,c\n1,2,3\n"), [
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with delimiters and escaped quotes", () => {
    assert.deepEqual(parseCsv('x,"a, b","he said ""hi"""\n'), [["x", "a, b", 'he said "hi"']]);
  });

  it("keeps newlines (LF, CRLF, CR) inside quotes and counts lines", () => {
    assert.deepEqual(parseCsv('id,text\r\n1,"line1\r\nline2"\r\n2,"a\nb\rc"\r\n'), [
      ["id", "text"],
      ["1", "line1\r\nline2"],
      ["2", "a\nb\rc"],
    ]);
  });

  it("accepts CRLF, LF and bare CR record separators", () => {
    const want = [
      ["a", "b"],
      ["1", "2"],
    ];
    assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), want);
    assert.deepEqual(parseCsv("a,b\n1,2"), want);
    assert.deepEqual(parseCsv("a,b\r1,2\r"), want);
  });

  it("strips a UTF-8 BOM", () => {
    const rows = parseCsv("﻿name,x\nbob,1\n");
    assert.equal(rows[0]?.[0], "name");
  });

  it("keeps empty fields, including trailing ones", () => {
    assert.deepEqual(parseCsv("a,,c,\n,,,\n"), [
      ["a", "", "c", ""],
      ["", "", "", ""],
    ]);
  });

  it("quoted empty string and quoted field followed by text", () => {
    assert.deepEqual(parseCsv('"",x\n"ab"c,d\n'), [
      ["", "x"],
      ["abc", "d"],
    ]);
  });

  it("skips blank lines by default but can keep them", () => {
    assert.deepEqual(parseCsv("a\n\nb\n"), [["a"], ["b"]]);
    assert.deepEqual(parseCsv("a\n\nb\n", { skipEmptyLines: false }), [["a"], [""], ["b"]]);
  });

  it("keeps a bare quote inside an unquoted field literally", () => {
    assert.deepEqual(parseCsv('5" pipe,x\n'), [['5" pipe', "x"]]);
  });

  it("throws on an unterminated quote with the line it opened on", () => {
    assert.throws(
      () => parseCsv('a,b\n1,"oops\n2,3\n'),
      (e: unknown) => e instanceof CsvError && e.line === 2,
    );
  });

  it("supports other delimiters", () => {
    assert.deepEqual(parseCsv("a;b\n1;\"x;y\"\n", { delimiter: ";" }), [
      ["a", "b"],
      ["1", "x;y"],
    ]);
  });
});

describe("parseCsvObjects", () => {
  it("maps rows to header keys, padding short rows", () => {
    assert.deepEqual(parseCsvObjects("a,b\n1\n3,4\n"), [
      { a: "1", b: "" },
      { a: "3", b: "4" },
    ]);
  });
  it("rejects rows longer than the header and duplicate columns", () => {
    assert.throws(() => parseCsvObjects("a,b\n1,2,3\n"), /3 fields/);
    assert.throws(() => parseCsvObjects("a,a\n1,2\n"), /duplicate column/);
  });
});

describe("stringifyCsv", () => {
  it("round-trips awkward values", () => {
    const rows = [
      ["id", "text"],
      ["1", 'quote " and, comma'],
      ["2", "multi\nline\r\nvalue"],
      ["3", " padded "],
      ["4", ""],
    ];
    const text = stringifyCsv(rows);
    assert.ok(text.endsWith("\r\n"));
    assert.deepEqual(parseCsv(text), rows);
  });
});
