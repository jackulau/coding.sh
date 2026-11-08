// The coding.sh MCP server over real stdio: handshake in both protocol eras,
// every tool against a seeded store, resources, and JSON-RPC error paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { connectMcp, resetEraCache } from "../../src/toolevals/mcp/client.ts";
import { MAIN, RawClient, SEED, cleanup, makeWorld, seed, type World } from "./helpers.ts";

const CLI_MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const META = "io.modelcontextprotocol/";
const modernMeta = { [`${META}protocolVersion`]: "2026-07-28", [`${META}clientCapabilities`]: {}, [`${META}clientInfo`]: { name: "t", version: "0" } };

type Tool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; annotations: Record<string, unknown> };

let w: World;
let c: RawClient;
let tools: Tool[];

/** Calls a tool and checks the result shape every tool must have. */
async function call(name: string, args: Record<string, unknown> = {}, client = c): Promise<Record<string, unknown>> {
  const r = await client.call(name, args);
  assert.notEqual(r.isError, true, `${name} failed: ${r.content?.[0]?.text}`);
  const sc = r.structuredContent!;
  assert.ok(sc && typeof sc === "object", `${name} has structuredContent`);
  assert.equal(r.content[0]!.type, "text");
  assert.deepEqual(JSON.parse(r.content[0]!.text), sc, `${name} text mirrors structuredContent`);
  const tool = tools.find((t) => t.name === name)!;
  assert.deepEqual(schemaViolations(sc, tool.outputSchema), [], `${name} output matches its outputSchema`);
  return sc;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await c.call(name, args);
  assert.equal(r.isError, true, `${name} should fail with ${JSON.stringify(args)}`);
  return r.content[0]!.text;
}

const ids = (sc: Record<string, unknown>) => (sc.sessions as { id: string }[]).map((s) => s.id);

before(async () => {
  w = makeWorld();
  await seed(w);
  c = new RawClient(w.env, w.repo);
});

after(async () => {
  await c?.close();
  cleanup();
});

