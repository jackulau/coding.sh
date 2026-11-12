// A run with 800 subagents read by an agent: MCP session_tree and `tree --json`
// come a page of nodes at a time, with a cursor, and the totals of the whole tree
// on every page. One reply used to carry all 801 nodes (679 KB over MCP, 1 MB
// from the CLI on a real store).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { pageTree, type TreeNode } from "../../src/core/tree.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { CHARACTER_LIMIT } from "../../src/mcp/tools.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { PKG, cleanup, makeWorld, type World } from "./helpers.ts";

const CLI = join(PKG, "src", "cli", "main.ts");
const ROOT = "big-root";
const CHILDREN = 800;
const child = (i: number) => `${ROOT}:sub:c${String(i).padStart(3, "0")}`;
/** The one grandchild, under the first subagent: second in tree order after its parent. */
const GRAND = `${child(0)}:sub:g1`;
const NODES = CHILDREN + 2;

let n = 0;
function trio(id: string, at: number, start: Record<string, unknown> = {}): AgentEvent[] {
  const ev = (ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => ({ id: `tree-${n++}`, v: 0, sessionId: id, agent: "claude-code", ts, kind, payload, cwd: "/work/demo", ...extra });
  return [
    ev(at, "session.start", start),
    ev(at + 100, "user.message", { text: `Review the change in module ${id.slice(-4)} and report what breaks` }),
    ev(at + 200, "llm.call", { ok: true }, { model: "claude-sonnet-5", durationMs: 900, usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.01 } }),
    ev(at + 5000, "session.end", {}),
  ];
}

interface Page {
  totals: { sessions: number };
  tree: PageNode[];
  nextCursor?: string;
  truncated?: boolean;
}
interface PageNode {
  sessionId?: string;
  id?: string;
  parentSessionId?: string | null;
  depth: number;
  children: PageNode[];
}
const flat = (nodes: PageNode[], out: PageNode[] = []): PageNode[] => {
  for (const x of nodes) {
    out.push(x);
    flat(x.children, out);
  }
  return out;
};

let w: World;
let mcp: CodingShMcp;
let outputSchema: Record<string, unknown>;

async function tree(args: Record<string, unknown>): Promise<{ page: Page; bytes: number; chars: number }> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_tree", arguments: args } });
  const res = r!.result as { structuredContent: Page; isError?: boolean; content: { text: string }[] };
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  const page = JSON.parse(JSON.stringify(res.structuredContent)) as Page;
  assert.deepEqual(schemaViolations(page, outputSchema), [], "session_tree output matches its outputSchema");
  // What the agent reads: the whole tool result, text and structured content.
  return { page, bytes: Buffer.byteLength(JSON.stringify(r!.result)), chars: res.content[0]!.text.length };
}

