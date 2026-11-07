import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventId, hashParts, isSha256Hex, sha256Hex, sortableId, sortableIdTime } from "../../src/core/ids.ts";

describe("ids", () => {
  it("sha256Hex matches known vectors for strings and bytes", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex(new TextEncoder().encode("abc")), sha256Hex("abc"));
    assert.ok(isSha256Hex(sha256Hex("x")));
    assert.ok(!isSha256Hex("ABC"));
  });

  it("hashParts separates parts unambiguously", () => {
    assert.notEqual(hashParts("ab", "c"), hashParts("a", "bc"));
    assert.equal(hashParts("a", 1), hashParts("a", "1"));
  });

  it("eventId is deterministic and sensitive to every input", () => {
    const base = eventId("codex", "s1", "codex/a.jsonl", 10);
    assert.equal(base, eventId("codex", "s1", "codex/a.jsonl", 10, 0));
    assert.ok(isSha256Hex(base));
    for (const other of [
      eventId("claude-code", "s1", "codex/a.jsonl", 10),
      eventId("codex", "s2", "codex/a.jsonl", 10),
      eventId("codex", "s1", "codex/b.jsonl", 10),
      eventId("codex", "s1", "codex/a.jsonl", 11),
      eventId("codex", "s1", "codex/a.jsonl", 10, 1),
    ]) assert.notEqual(base, other);
  });

  it("sortableId is lexicographically ordered, monotonic and decodes its time", () => {
    const ids = Array.from({ length: 2000 }, () => sortableId("run_"));
    assert.deepEqual([...ids].sort(), ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.match(ids[0]!, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    const t = 1_700_000_000_000;
    const later = sortableId("", t + 1);
    assert.ok(sortableIdTime(later) >= t + 1);
    const future = Date.now() + 60_000;
    assert.equal(sortableIdTime(sortableId("", future)), future);
    assert.equal(sortableIdTime(sortableId("task_", future + 5), 5), future + 5);
  });
});