describe("handshake (legacy era)", () => {
  it("negotiates a supported version and falls back to the newest legacy one", async () => {
    const r = await c.initialize("2025-06-18");
    assert.equal(r.result!.protocolVersion, "2025-06-18");
    assert.deepEqual(r.result!.serverInfo, { name: "coding.sh", title: "coding.sh", version: (r.result!.serverInfo as { version: string }).version });
    assert.ok((r.result!.capabilities as Record<string, unknown>).tools);
    assert.ok((r.result!.capabilities as Record<string, unknown>).resources);
    assert.match(String(r.result!.instructions), /session_current/);
    const other = await c.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "0" } });
    assert.equal(other.result!.protocolVersion, "2025-11-25");
    await c.initialize("2025-06-18");
    assert.deepEqual((await c.request("ping")).result, {});
  });

  it("lists every tool with a tight description, schemas and annotations", async () => {
    const r = await c.request("tools/list");
    tools = r.result!.tools as Tool[];
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "benchmarks",
      "eval_from_session",
      "eval_init",
      "exp_session_note",
      "exp_session_summary",
      "experiment_compare",
      "experiments_list",
      "failures",
      "harness_compare",
      "latency",
      "search",
      "session_current",
      "session_get",
      "session_replay",
      "sessions_list",
      "status",
      "subagents",
      "usage",
    ]);
    for (const t of tools) {
      assert.ok(t.title, `${t.name} title`);
      assert.ok(t.description.length >= 60 && t.description.length <= 300, `${t.name} description is ${t.description.length} chars`);
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} rejects unknown args`);
      for (const [k, p] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) assert.ok(p.description, `${t.name}.${k} has a description`);
      assert.equal(t.outputSchema.type, "object", `${t.name} outputSchema`);
      assert.equal(t.annotations.readOnlyHint, !["eval_from_session", "eval_init", "exp_session_note"].includes(t.name), `${t.name} readOnlyHint`);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.openWorldHint, false);
    }
    const ev = tools.find((t) => t.name === "eval_from_session")!;
    assert.equal(ev.annotations.idempotentHint, true);
    assert.deepEqual(ev.inputSchema.required, ["sessionId", "confirm"]);
  });
});

describe("tools", () => {
  it("sessions_list filters by agent, repo, window, flags and pages with a cursor", async () => {
    assert.deepEqual(ids(await call("sessions_list")), [SEED.d, SEED.a, SEED.b]);
    assert.deepEqual(ids(await call("sessions_list", { includeSubagents: true })), [SEED.d, SEED.c, SEED.a, SEED.b]);
    assert.deepEqual(ids(await call("sessions_list", { agent: "codex" })), [SEED.b]);
    assert.deepEqual(ids(await call("sessions_list", { repo: w.repo })), [SEED.d, SEED.a]);
    assert.deepEqual(ids(await call("sessions_list", { repo: "parser" })), [SEED.d, SEED.a]);
    assert.deepEqual(ids(await call("sessions_list", { since: "24h" })), [SEED.d, SEED.a]);
    assert.deepEqual(ids(await call("sessions_list", { flagged: true })), [SEED.a]);
    assert.deepEqual(ids(await call("sessions_list", { flag: "repeated-tool-failure" })), [SEED.a]);
    const p1 = await call("sessions_list", { limit: 1 });
    assert.deepEqual(ids(p1), [SEED.d]);
    assert.equal(p1.nextCursor, "1");
    const p2 = await call("sessions_list", { limit: 1, cursor: p1.nextCursor });
    assert.deepEqual(ids(p2), [SEED.a]);
    const a = (p2.sessions as Record<string, unknown>[])[0]!;
    assert.equal(a.toolErrors, 3);
    assert.equal(a.turns, 2);
    assert.equal(a.costUsd, 0.03);
    assert.match(await callError("sessions_list", { since: "last tuesday" }), /Invalid since/);
    assert.match(await callError("sessions_list", { cursor: "abc" }), /Invalid cursor/);
  });

  it("session_get returns a digest, one turn on request, and fails clearly on bad ids", async () => {
    const d = await call("session_get", { sessionId: SEED.a });
    assert.equal(d.turnCount, 2);
    assert.equal((d.session as { id: string }).id, SEED.a);
    const lines = (d.timeline as { kind: string; text: string }[]).map((e) => `${e.kind} ${e.text}`);
    assert.ok(lines.some((l) => /^tool Bash npm test → FAILED 4\.0s: Error: expected 3/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /^subagent start Explore Find every caller/.test(l)));
    assert.deepEqual(d.subagents, { childSessions: 1, spawned: 1 });
    const t2 = await call("session_get", { sessionId: SEED.a, turn: -1 });
    assert.equal(t2.turn, 2);
    assert.match((t2.timeline as { text: string }[])[0]!.text, /No, that's wrong/);
    const paged = await call("session_get", { sessionId: SEED.a, limit: 3 });
    assert.equal((paged.timeline as unknown[]).length, 3);
    assert.equal(paged.nextCursor, "3");
    assert.equal((await call("session_get", { sessionId: "latest" }) as { session: { id: string } }).session.id, SEED.d);
    assert.match(await callError("session_get", { sessionId: SEED.a, turn: 5 }), /has 2 turn/);
    assert.match(await callError("session_get", { sessionId: "nope" }), /No session with id "nope"/);
    assert.match(await callError("session_get", {}), /sessionId/);
  });

  it("session_replay lists steps, opens one with the touched files, and diffs a range", async () => {
    const idx = await call("session_replay", { sessionId: SEED.a });
    const steps = idx.steps as { n: number; kind: string; label: string }[];
    assert.equal(idx.total, steps.length);
    assert.deepEqual(idx.files, ["src/parse.ts"]);
    const edit = steps.find((s) => s.kind === "edit")!;
    assert.equal(edit.label, "Edit src/parse.ts");
    const at = await call("session_replay", { sessionId: SEED.a, step: edit.n, file: "src/parse.ts" });
    assert.deepEqual((at.tree as { path: string }[]).map((t) => t.path), ["src/parse.ts"]);
    const file = at.file as { content?: string; why?: string };
    assert.equal(file.content, undefined, "an edit with no recorded text leaves the content unknown");
    assert.match(file.why!, /^Step \d+ edited it/);
    const shell = await call("session_replay", { sessionId: SEED.a, step: steps.find((s) => s.kind === "shell")!.n });
    assert.equal((shell.detail as { shell: { command: string; ok: boolean } }).shell.command, "npm test");
    const range = await call("session_replay", { sessionId: SEED.a, from: 1, to: steps.length });
    assert.deepEqual((range.files as { path: string }[]).map((f) => f.path), ["src/parse.ts"]);
    const page = await call("session_replay", { sessionId: SEED.a, limit: 2 });
    assert.equal((page.steps as unknown[]).length, 2);
    assert.equal(page.nextCursor, "2");
    assert.match(await callError("session_replay", { sessionId: SEED.a, step: 999 }), /step must be a step number from 1 to/);
    assert.match(await callError("session_replay", { sessionId: SEED.a, from: 1 }), /both from and to/);
    assert.match(await callError("session_replay", { sessionId: SEED.a, file: "src/parse.ts" }), /file needs a step/);
  });

  it("session_current finds the running session in the server's directory, or the env-named one", async () => {
    const cur = await call("session_current");
    assert.equal(cur.matchedBy, "cwd-running");
    assert.equal((cur.session as { id: string }).id, SEED.d);
    const other = await call("session_current", { cwd: join(w.root, "repos", "docs") });
    assert.equal(other.matchedBy, "cwd-recent");
    assert.equal((other.session as { id: string }).id, SEED.b);
    assert.match(await callError("session_current", { cwd: join(w.root, "elsewhere") }), /No captured session ran in/);

    const e = new RawClient({ ...w.env, CODING_SH_SESSION_ID: SEED.b }, w.root);
    try {
      await e.initialize();
      const r = await call("session_current", {}, e);
      assert.equal(r.matchedBy, "env");
      assert.equal((r.session as { id: string }).id, SEED.b);
    } finally {
      await e.close();
    }
  });

  it("search finds prompts across sessions", async () => {
    const r = await call("search", { query: "parser" });
    const hits = r.hits as { sessionId: string; kind: string; sessionTitle?: string }[];
    assert.ok(hits.some((h) => h.sessionId === SEED.a && h.kind === "user.message"));
    assert.equal(hits.find((h) => h.sessionId === SEED.a)!.sessionTitle, "Fix the failing parser tests in src/parse.ts");
    assert.deepEqual((await call("search", { query: "parser", agent: "codex" })).hits, []);
  });

  it("failures reports flagged sessions, top tool errors and pushback", async () => {
    const r = await call("failures");
    const top = (r.topToolErrors as { tool: string; errors: number; sessions: number; sample: string; sampleInput: string }[])[0]!;
    assert.deepEqual({ tool: top.tool, errors: top.errors, sessions: top.sessions, sampleInput: top.sampleInput }, { tool: "Bash", errors: 3, sessions: 1, sampleInput: "npm test" });
    assert.match(top.sample, /expected 3 to equal 4/);
    assert.ok((r.flaggedSessions as { id: string }[]).some((s) => s.id === SEED.a));
    assert.equal((r.flagCounts as Record<string, number>)["repeated-tool-failure"], 1);
    const pb = r.pushback as { sessionId: string; text: string }[];
    assert.equal(pb.length, 1);
    assert.equal(pb[0]!.sessionId, SEED.a);
    assert.equal((await call("failures", { agent: "codex" }) as { topToolErrors: unknown[] }).topToolErrors.length, 0);
  });

  it("latency computes nearest-rank p50/p95, per model, and the slowest tools", async () => {
    const r = await call("latency");
    assert.deepEqual(r.llm, { calls: 4, p50Ms: 900, p95Ms: 2500, maxMs: 2500, ttftP50Ms: 300, ttftP95Ms: 600 });
    const opus = (r.byModel as { model: string; calls: number }[]).find((m) => m.model === "claude-opus-4-5")!;
    assert.equal(opus.calls, 2);
    const slow = (r.slowestTools as { tool: string; calls: number; p95Ms: number }[])[0]!;
    assert.deepEqual({ tool: slow.tool, calls: slow.calls, p95Ms: slow.p95Ms }, { tool: "Bash", calls: 3, p95Ms: 4200 });
    assert.equal((r.slowestCalls as { sessionId: string }[])[0]!.sessionId, SEED.a);
    assert.equal(((await call("latency", { model: "gpt" })) as { llm: { calls: number } }).llm.calls, 1);
  });

  it("usage groups tokens and cost by agent, day and model", async () => {
    const byAgent = await call("usage", { groupBy: "agent" });
    const g = Object.fromEntries((byAgent.groups as { key: string; costUsd: number; sessions: number }[]).map((x) => [x.key, x]));
    assert.equal(g["claude-code"]!.costUsd, 0.031);
    assert.equal(g["claude-code"]!.sessions, 3);
    assert.equal(g.codex!.costUsd, 0.005);
    assert.equal((byAgent.total as { costUsd: number; outputTokens: number }).costUsd, 0.036);
    assert.equal((byAgent.total as { outputTokens: number }).outputTokens, 650);
    const byDay = await call("usage");
    assert.equal(byDay.groupBy, "day");
    assert.ok((byDay.groups as unknown[]).length >= 1);
    const byModel = await call("usage", { groupBy: "model", since: "24h" });
    assert.deepEqual((byModel.groups as { key: string }[]).map((x) => x.key).sort(), ["claude-haiku-4-5", "claude-opus-4-5"]);
    assert.match(await callError("usage", { groupBy: "week" }), /groupBy/);
  });

  it("subagents returns child sessions and in-session subagents", async () => {
    const r = await call("subagents", { sessionId: SEED.a });
    assert.equal(r.count, 2);
    const nodes = r.subagents as { sessionId?: string; type?: string; description?: string; durationMs?: number }[];
    assert.ok(nodes.some((n) => n.sessionId === SEED.c && n.type === "general-purpose"));
    assert.ok(nodes.some((n) => n.type === "Explore" && n.durationMs === 5000));
    assert.equal(((await call("subagents", { sessionId: SEED.b })) as { count: number }).count, 0);
  });

  it("eval_from_session refuses without confirm, then creates once (idempotent)", async () => {
    assert.match(await callError("eval_from_session", { sessionId: SEED.a, confirm: false }), /confirm: true/);
    assert.match(await callError("eval_from_session", { sessionId: SEED.a }), /confirm/);
    const args = { sessionId: SEED.a, confirm: true, verifier: "node test.mjs", setup: ["true"], tags: ["mcp"] };
    const r = await call("eval_from_session", args);
    assert.equal(r.created, true);
    const task = r.task as { id: string; repo: string; verifier: string; sourceSessionId: string; tags: string[] };
    assert.equal(task.repo, w.repo);
    assert.equal(task.verifier, "node test.mjs");
    assert.equal(task.sourceSessionId, SEED.a);
    assert.ok(task.tags.includes("mcp"));
    assert.equal(r.next, `coding.sh eval validate ${task.id}`);
    const again = await call("eval_from_session", args);
    assert.equal(again.created, false);
    assert.equal((again.task as { id: string }).id, task.id);
    assert.match(await callError("eval_from_session", { sessionId: SEED.b, confirm: true, verifier: "true", setup: ["true"] }), /no repo state/);
  });

  it("eval_init refuses without confirm, then writes a suite the agent drafted", async () => {
    assert.match(await callError("eval_init", { name: "triage", source: "cases", confirm: false }), /confirm: true/);
    const args = {
      name: "triage",
      source: "cases",
      confirm: true,
      command: "node triage.mjs",
      cases: [
        { input: "I was charged twice", expected: "billing" },
        { input: "Tell me a joke", expected: "other", should: false },
      ],
    };
    const r = await call("eval_init", args);
    assert.deepEqual([r.name, r.dir, r.kind, r.purpose, r.drafted, r.run], ["triage", join("evals", "triage"), "cases", "regression", true, "coding.sh eval run triage"]);
    assert.deepEqual(r.files, ["evals/triage/suite.json", "evals/triage/cases.jsonl"]);
    assert.ok((r.notes as string[]).some((n) => /the agent wrote 2 cases/.test(n)));
    const lines = readFileSync(join(w.repo, "evals", "triage", "cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { metadata?: { draft?: boolean }; tags?: string[] });
    assert.deepEqual(lines.map((l) => [l.metadata?.draft, l.tags]), [[true, undefined], [true, ["should-not"]]]);
    assert.match(await callError("eval_init", args), /already exists/);
    assert.match(await callError("eval_init", { name: "x", source: "skill", confirm: true }), /skill dir/);
  });

  it("experiments_list and experiment_compare read eval results", async () => {
    const l = await call("experiments_list");
    assert.deepEqual((l.experiments as { id: string }[]).map((e) => e.id), [SEED.expB, SEED.expA]);
    assert.equal((l.experiments as { passRate: number }[])[1]!.passRate, 0.75);
    const cmp = await call("experiment_compare", { baseline: SEED.expA, candidate: SEED.expB });
    assert.equal(cmp.paired, 4);
    assert.deepEqual((cmp.regressions as { caseId: string }[]).map((x) => x.caseId).sort(), ["c1", "c3"]);
    assert.equal((cmp.mcnemar as { regressions: number }).regressions, 2);
    assert.ok(["better", "worse", "inconclusive"].includes(cmp.verdict as string));
    assert.ok((cmp.warnings as string[]).length > 0, "4 paired cases trigger a small-n warning");
    const gate = cmp.gate as { verdict: string; decision: string; summary: string; losses: number; lostCases: string[] };
    assert.equal(gate.decision, "abstain");
    assert.equal(gate.verdict, "dont-ship");
    assert.equal(gate.losses, 2);
    assert.deepEqual([...gate.lostCases].sort(), ["c1", "c3"]);
    assert.match(gate.summary, /^Don't ship: B breaks 2 cases A solved/);
    assert.match(await callError("experiment_compare", { baseline: SEED.expA, candidate: "exp-missing" }), /No experiment with id "exp-missing"/);
  });

  it("exp_session_note and exp_session_summary keep the experiment session the CLI reads", async () => {
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--no-warnings", CLI_MAIN, ...args], { env: w.env, cwd: w.repo, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    // No session in the server's folder: a structured not_found pointing at the CLI.
    const none = await c.call("exp_session_summary", {});
    assert.equal(none.isError, true);
    assert.deepEqual((none.structuredContent as { error: { reason: string; next: string } }).error.reason, "not_found");
    assert.equal((none.structuredContent as { error: { next: string } }).error.next, "coding.sh exp session new --name <topic>");
    assert.match(none.content[0]!.text, /coding\.sh exp session new --name <topic>/);
    assert.match(await callError("exp_session_note", { text: "x" }), /No experiment session/);

    const made = JSON.parse(cli("exp", "session", "new", "--name", "mcp", "--json")) as { session: { id: string } };
    const key = `sk-${"ant"}-${"a".repeat(32)}`;
    const noted = await call("exp_session_note", { text: `hypothesis: a shorter prompt fixes c3 (key ${key})` });
    assert.deepEqual(noted.session, { id: made.session.id, name: "mcp" });
    const text = (noted.block as { text: string }).text;
    assert.ok(!text.includes(key) && text.includes("[redacted:anthropic-key]"), text);
    cli("exp", "session", "note", "reading: c3 passes now");
    await call("exp_session_note", { text: "next: try it on the dev split", session: made.session.id });
    // Empty and over-limit notes are refused.
    assert.equal((await c.call("exp_session_note", { text: "" })).isError, true);
    assert.equal((await c.call("exp_session_note", { text: "x".repeat(4001) })).isError, true);
    assert.match(await callError("exp_session_note", { text: "x", session: "../etc" }), /invalid session id/);

    // The MCP note shows up in the CLI summary, and MCP output equals the CLI JSON.
    assert.match(cli("exp", "session", "summary"), /note {2}hypothesis: a shorter prompt fixes c3 \(key \[redacted:anthropic-key\]\)/);
    const fromCli = JSON.parse(cli("exp", "session", "summary", "--json")) as { session: unknown; blocks: unknown[] };
    const all = await call("exp_session_summary", {});
    assert.deepEqual({ session: all.session, blocks: all.blocks }, fromCli);
    assert.equal(all.total, 3);
    assert.equal(all.nextCursor, undefined);
    // Pagination, oldest first.
    const p1 = await call("exp_session_summary", { limit: 2 });
    assert.deepEqual(p1.blocks, fromCli.blocks.slice(0, 2));
    assert.equal(p1.nextCursor, "2");
    const p2 = await call("exp_session_summary", { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.blocks, fromCli.blocks.slice(2));
    assert.equal(p2.nextCursor, undefined);
  });

  it("harness_compare lists no harness A/B runs in a store without any", async () => {
    assert.deepEqual(await call("harness_compare"), { experiments: [] });
    assert.match(await callError("harness_compare", { experiment: "exp_none" }), /No harness A\/B experiment "exp_none"/);
  });

  it("status reports capture health and update availability", async () => {
    const s = await call("status");
    assert.equal(s.home, w.env.CODING_SH_HOME);
    assert.deepEqual(s.last24h, { sessions: 3, agents: ["claude-code"] });
    assert.equal((s.update as { available: boolean }).available, false);
    assert.deepEqual((s.lastCapture as { agent: string }[]).map((x) => x.agent), ["claude-code", "codex"]);
    assert.equal((s.latest as { id: string }).id, SEED.d);

    writeFileSync(join(w.env.CODING_SH_HOME!, "update.json"), JSON.stringify({ latest: "99.0.0", checkedAt: Date.now(), url: "https://example.com/r", install: "coding.sh@99.0.0" }));
    const u = await call("status");
    assert.deepEqual({ ...(u.update as object), checkedAt: undefined }, { current: (u.update as { current: string }).current, latest: "99.0.0", available: true, checkedAt: undefined, url: "https://example.com/r", install: "npm install -g coding.sh@99.0.0" });
    assert.match((u.hints as string[]).join("\n"), /99\.0\.0 is available/);
    const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } });
    assert.match(String(init.result!.instructions), /Update available: coding\.sh 99\.0\.0/);
  });
});

describe("resources", () => {
  it("lists latest + recent sessions, reads markdown digests, 404s unknown uris", async () => {
    const l = await c.request("resources/list");
    const uris = (l.result!.resources as { uri: string }[]).map((r) => r.uri);
    assert.equal(uris[0], "codingsh://latest");
    assert.ok(uris.includes(`codingsh://session/${SEED.a}`));
    const t = await c.request("resources/templates/list");
    assert.equal((t.result!.resourceTemplates as { uriTemplate: string }[])[0]!.uriTemplate, "codingsh://session/{id}");

    const latest = await c.request("resources/read", { uri: "codingsh://latest" });
    const lc = (latest.result!.contents as { uri: string; mimeType: string; text: string }[])[0]!;
    assert.equal(lc.mimeType, "text/markdown");
    assert.match(lc.text, /^# Refactor the tokenizer for speed/);

    const a = await c.request("resources/read", { uri: `codingsh://session/${SEED.a}` });
    const text = (a.result!.contents as { text: string }[])[0]!.text;
    assert.match(text, /## Timeline/);
    assert.match(text, /\*\*tool\*\* Bash npm test → FAILED/);
    assert.match(text, /## Subagents \(2\)/);

    const miss = await c.request("resources/read", { uri: "codingsh://session/nope" });
    assert.equal(miss.error!.code, -32002);
    const bad = await c.request("resources/read", {});
    assert.equal(bad.error!.code, -32602);
  });
});

