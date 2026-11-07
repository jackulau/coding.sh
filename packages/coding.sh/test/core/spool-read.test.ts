import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listSpoolFiles, rawFilesOf, readSpoolFile, resolveRawFile, TORN_TAIL_MS, type SpoolReadError, type SpoolRecord } from "../../src/core/spool-read.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function spool() {
  const dir = mkdtempSync(join(tmpdir(), "csh-spool-"));
  roots.push(dir);
  mkdirSync(join(dir, "codex"), { recursive: true });
  return dir;
}
const line = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 0, agent: "codex", event: "Stop", ts: 1, pid: 1, cwd: "/w", raw: { a: 1 }, ...o }) + "\n";

async function readAll(dir: string, file: string, from = 0, chunkSize?: number) {
  const recs: SpoolRecord[] = [];
  const errs: SpoolReadError[] = [];
  for await (const r of readSpoolFile(dir, file, from, { onError: (e) => errs.push(e), chunkSize })) recs.push(r);
  return { recs, errs };
}

describe("spool-read", () => {
  it("lists <agent>/*.jsonl with relative sources", async () => {
    const dir = spool();
    writeFileSync(join(dir, "codex", "2026-11-06.1.jsonl"), line());
    writeFileSync(join(dir, "codex", "notes.txt"), "x");
    writeFileSync(join(dir, "errors.log"), "x");
    mkdirSync(join(dir, "claude-code"));
    writeFileSync(join(dir, "claude-code", "2026-11-05.9.jsonl"), "");
    const files = await listSpoolFiles(dir);
    assert.deepEqual(files.map((f) => [f.source, f.agent]), [["claude-code/2026-11-05.9.jsonl", "claude-code"], ["codex/2026-11-06.1.jsonl", "codex"]]);
    assert.deepEqual(await listSpoolFiles(join(dir, "missing")), []);
  });

  it("yields byte offsets (multi-byte safe) and resumes from a cursor", async () => {
    const dir = spool();
    const file = join(dir, "codex", "a.jsonl");
    const l1 = line({ raw: { text: "héllo ✓ 😀" } });
    const l2 = line({ event: "Second" });
    writeFileSync(file, l1 + l2);
    for (const chunk of [undefined, 7]) {
      const { recs } = await readAll(dir, file, 0, chunk);
      assert.equal(recs.length, 2);
      assert.equal(recs[0]!.source, "codex/a.jsonl");
      assert.equal(recs[0]!.offset, 0);
      assert.equal(recs[0]!.nextOffset, Buffer.byteLength(l1));
      assert.equal(recs[1]!.nextOffset, Buffer.byteLength(l1 + l2));
      assert.deepEqual(recs[0]!.line.raw, { text: "héllo ✓ 😀" });
    }
    const { recs } = await readAll(dir, file, Buffer.byteLength(l1));
    assert.deepEqual(recs.map((r) => r.line.event), ["Second"]);
  });

  it("does not consume a partially written last line", async () => {
    const dir = spool();
    const file = join(dir, "codex", "a.jsonl");
    const full = line();
    const partial = line({ event: "Late" });
    writeFileSync(file, full + partial.slice(0, 20));
    let { recs, errs } = await readAll(dir, file);
    assert.equal(recs.length, 1);
    assert.equal(errs.length, 0, "partial line is not an error");
    const cursor = recs[0]!.nextOffset;
    appendFileSync(file, partial.slice(20));
    ({ recs } = await readAll(dir, file, cursor));
    assert.deepEqual(recs.map((r) => r.line.event), ["Late"]);
  });

  it("reports and skips malformed lines, tolerates CRLF and blank lines", async () => {
    const dir = spool();
    const file = join(dir, "codex", "a.jsonl");
    writeFileSync(file, `${line()}\n{not json}\n[1]\n${JSON.stringify({ event: "x", ts: 1 })}\n${line({ event: "Crlf" }).trimEnd()}\r\n`);
    const { recs, errs } = await readAll(dir, file);
    assert.deepEqual(recs.map((r) => r.line.event), ["Stop", "Crlf"]);
    assert.deepEqual(errs.map((e) => e.message.split(":")[0]), ["invalid JSON", "spool line is not a JSON object", "spool line has no agent"]);
    assert.ok(errs.every((e) => e.nextOffset > e.offset));
  });

  it("resolves rawFile side files and refuses paths outside the spool", async () => {
    const dir = spool();
    const file = join(dir, "codex", "a.jsonl");
    mkdirSync(join(dir, "codex", "raw"));
    writeFileSync(join(dir, "codex", "raw", "big.json"), JSON.stringify({ huge: "x".repeat(100) }));
    writeFileSync(join(dir, "codex", "raw", "plain.txt"), "not json");
    writeFileSync(file, [
      line({ raw: undefined, rawFile: "raw/big.json" }),
      line({ raw: undefined, rawFile: join(dir, "codex", "raw", "plain.txt") }),
      line({ raw: undefined, rawFile: "raw/missing.json" }),
      line({ raw: undefined, rawFile: "../../../../etc/passwd" }),
    ].join(""));
    const { recs, errs } = await readAll(dir, file);
    assert.equal(recs.length, 4, "lines with unreadable raw files are kept");
    assert.deepEqual(recs[0]!.line.raw, { huge: "x".repeat(100) });
    assert.equal(recs[1]!.line.raw, "not json");
    assert.equal(recs[2]!.line.raw, undefined);
    assert.equal(errs.length, 2);
    assert.match(errs[1]!.message, /outside the spool directory/);
    assert.throws(() => resolveRawFile(dir, file, "/etc/passwd"), /outside/);
    assert.deepEqual(await rawFilesOf(dir, file), [join(dir, "codex", "raw", "big.json"), join(dir, "codex", "raw", "plain.txt"), join(dir, "codex", "raw", "missing.json")]);
  });

  it("orders each agent's files by day, then mtime, then name (not by pid as a string)", async () => {
    const dir = spool();
    const at = (name: string, ms: number) => {
      const p = join(dir, "codex", name);
      writeFileSync(p, line());
      utimesSync(p, new Date(ms), new Date(ms));
    };
    const t0 = Date.UTC(2026, 10, 6, 12);
    at("2026-11-06.10000.jsonl", t0 + 2000); // written after 9999 (digit rollover)
    at("2026-11-06.9999.jsonl", t0 + 1000);
    at("2026-11-06.112.jsonl", t0 + 3000); // pid wrapped around
    at("2026-11-05.99990.jsonl", t0 + 9000); // an older day, touched later, still first
    at("2026-11-06.20.jsonl", t0 + 3000); // same mtime as 112: name breaks the tie
    const files = await listSpoolFiles(dir);
    assert.deepEqual(files.map((f) => f.source.split("/")[1]), ["2026-11-05.99990.jsonl", "2026-11-06.9999.jsonl", "2026-11-06.10000.jsonl", "2026-11-06.112.jsonl", "2026-11-06.20.jsonl"]);
  });

  it("reports and skips a torn last line once the file has been untouched for over an hour", async () => {
    const dir = spool();
    const file = join(dir, "codex", "a.jsonl");
    const good = line();
    writeFileSync(file, good + line({ event: "Torn" }).slice(0, 40));
    const old = new Date(Date.now() - TORN_TAIL_MS - 60_000);
    utimesSync(file, old, old);
    const { recs, errs } = await readAll(dir, file);
    assert.equal(recs.length, 1);
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.message, /incomplete last line/);
    assert.deepEqual([errs[0]!.offset, errs[0]!.nextOffset], [good.length, statSync(file).size], "the cursor can move to the end");
  });
});
