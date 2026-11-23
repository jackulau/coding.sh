// Session references (core/session-ref.ts): the shortest id coding.sh prints for a session resolves
// back to it, through the same rules the CLI, MCP and `work show` take ids by. An id whose shortest
// prefix is long or needs quoting prints an alias instead; the aliases below are pinned so a change
// to how they are made shows here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { findSessionRef, IdSet, loadIdSet, matchRef, MAX_CANDIDATES, printedRefs, printsWhole, SHORT_ID_MIN, shortestRef, shortSessionId, wholeRef } from "../../src/core/session-ref.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { resolveCall } from "../../src/proxy/calls.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

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

  test("a reference is read as the exact id first, then as an alias, then as a prefix; a printed alias starts no stored id", () => {
    const s = new IdSet([LONG_A, LONG_B, "x_d52r41f3", "x_8n2twz83-sdk"]);
    assert.deepEqual(matchRef(s, "x_d52r41f3"), { id: "x_d52r41f3" });
    assert.equal(shortestRef(s, LONG_A), "x_d52r41f3j", "a stored id takes the alias, so the alias grows");
    assert.deepEqual(matchRef(s, "x_8n2twz83"), { id: LONG_B }, "the alias comes before a prefix");
    assert.equal(shortestRef(s, LONG_B), "x_8n2twz83h", "an alias a stored id starts with grows too, so it never reads as a prefix of that id");
    // Its first 10 characters read as LONG_B's alias, and its first 8 name it.
    assert.equal(shortestRef(s, "x_8n2twz83-sdk"), "x_8n2twz");
    assert.equal(resolves(s, "x_8n2twz"), "x_8n2twz83-sdk");
  });
});

describe("a printed reference is the shortest that names the session, even where a longer one names another", () => {
  /** 44 characters, so it may print an alias, x_pdd6m28zw… */
  const RUN = "run-0123456789012345678901234567890123456789";

  test("an id that starts with another id's alias prints the 8 characters that name it", () => {
    const s = new IdSet([RUN, "x_pdd6m28zw"]);
    assert.equal(resolves(s, "x_pdd6m28z"), RUN);
    assert.equal(shortestRef(s, "x_pdd6m28zw"), "x_pdd6m2");
    assert.equal(resolves(s, "x_pdd6m2"), "x_pdd6m28zw");
  });

  test("a subagent whose own id is another id's alias prints 8 characters of it", () => {
    const sub = `${RUN}:sub:x_pdd6m28z`;
    const s = new IdSet([RUN, sub]);
    assert.equal(shortestRef(s, sub), "x_pdd6m2");
    assert.equal(resolves(s, "x_pdd6m2"), sub);
  });

  test("a subagent whose own id starts its whole id prints the prefix the whole id starts with", () => {
    // Its parent is not stored, and another subagent has the same own id.
    const sub = "q2222222:sub:q22222222";
    const s = new IdSet(["7c3e9d10-", sub, "7c3e9d10-:sub:q22222222"]);
    assert.equal(shortestRef(s, sub), "q2222222");
    assert.equal(resolves(s, "q2222222"), sub);
    assert.deepEqual(matchRef(s, "q22222222"), { ambiguous: ["7c3e9d10-:sub:q22222222", sub] });
  });

  test("a subagent whose own id holds a / prints the prefix before it when longer ones read as an SDK id", () => {
    const sub = `${PARENT}:sub:tenant-7/conv-1`;
    const s = new IdSet([PARENT, sub, "default/tenant-7/conv-9"]);
    assert.equal(shortestRef(s, sub), "tenant-7");
    assert.equal(resolves(s, "tenant-7"), sub);
    assert.equal(resolves(s, "tenant-7/co"), "default/tenant-7/conv-9");
  });

  test("a subagent under default/ whose own id starts its id after default/ prints the prefix that reads as an SDK id", () => {
    const sub = "default/tenant-7/conv-1:sub:tenant-7/conv-12345";
    const s = new IdSet([sub, "other-run:sub:tenant-7/conv-12345"]);
    assert.equal(shortestRef(s, sub), "tenant-7/");
    assert.equal(resolves(s, "tenant-7/"), sub);
  });
});