describe("JSON-RPC errors", () => {
  it("answers malformed input with the right codes", async () => {
    const parse = await c.sendRaw("{not json", null)!;
    assert.equal(parse.error!.code, -32700);
    assert.equal(parse.id, null);
    const batch = await c.sendRaw(JSON.stringify([{ jsonrpc: "2.0", id: 99, method: "ping" }]), null)!;
    assert.equal(batch.error!.code, -32600);
    const noVersion = await c.sendRaw(JSON.stringify({ id: "v", method: "ping" }), "v")!;
    assert.equal(noVersion.error!.code, -32600);
    assert.equal((await c.request("no/such/method")).error!.code, -32601);
    const unknown = await c.request("tools/call", { name: "drop_tables", arguments: {} });
    assert.equal(unknown.error!.code, -32602);
    assert.match(unknown.error!.message, /Unknown tool: drop_tables/);
    const badParams = await c.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: "p", method: "tools/list", params: [1] }), "p")!;
    assert.equal(badParams.error!.code, -32602);
    assert.match(await callError("sessions_list", { limit: 0 }), /limit.*>= 1/);
    assert.match(await callError("sessions_list", { bogus: 1 }), /bogus/);
    // Notifications never get a reply, even unknown ones.
    c.notify("notifications/whatever");
    assert.deepEqual((await c.request("ping")).result, {});
  });

  it("stdout carried only JSON-RPC frames", () => {
    assert.ok(c.lines.length > 20);
    for (const line of c.lines) {
      const m = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(m.jsonrpc, "2.0", line.slice(0, 200));
    }
  });
});

