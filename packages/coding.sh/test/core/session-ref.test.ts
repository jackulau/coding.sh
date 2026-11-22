// Session references (core/session-ref.ts): the shortest id coding.sh prints for a session resolves
// back to it, through the same rules the CLI, MCP and `work show` take ids by.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { IdSet, matchRef, MAX_CANDIDATES, SHORT_ID_MIN, shortestRef } from "../../src/core/session-ref.ts";

const PARENT = "36d2966a-1c53-47f1-891d-aae1827d0e95";
/** A subagent id as Claude Code writes one: "a" and 16 hex digits. */
const child = (n: number): string => `${PARENT}:sub:a${createHash("sha256").update(`agent-${n}`).digest("hex").slice(0, 16)}`;
const resolves = (set: IdSet, ref: string): string | undefined => {
  const m = matchRef(set, ref);
  return m && "id" in m ? m.id : undefined;
};

describe("shortestRef", () => {
  const children = Array.from({ length: 300 }, (_, i) => child(i));
  const set = new IdSet([PARENT, ...children, "7c3e9d10-aaaa-4000-8000-000000000001", "7c3e9d10-bbbb-4000-8000-000000000002", "default/tenant-7/conv-123", "short"]);

  test("a parent with 300 subagents is 8 characters, and each subagent its own 8", () => {
    assert.equal(shortestRef(set, PARENT), PARENT.slice(0, SHORT_ID_MIN));
    for (const id of children) {
      const s = shortestRef(set, id);
      assert.ok(s.length <= 9, `${id} -> ${s}`);
      assert.equal(resolves(set, s), id, `${s} names ${id}`);
    }
    assert.equal(shortestRef(set, children[0]!), children[0]!.split(":sub:")[1]!.slice(0, SHORT_ID_MIN));
  });

  test("ids that share 8 characters get the length that tells them apart, and the shared prefix is ambiguous", () => {
    const a = shortestRef(set, "7c3e9d10-aaaa-4000-8000-000000000001");
    const b = shortestRef(set, "7c3e9d10-bbbb-4000-8000-000000000002");
    assert.deepEqual([a, b], ["7c3e9d10-a", "7c3e9d10-b"]);
    assert.deepEqual(matchRef(set, "7c3e9d10"), { ambiguous: ["7c3e9d10-aaaa-4000-8000-000000000001", "7c3e9d10-bbbb-4000-8000-000000000002"] });
  });

  test("an id of 8 characters or fewer, or one not stored, comes back whole", () => {
    assert.equal(shortestRef(set, "short"), "short");
    assert.equal(shortestRef(set, "not-stored-at-all"), "not-stored-at-all");
    assert.equal(resolves(set, shortestRef(set, "default/tenant-7/conv-123")), "default/tenant-7/conv-123");
  });

  test("a subagent's own id is not used when a top-level id starts with it", () => {
    const sub = `${PARENT}:sub:abcdef0123456789`;
    const s = new IdSet([PARENT, sub, "abcdef01-top-level"]);
    const ref = shortestRef(s, sub);
    assert.notEqual(ref, "abcdef01");
    assert.equal(resolves(s, ref), sub);
    assert.equal(resolves(s, "abcdef01"), "abcdef01-top-level");
  });
});

describe("matchRef", () => {
  test("a prefix shared by a session's family and another session is ambiguous, however many subagents come first", () => {
    // Every id with the prefix is read: the family used to win when the first 11 were all its own.
    const x = "abcd1234";
    const kids = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `${x}:sub:k${String(i).padStart(2, "0")}`);
    const set = new IdSet([x, ...kids, "abcd1235"]);
    const m = matchRef(set, "abcd123");
    assert.ok(m && "ambiguous" in m, JSON.stringify(m));
    assert.deepEqual(matchRef(set, "abcd1234"), { id: x });
  });

  test("a subagent's own id names it even when it ran subagents of its own", () => {
    const p = "parent-session-0001";
    const sub = `${p}:sub:a33e97aae0b87e2b4`;
    const set = new IdSet([p, sub, `${sub}:sub:b1`, `${sub}:sub:b2`]);
    assert.deepEqual(matchRef(set, "a33e97aa"), { id: sub });
    assert.deepEqual(matchRef(set, "pare:sub:a33e"), { id: sub });
  });
});