before(async () => {
  w = makeWorld();
  // In-process reads resolve agent homes through process.env: an empty HOME, never this machine's sessions.
  Object.assign(process.env, { HOME: w.env.HOME, USERPROFILE: w.env.HOME });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.T3CODE_HOME;
  delete process.env.CODEX_HOME;
  const t0 = w.now - 3600e3;
  const sessions: Session[] = [buildSession(trio(ROOT, t0))];
  for (let i = 0; i < CHILDREN; i++) sessions.push(buildSession(trio(child(i), t0 + 1000 + i * 10, { source: "subagent", parentSessionId: ROOT, subagentId: `c${i}`, subagentType: "reviewer" })));
  sessions.push(buildSession(trio(GRAND, t0 + 1500, { source: "subagent", parentSessionId: child(0), subagentId: "g1", subagentType: "searcher" })));
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    for (const s of sessions) await ctx.index.upsertSession(s);
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.root, log: () => {}, now: () => w.now });
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" });
  outputSchema = (r!.result as { tools: { name: string; outputSchema: Record<string, unknown> }[] }).tools.find((t) => t.name === "session_tree")!.outputSchema;
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("session_tree on a run with 800 subagents", () => {
  it("answers in one page under 64 KB, with the whole tree's totals and a cursor", async () => {
    const { page, bytes } = await tree({ sessionId: child(400) });
    assert.ok(bytes < 64_000, `the first page is ${bytes} bytes`);
    assert.equal(page.totals.sessions, NODES, "totals cover every node, not the page");
    assert.equal(flat(page.tree).length, 50, "50 nodes by default");
    assert.deepEqual({ next: page.nextCursor, truncated: page.truncated }, { next: "50", truncated: true });
    // The page keeps the tree's shape: the root, its first subagent with the grandchild under it.
    assert.equal(page.tree.length, 1);
    assert.equal(page.tree[0]!.sessionId, ROOT);
    assert.deepEqual(page.tree[0]!.children[0]!.children.map((x) => x.sessionId), [GRAND]);
    assert.equal(page.tree[0]!.parentSessionId, undefined);
  });

  it("the cursor walks every node once; a node whose parent was on an earlier page names it", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const { page, chars } = await tree(cursor ? { sessionId: ROOT, limit: 200, cursor } : { sessionId: ROOT, limit: 200 });
      calls++;
      assert.ok(chars <= CHARACTER_LIMIT, `page ${calls} is ${chars} characters`);
      assert.equal(page.totals.sessions, NODES);
      if (cursor) for (const top of page.tree) assert.deepEqual({ parent: top.parentSessionId, depth: top.depth }, { parent: ROOT, depth: 1 });
      seen.push(...flat(page.tree).map((x) => x.sessionId!));
      cursor = page.nextCursor;
      assert.equal(page.truncated, cursor ? true : undefined);
    } while (cursor && calls < 50);
    // 200 nodes are over the 25,000-character limit, so each page holds fewer.
    assert.ok(calls > 5, `802 nodes in ${calls} pages`);
    assert.equal(seen.length, NODES);
    assert.equal(new Set(seen).size, NODES, "no node twice");
    assert.deepEqual(seen.slice(0, 3), [ROOT, child(0), GRAND], "depth-first, as coding.sh tree prints it");
  });

  it("refuses a limit over 200 and a cursor it did not hand out", async () => {
    for (const args of [{ sessionId: ROOT, limit: 201 }, { sessionId: ROOT, cursor: "x" }]) {
      const r = await mcp.server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_tree", arguments: args } });
      assert.equal((r!.result as { isError?: boolean }).isError, true, JSON.stringify(args));
    }
  });
});

describe("tree --json on the same run", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...w.env, CODING_SH_NO_UPDATE_CHECK: "1" }, encoding: "utf8", maxBuffer: 1 << 26 });

  it("prints a page of 50 session digests under 64 KB; --limit and --cursor page the rest", () => {
    const first = cli("tree", ROOT, "--json");
    assert.equal(first.status, 0, first.stderr);
    assert.ok(Buffer.byteLength(first.stdout) < 64_000, `the first page is ${Buffer.byteLength(first.stdout)} bytes`);
    const page = JSON.parse(first.stdout) as Page;
    assert.equal(page.totals.sessions, NODES);
    assert.equal(flat(page.tree).length, 50);
    assert.deepEqual({ next: page.nextCursor, truncated: page.truncated }, { next: "50", truncated: true });
    assert.equal(page.tree[0]!.id, ROOT);

    const last = cli("tree", ROOT, "--json", "--limit", "500", "--cursor", "500");
    assert.equal(last.status, 0, last.stderr);
    const rest = JSON.parse(last.stdout) as Page;
    assert.equal(flat(rest.tree).length, NODES - 500);
    assert.deepEqual({ next: rest.nextCursor, truncated: rest.truncated }, { next: undefined, truncated: undefined });
    assert.ok(rest.tree.every((x) => x.parentSessionId === ROOT && x.depth === 1), "a later page's nodes say where they hang");

    const bad = cli("tree", ROOT, "--json", "--cursor", "x");
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stderr.trim().split("\n").at(-1)!).reason, "invalid_argument");
  });

  it("the text tree is whole", () => {
    const r = cli("tree", ROOT);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /801 subagents/);
    assert.equal(r.stdout.split("\n").filter((l) => l.includes(`${ROOT}:sub:c`)).length, CHILDREN + 1);
  });
});