describe("a session whose id is latest or last prints an alias: the word opens the newest session", () => {
  const NEWER = "0f3c9d10-aaaa-4000-8000-000000000001";
  const call = (sessionId: string, id: string, ts: number): AgentEvent => ({ id, v: 0, sessionId, ts, agent: "claude-code", kind: "llm.call", model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 1 }, payload: {} });

  for (const [word, alias] of [
    ["latest", "x_brf2qjp3"],
    ["last", "x_6n3wp49a"],
  ] as const) {
    test(`${word} prints ${alias}, which opens it, and ${alias}#1 is its first call`, async () => {
      const index = new MemoryIndexStore();
      const mine = [call(word, `${word}-1`, 1000), call(word, `${word}-2`, 1500)];
      const newer = [call(NEWER, "newer-1", 2000)];
      await index.putEvents([...mine, ...newer]);
      await index.upsertSession(buildSession(mine));
      await index.upsertSession(buildSession(newer));
      const ref = shortestRef(await loadIdSet(index), word);
      assert.equal(ref, alias);
      // A list prints the id whole (wholeRef) and a table short (shortSessionId): the same alias.
      assert.equal(wholeRef(word), alias);
      assert.equal(shortSessionId(word), alias);
      assert.equal((await findSessionRef(index, ref))?.id, word);
      assert.equal((await resolveCall(index, `${ref}#1`)).id, `${word}-1`);
      assert.equal((await findSessionRef(index, word))?.id, NEWER, "the word itself still opens the newest session");
    });
  }

  test("the reference tree, blame and attribution print for it opens it too", async () => {
    const index = new MemoryIndexStore();
    const mine = [call("latest", "latest-1", 1000)];
    const newer = [call(NEWER, "newer-1", 2000)];
    await index.putEvents([...mine, ...newer]);
    await index.upsertSession(buildSession(mine));
    await index.upsertSession(buildSession(newer));
    const refs = await printedRefs(index, { short: ["latest"], whole: ["latest", NEWER] });
    assert.deepEqual([refs.short("latest"), refs.whole("latest"), refs.whole(NEWER)], ["x_brf2qjp3", "x_brf2qjp3", NEWER]);
    assert.equal((await findSessionRef(index, refs.short("latest")))?.id, "latest");
  });

  test("only the word itself prints an alias: its subagents, other ids and an alias print as before", () => {
    const sub = "latest:sub:a0123456789abcdef";
    for (const id of [sub, NEWER, "latest-run", "x_brf2qjp3"]) assert.equal(wholeRef(id), id);
    assert.equal(shortSessionId(sub), "latest:sub:a0123456");
    assert.equal(resolves(new IdSet(["latest", sub, NEWER]), shortSessionId(sub)), sub);
  });

  test("when a stored id starts with every length of its alias, the word prints the shortest anyway: an alias is read before a prefix", () => {
    const s = new IdSet(["latest", NEWER, "x_brf2qjp30parp9-sdk"]);
    assert.equal(shortestRef(s, "latest"), "x_brf2qjp3");
    assert.equal(resolves(s, "x_brf2qjp3"), "latest");
  });
});