describe("modern era (2026-07-28)", () => {
  it("serves server/discover and stateless requests; rejects bad versions and missing capabilities", async () => {
    const m = new RawClient(w.env, w.repo);
    try {
      const d = await m.request("server/discover", { _meta: modernMeta });
      assert.equal(d.result!.resultType, "complete");
      assert.deepEqual(d.result!.supportedVersions, ["2026-07-28"]);
      assert.equal((d.result!._meta as Record<string, { name: string }>)[`${META}serverInfo`]!.name, "coding.sh");
      // No handshake needed.
      const l = await m.request("tools/call", { name: "sessions_list", arguments: { limit: 1 }, _meta: modernMeta });
      assert.equal(l.result!.resultType, "complete");
      assert.equal(((l.result!.structuredContent as { sessions: { id: string }[] }).sessions[0]!).id, SEED.d);
      const v = await m.request("tools/list", { _meta: { ...modernMeta, [`${META}protocolVersion`]: "1900-01-01" } });
      assert.equal(v.error!.code, -32022);
      assert.deepEqual(v.error!.data, { supported: ["2026-07-28"], requested: "1900-01-01" });
      const caps = await m.request("tools/list", { _meta: { [`${META}protocolVersion`]: "2026-07-28" } });
      assert.equal(caps.error!.code, -32602);
      const miss = await m.request("resources/read", { uri: "codingsh://session/nope", _meta: modernMeta });
      assert.equal(miss.error!.code, -32602);
    } finally {
      await m.close();
    }
  });

  it("works with coding.sh's own dual-era client (detects modern, pages tools, calls)", async () => {
    resetEraCache();
    const client = await connectMcp({ stdio: [process.execPath, "--no-warnings", MAIN], env: w.env, cwd: w.repo, graceMs: 500 });
    try {
      assert.equal(client.era, "2026-07-28");
      assert.equal(client.serverInfo?.name, "coding.sh");
      assert.equal((await client.listTools()).length, 18);
      const r = await client.callTool("session_get", { sessionId: SEED.b });
      assert.equal((r.structuredContent as { session: { agent: string } }).session.agent, "codex");
    } finally {
      await client.close();
    }
  });
});

