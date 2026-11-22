// Session references (core/session-ref.ts): the shortest id coding.sh prints for a session resolves
// back to it, through the same rules the CLI, MCP and `work show` take ids by. An id whose shortest
// prefix is long or needs quoting prints an alias instead; the aliases below are pinned so a change
// to how they are made shows here.
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

/** Two T3 Code-like thread ids (made up): a shared start of 205 characters, with percent-encoding. */
const SHARED = `t3code-thread%3Aproj%253Ademo%253A${"abcdefghij".repeat(17)}`;
const LONG_A = `${SHARED}-first`;
const LONG_B = `${SHARED}-second`;

describe("an id whose shortest prefix is long or needs quoting prints an alias", () => {
  const set = new IdSet([LONG_A, LONG_B, PARENT, child(1), "7c3e9d10-aaaa-4000-8000-000000000001", "7c3e9d10-bbbb-4000-8000-000000000002"]);

  test("two ids that share a 200-character prefix each print an alias under 40 characters that names them; a UUID keeps its 8-character prefix", () => {
    assert.equal(shortestRef(set, LONG_A), "x_d52r41f3");
    assert.equal(shortestRef(set, LONG_B), "x_8n2twz83");
    assert.equal(resolves(set, "x_d52r41f3"), LONG_A);
    assert.equal(resolves(set, "x_8n2twz83"), LONG_B);
    // Ordinary ids print what they printed before.
    assert.equal(shortestRef(set, PARENT), "36d2966a");
    assert.equal(shortestRef(set, child(1)), child(1).split(":sub:")[1]!.slice(0, SHORT_ID_MIN));
    assert.equal(shortestRef(set, "7c3e9d10-aaaa-4000-8000-000000000001"), "7c3e9d10-a");
  });

  test("the alias is a hash of the id alone: it names the id in any store, and a longer one names it too", () => {
    const alone = new IdSet([LONG_A]);
    assert.equal(shortestRef(alone, LONG_A), "t3code-t", "alone, its 8-character prefix needs no alias");
    assert.equal(resolves(alone, "x_d52r41f3"), LONG_A);
    assert.equal(resolves(alone, "x_d52r41f3jz4egb"), LONG_A);
    assert.equal(resolves(set, "x_d52r41f3k"), undefined, "one wrong character names nothing");
    // An id that never needs an alias has none: a UUID's hash names nothing.
    assert.equal(resolves(set, "x_mqv8j5r3"), undefined);
  });

  test("an id with % in its first 40 characters prints an alias when its shortest prefix would hold the %", () => {
    const s = new IdSet(["t3code-thread%3Aone", "t3code-thread%3Atwo", "t3%3Athread-7", "my run", PARENT]);
    assert.equal(shortestRef(s, "t3code-thread%3Aone"), "x_h7r15hma");
    assert.equal(shortestRef(s, "t3code-thread%3Atwo"), "x_jbnqtt7f");
    assert.equal(shortestRef(s, "t3%3Athread-7"), "x_7hw40eqc");
    // A short id with a space came back whole; it needs quoting too.
    assert.equal(shortestRef(s, "my run"), "x_tcz7c2av");
    for (const id of ["t3code-thread%3Aone", "t3code-thread%3Atwo", "t3%3Athread-7", "my run"]) assert.equal(resolves(s, shortestRef(s, id)), id);
    // The prefix still works, and an id whose shortest prefix stops before its % keeps the prefix.
    assert.equal(resolves(s, "t3code-thread%3Ao"), "t3code-thread%3Aone");
    assert.equal(shortestRef(new IdSet(["t3code-thread%3Aone", PARENT]), "t3code-thread%3Aone"), "t3code-t");
  });

  test("an alias two ids share is ambiguous and lists both; each prints a longer alias that names it alone", () => {
    // Found by search: the first 40 bits of their SHA-256 are the same.
    const a = "t3code-thread%3Acollide-442967";
    const b = "t3code-thread%3Acollide-1705744";
    const s = new IdSet([a, b, PARENT]);
    assert.deepEqual(matchRef(s, "x_xnbfypjk"), { ambiguous: [b, a] });
    assert.equal(shortestRef(s, a), "x_xnbfypjkj");
    assert.equal(shortestRef(s, b), "x_xnbfypjk8");
    assert.equal(resolves(s, "x_xnbfypjkj"), a);
    assert.equal(resolves(s, "x_xnbfypjk8"), b);
  });

  test("a reference is read as the exact id first, then as an alias, then as a prefix", () => {
    const s = new IdSet([LONG_A, LONG_B, "x_d52r41f3", "x_8n2twz83-sdk"]);
    assert.deepEqual(matchRef(s, "x_d52r41f3"), { id: "x_d52r41f3" });
    assert.equal(shortestRef(s, LONG_A), "x_d52r41f3j", "a stored id takes the alias, so the alias grows");
    assert.deepEqual(matchRef(s, "x_8n2twz83"), { id: LONG_B }, "the alias comes before a prefix");
    const sdk = shortestRef(s, "x_8n2twz83-sdk");
    assert.equal(resolves(s, sdk), "x_8n2twz83-sdk", sdk);
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