describe("printedRefs: a list prints an id whole when it is short and plain, a column the shortest reference", () => {
  /** A store of `ids` that counts how often every stored id is read. */
  const idStore = (ids: readonly string[]) => {
    const store = {
      reads: 0,
      listSessions: async (): Promise<never> => assert.fail("read by prefix"),
      sessionIdsByPrefix: async (prefix: string, limit: number) => {
        if (prefix === "") store.reads++;
        return ids.filter((id) => id.startsWith(prefix)).slice(0, limit);
      },
    };
    return store;
  };
  const SUB_ID = child(1).split(":sub:")[1]!.slice(0, SHORT_ID_MIN);

  test("printsWhole: at most 40 characters a shell passes as typed, and not latest or last", () => {
    for (const id of [PARENT, "a".repeat(40), "parent-session-0001:sub:a1", "default/tenant-7/conv-123", "x_brf2qjp3"]) assert.equal(printsWhole(id), true, id);
    // A Claude Code subagent id is 58 characters.
    for (const id of ["a".repeat(41), child(1), LONG_A, "t3code-thread%3Aone", "my run", "-rf", "latest", "last"]) assert.equal(printsWhole(id), false, id);
  });

  test("ids that all print whole read nothing from the store and print as they are", async () => {
    const store = idStore([PARENT, "7c3e9d10-aaaa-4000-8000-000000000001", "7c3e9d10-bbbb-4000-8000-000000000002"]);
    const refs = await printedRefs(store, { whole: [PARENT, "7c3e9d10-aaaa-4000-8000-000000000001"] });
    assert.equal(store.reads, 0);
    assert.deepEqual([refs.whole(PARENT), refs.whole("7c3e9d10-aaaa-4000-8000-000000000001")], [PARENT, "7c3e9d10-aaaa-4000-8000-000000000001"]);
    assert.equal((await printedRefs(store, {})).whole(PARENT), PARENT);
    assert.equal(store.reads, 0);
  });

  test("one id in a list that does not print whole reads every stored id once; each id prints a reference that names it alone", async () => {
    const ids = [LONG_A, LONG_B, PARENT, child(1), "latest"];
    const store = idStore(ids);
    const refs = await printedRefs(store, { whole: ids });
    assert.equal(store.reads, 1);
    assert.deepEqual(ids.map((id) => refs.whole(id)), ["x_d52r41f3", "x_8n2twz83", PARENT, SUB_ID, "x_brf2qjp3"]);
    assert.deepEqual(ids.map((id) => refs.short(id)), ["x_d52r41f3", "x_8n2twz83", "36d2966a", SUB_ID, "x_brf2qjp3"]);
    const set = new IdSet(ids);
    for (const id of ids) assert.deepEqual([resolves(set, refs.whole(id)), resolves(set, refs.short(id))], [id, id]);
    assert.equal(store.reads, 1, "printing reads nothing more");
  });

  test("a column reads every stored id once, since an 8-character prefix may name two sessions", async () => {
    const a = "7c3e9d10-aaaa-4000-8000-000000000001";
    const b = "7c3e9d10-bbbb-4000-8000-000000000002";
    const store = idStore([a, b, PARENT]);
    const refs = await printedRefs(store, { short: [a, b, PARENT] });
    assert.equal(store.reads, 1);
    assert.deepEqual([a, b, PARENT].map((id) => refs.short(id)), ["7c3e9d10-a", "7c3e9d10-b", "36d2966a"]);
  });

  // A commit can name a session recorded on another machine, or one since removed: blame and
  // attribution print it in a column sized for 8 characters.
  test("an id the store lacks prints as shortSessionId, in a column and in a list", async () => {
    const gone = "7c3e9d10-aaaa-4000-8000-000000000001";
    const ids = [gone, child(1), LONG_A, "latest"];
    const store = idStore([PARENT]);
    const refs = await printedRefs(store, { short: ids, whole: ids });
    assert.equal(store.reads, 1);
    const want = ["7c3e9d10", `36d2966a:sub:${SUB_ID}`, "t3code-t", "x_brf2qjp3"];
    assert.deepEqual(ids.map((id) => refs.short(id)), want);
    assert.deepEqual(ids.map((id) => shortSessionId(id)), want);
    assert.deepEqual(ids.map((id) => refs.whole(id)), [gone, ...want.slice(1)]);
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