describe("freshness", () => {
  it("ingests newly spooled hook events before answering", async () => {
    const f = makeWorld();
    // In process, the store-based imports (T3's store, unhooked Codex transcripts) read process.env: point them at the world's HOME too.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, T3CODE_HOME: process.env.T3CODE_HOME, CODEX_HOME: process.env.CODEX_HOME };
    Object.assign(process.env, { HOME: f.env.HOME, USERPROFILE: f.env.HOME });
    delete process.env.T3CODE_HOME;
    delete process.env.CODEX_HOME;
    const { createCodingShMcp } = await import("../../src/mcp/server.ts");
    const mcp = createCodingShMcp({ env: f.env, cwd: f.root, ingestIntervalMs: 0, log: () => {} });
    const callIt = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (r!.result as { structuredContent: Record<string, unknown> }).structuredContent;
    };
    try {
      assert.deepEqual((await callIt("sessions_list")).sessions, []);
      const dir = join(f.env.CODING_SH_HOME!, "spool", "claude-code");
      mkdirSync(dir, { recursive: true });
      const sid = "11111111-2222-4333-8444-555555555555";
      const line = (event: string, raw: Record<string, unknown>, ts: number) => JSON.stringify({ v: 0, agent: "claude-code", event, ts, pid: 4242, ppid: 1, cwd: f.root, raw: { session_id: sid, cwd: f.root, hook_event_name: event, ...raw } });
      const t = Date.now();
      writeFileSync(join(dir, `${new Date(t).toISOString().slice(0, 10)}.4242.jsonl`), [line("SessionStart", { source: "startup" }, t), line("UserPromptSubmit", { prompt: "Speed up the build" }, t + 10)].join("\n") + "\n");
      const s = (await callIt("sessions_list")).sessions as { id: string; title: string }[];
      assert.equal(s.length, 1);
      assert.equal(s[0]!.title, "Speed up the build");
    } finally {
      await mcp.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("answers within its ingest budget from what is indexed, with pending: { files, indexing }, until the backlog is gone", async () => {
    const f = makeWorld();
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, T3CODE_HOME: process.env.T3CODE_HOME, CODEX_HOME: process.env.CODEX_HOME };
    Object.assign(process.env, { HOME: f.env.HOME, USERPROFILE: f.env.HOME });
    delete process.env.T3CODE_HOME;
    delete process.env.CODEX_HOME;
    const dir = join(f.env.CODING_SH_HOME!, "spool", "claude-code");
    mkdirSync(dir, { recursive: true });
    const t = Date.now();
    for (let i = 0; i < 4; i++) {
      const sid = `11111111-2222-4333-8444-00000000000${i}`;
      const line = (event: string, raw: Record<string, unknown>, ts: number) => JSON.stringify({ v: 0, agent: "claude-code", event, ts, pid: 5000 + i, ppid: 1, cwd: f.root, raw: { session_id: sid, cwd: f.root, hook_event_name: event, ...raw } });
      writeFileSync(join(dir, `${new Date(t).toISOString().slice(0, 10)}.${5000 + i}.jsonl`), [line("SessionStart", { source: "startup" }, t + i), line("UserPromptSubmit", { prompt: `task ${i}` }, t + i + 1)].join("\n") + "\n");
    }
    const { createCodingShMcp } = await import("../../src/mcp/server.ts");
    // A 0 ms budget: each call ingests one file (every run makes progress), then answers.
    const mcp = createCodingShMcp({ env: { ...f.env, CODING_SH_NO_AUTO_INGEST: "1" }, cwd: f.root, ingestIntervalMs: 0, ingestBudgetMs: 0, log: () => {} });
    const callIt = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (r!.result as { structuredContent: Record<string, unknown> }).structuredContent;
    };
    try {
      const first = await callIt("sessions_list");
      assert.equal((first.sessions as unknown[]).length, 1);
      assert.deepEqual(first.pending, { files: 3, indexing: false });
      let last = first;
      for (let i = 0; i < 5 && last.pending; i++) last = await callIt("sessions_list");
      assert.equal((last.sessions as unknown[]).length, 4);
      assert.equal("pending" in last, false, "no pending field once everything is indexed");
    } finally {
      await mcp.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