// `show` reads the same tree: its count is the tree's, and what it lists starts at the first subagent.
// It used to read the newest 500 children and give that as the count.
describe("show on the same run", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...w.env, CODING_SH_NO_UPDATE_CHECK: "1" }, encoding: "utf8", maxBuffer: 1 << 26 });
  interface ShowNode {
    session: { id: string };
    subagents: ShowNode[];
  }
  const ids = (nodes: ShowNode[], out: string[] = []): string[] => {
    for (const x of nodes) {
      out.push(x.session.id);
      ids(x.subagents, out);
    }
    return out;
  };

  it("--json counts every subagent, lists the first 50 and names the command for the rest", () => {
    const r = cli("show", ROOT, "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout) < 64_000, `show --json is ${Buffer.byteLength(r.stdout)} bytes`);
    const doc = JSON.parse(r.stdout) as { subagentCount: number; subagents: ShowNode[]; subagentsTruncated?: boolean; subagentsRest?: string };
    const total = (JSON.parse(cli("tree", ROOT, "--json", "--limit", "1").stdout) as Page).totals.sessions;
    assert.equal(doc.subagentCount, total - 1, "the sessions tree counts, less the root");
    assert.equal(doc.subagentCount, NODES - 1);
    const listed = ids(doc.subagents);
    assert.equal(listed.length, 50);
    assert.deepEqual(listed.slice(0, 3), [child(0), GRAND, child(1)], "from the first subagent, in tree order");
    assert.deepEqual({ truncated: doc.subagentsTruncated, rest: doc.subagentsRest }, { truncated: true, rest: `coding.sh tree ${ROOT} --json` });
  });

  it("--json of a session whose subagents all fit says nothing about a rest", () => {
    const doc = JSON.parse(cli("show", child(0), "--json").stdout) as Record<string, unknown> & { subagents: ShowNode[] };
    assert.deepEqual({ count: doc.subagentCount, listed: ids(doc.subagents) }, { count: 1, listed: [GRAND] });
    assert.deepEqual(Object.keys(doc).filter((k) => k === "subagentsTruncated" || k === "subagentsRest"), []);
  });

  it("the text lists the first 500 and says where the rest are", () => {
    const r = cli("show", ROOT);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split("\n").filter((l) => l.includes(`└ ${ROOT}:sub:c`));
    assert.equal(lines.length, 500);
    assert.ok(lines[0]!.includes(`${child(0)} `) && lines[1]!.includes(GRAND), lines.slice(0, 2).join("\n"));
    assert.match(r.stderr, new RegExp(`first 500 of ${NODES - 1} subagents; coding\\.sh tree ${ROOT} lists them all`));
  });
});

describe("pageTree", () => {
  const node = (id: string, depth: number, children: TreeNode[] = []): TreeNode => ({ session: { id } as Session, depth, children });
  const ids = (nodes: TreeNode[]): unknown[] => nodes.map((x) => (x.children.length ? [x.session.id, ids(x.children)] : x.session.id));
  // a(b(c, d), e), f
  const roots = [node("a", 0, [node("b", 1, [node("c", 2), node("d", 2)]), node("e", 1)]), node("f", 0)];

  it("cuts in tree order and keeps a node under its parent when both are on the page", () => {
    assert.deepEqual(pageTree(roots, 0, 3), { roots: [node("a", 0, [node("b", 1, [node("c", 2)])])], next: 3 });
    const second = pageTree(roots, 3, 2);
    assert.deepEqual(ids(second.roots), ["d", "e"]);
    assert.equal(second.next, 5);
    assert.deepEqual(pageTree(roots, 5, 2), { roots: [node("f", 0)] });
    assert.deepEqual(pageTree(roots, 0, 6), { roots }, "a page that holds the tree has no cursor");
    assert.deepEqual(pageTree(roots, 9, 2), { roots: [] });
  });

  it("does not change the tree it pages", () => {
    pageTree(roots, 1, 2);
    assert.deepEqual(ids(roots), [["a", [["b", ["c", "d"]], "e"]], "f"]);
  });
});
