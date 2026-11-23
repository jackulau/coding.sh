// `coding.sh status` says what the MCP status tool says about the same store: the version, the
// update the update checker's cache names (read only: no request to any host), each agent's last
// capture over the last 7 days, and the index's age in ms. The text output names the last capture
// per agent on one row, most recent first, and an available update with the command to run.
import assert from "node:assert/strict";
import dns from "node:dns";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { after, before, describe, test } from "node:test";
import * as status from "../../src/cli/commands/status.ts";
import { lastCaptureText } from "../../src/cli/commands/status.ts";
import { version } from "../../src/cli/meta.ts";
import { cliCommand, nextStepBin } from "../../src/cli/next-steps.ts";
import { recordLastIngest } from "../../src/core/ingest-health.ts";
import { loadIdSet, matchRef } from "../../src/core/session-ref.ts";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

type Obj = Record<string, unknown>;

const NOW = Date.now();
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const PARENT = "cc000001-aaaa-bbbb-cccc-000000000001";
const SUB = `${PARENT}:sub:agent-77aa11`;
const CODEX = "cx000002-aaaa-bbbb-cccc-000000000002";
const GEMINI = "gm000003-aaaa-bbbb-cccc-000000000003";
const CURSOR = "cu000004-aaaa-bbbb-cccc-000000000004";
const OPENCODE = "oc000005-aaaa-bbbb-cccc-000000000005";
const OLD = "cp000006-aaaa-bbbb-cccc-000000000006";

/** Five agents in the last 7 days, claude-code's latest activity in a subagent, and an agent last seen 8 days ago. */
const SESSIONS = [
  mkSession(PARENT, NOW - 40 * MIN, { endedAt: NOW - 20 * MIN, cwd: "/work/demo" }),
  mkSession(SUB, NOW - 30 * MIN, { endedAt: NOW - 2 * MIN, cwd: "/work/demo", parent: { sessionId: PARENT } }),
  mkSession(CODEX, NOW - 2 * HOUR, { agent: "codex", endedAt: NOW - HOUR, cwd: "/work/demo" }),
  mkSession(GEMINI, NOW - 4 * HOUR, { agent: "gemini-cli", endedAt: NOW - 3 * HOUR, cwd: "/work/demo" }),
  mkSession(CURSOR, NOW - 2 * DAY, { agent: "cursor", endedAt: NOW - 2 * DAY + 30 * MIN, cwd: "/work/demo" }),
  mkSession(OPENCODE, NOW - 5 * DAY, { agent: "opencode", endedAt: NOW - 5 * DAY + 10 * MIN, cwd: "/work/demo" }),
  mkSession(OLD, NOW - 8 * DAY, { agent: "copilot", endedAt: NOW - 8 * DAY + 10 * MIN, cwd: "/work/demo" }),
];

const CHECKED_AT = NOW - HOUR;
const UPDATE_CACHE = { latest: "99.0.0", checkedAt: CHECKED_AT, url: "https://example.invalid/releases/99.0.0", install: "coding.sh@99.0.0" };

/**
 * Runs `fn` with fetch and the http, https, net, tls and dns calls that reach another host replaced
 * by traps that record the call and throw, for named imports too (syncBuiltinESMExports).
 */
async function withoutNetwork<T>(fn: () => Promise<T>): Promise<{ value: T; calls: string[] }> {
  const calls: string[] = [];
  const saved: [object, string, unknown][] = [];
  const trap = (obj: object, key: string, name: string): void => {
    saved.push([obj, key, Reflect.get(obj, key)]);
    Reflect.set(obj, key, () => {
      calls.push(name);
      throw new Error(`no network in status: ${name}`);
    });
  };
  trap(globalThis, "fetch", "fetch");
  for (const [mod, name] of [[http, "http"], [https, "https"]] as const) {
    trap(mod, "request", `${name}.request`);
    trap(mod, "get", `${name}.get`);
  }
  trap(net, "connect", "net.connect");
  trap(net, "createConnection", "net.createConnection");
  trap(tls, "connect", "tls.connect");
  trap(dns, "lookup", "dns.lookup");
  trap(dns.promises, "lookup", "dns.promises.lookup");
  syncBuiltinESMExports();
  try {
    return { value: await fn(), calls };
  } finally {
    for (const [obj, key, value] of saved.reverse()) Reflect.set(obj, key, value);
    syncBuiltinESMExports();
  }
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The MCP status tool's answer on the sandbox's store, as JSON would carry it. */
async function mcpStatus(sb: Sandbox): Promise<Obj> {
  const mcp = createCodingShMcp({ env: sb.env, cwd: sb.root, log: () => {}, autoIngest: async () => ({ pendingFiles: 0, indexing: false }) });
  try {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } });
    const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent: Obj };
    assert.notEqual(res.isError, true, res.content[0]?.text);
    return JSON.parse(JSON.stringify(res.structuredContent)) as Obj;
  } finally {
    await mcp.close();
  }
}

describe("a store with five agents in the last 7 days, an update in the cache and a fresh index", () => {
  let sb: Sandbox;
  let home: string;
  before(async () => {
    sb = sandbox();
    home = sb.env.CODING_SH_HOME!;
    await sb.seed(SESSIONS);
    writeFileSync(join(home, "update.json"), JSON.stringify(UPDATE_CACHE));
    recordLastIngest(home, "0.0.0", NOW - MIN);
  });
  after(() => sb.cleanup());

  test("status --json gains version, update, lastCapture and index.ageMs, and reads the update from the cache with no request to any host", async () => {
    const cache = join(home, "update.json");
    const cached = { text: readFileSync(cache, "utf8"), mtime: statSync(cache).mtimeMs };
    const { value: r, calls } = await withoutNetwork(() => runCmd(status, sb, { json: true }));
    assert.equal(r.error, undefined, r.error?.stack);
    assert.deepEqual(calls, [], "status made a network call");
    assert.deepEqual({ text: readFileSync(cache, "utf8"), mtime: statSync(cache).mtimeMs }, cached, "status left update.json as it was");
    const j = r.json as Obj;

    assert.equal(j.version, version());
    assert.deepEqual(j.update, {
      current: version(),
      latest: "99.0.0",
      available: true,
      checkedAt: iso(CHECKED_AT),
      url: UPDATE_CACHE.url,
      install: "npm install -g coding.sh@99.0.0",
      command: `${nextStepBin(sb.env)} update`,
    });

    // Per agent over 7 days, sorted by agent: claude-code's latest activity is its subagent's; copilot's is 8 days old.
    const rows = j.lastCapture as { agent: string; at: string; sessionId: string; shortId: string }[];
    assert.deepEqual(
      rows.map(({ agent, at, sessionId }) => ({ agent, at, sessionId })),
      [
        { agent: "claude-code", at: iso(NOW - 2 * MIN), sessionId: SUB },
        { agent: "codex", at: iso(NOW - HOUR), sessionId: CODEX },
        { agent: "cursor", at: iso(NOW - 2 * DAY + 30 * MIN), sessionId: CURSOR },
        { agent: "gemini-cli", at: iso(NOW - 3 * HOUR), sessionId: GEMINI },
        { agent: "opencode", at: iso(NOW - 5 * DAY + 10 * MIN), sessionId: OPENCODE },
      ],
    );
    // Each short id names its session alone, as `show` and the MCP tools take it back.
    const index = await SqliteIndexStore.open(join(home, "index.db"));
    try {
      const ids = await loadIdSet(index);
      for (const row of rows) {
        assert.ok(row.shortId.length >= 8 && row.shortId.length < row.sessionId.length, row.shortId);
        assert.deepEqual(matchRef(ids, row.shortId), { id: row.sessionId }, row.shortId);
      }
    } finally {
      await index.close();
    }

    const age = j.index as { updatedAt: string; ageMs: number; stale?: true };
    assert.deepEqual(Object.keys(age).sort(), ["ageMs", "updatedAt"]);
    assert.equal(age.updatedAt, iso(NOW - MIN));
    assert.ok(age.ageMs >= MIN && age.ageMs < MIN + 60e3, String(age.ageMs));

    // Every field it had keeps its name and meaning: latest is still the top-level session that started last.
    for (const k of ["home", "store", "last24h", "work", "spool", "latest"]) assert.ok(k in j, k);
    assert.equal(j.home, home);
    assert.deepEqual(j.last24h, { sessions: 4, agents: ["claude-code", "codex", "gemini-cli"] });
    assert.equal((j.latest as { id: string }).id, PARENT);
  });

  test("the text output has a Last capture row, most recent first, and an Update row with the command to run", async () => {
    const r = await runCmd(status, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /^ +Last capture +claude-code 2m ago, codex 1h ago, gemini-cli 3h ago, \+2 more$/m);
    const update = `coding.sh 99.0.0 is available (running ${version()}); run ${cliCommand(sb.env, ["update"])}`;
    assert.match(r.stdout, new RegExp(`^! Update +${esc(update)}$`, "m"));
    const at = (label: string): number => r.stdout.search(new RegExp(`^..${esc(label)} `, "m"));
    assert.ok(at("Last 24h") < at("Last capture") && at("Last capture") < at("Spool"), r.stdout);
    assert.ok(at("Index") < at("Update") && at("Update") < at("Work"), r.stdout);
    // The line under the rows is still the session that started last.
    assert.match(r.stdout, new RegExp(`^${PARENT}  claude-code  40m ago`, "m"));
  });

  test("the CLI and the MCP status tool agree on version, update, lastCapture and index.ageMs", async () => {
    const cli = (await runCmd(status, sb, { json: true })).json as Obj;
    const mcp = await mcpStatus(sb);
    assert.equal(cli.version, mcp.version);
    assert.deepEqual(cli.update, mcp.update);
    assert.deepEqual(cli.lastCapture, mcp.lastCapture);
    const [a, b] = [cli.index as { updatedAt: string; ageMs: number }, mcp.index as { updatedAt: string; ageMs: number }];
    assert.equal(a.updatedAt, b.updatedAt);
    // Read a moment apart.
    assert.ok(Math.abs(a.ageMs - b.ageMs) < 10e3, `${a.ageMs} vs ${b.ageMs}`);
  });
});

describe("no update and no capture in the last 7 days", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession(OLD, NOW - 8 * DAY, { agent: "copilot", endedAt: NOW - 8 * DAY + 10 * MIN, cwd: "/work/demo" })]);
  });
  after(() => sb.cleanup());

  test("the row says none in 7 days, lastCapture is empty, and update says none is available", async () => {
    const r = await runCmd(status, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /^ +Last capture +None in the last 7 days$/m);
    assert.doesNotMatch(r.stdout, /Update/);
    const j = (await runCmd(status, sb, { json: true })).json as Obj;
    assert.deepEqual(j.lastCapture, []);
    assert.deepEqual(j.update, { current: version(), available: false });
    assert.equal(j.version, version());
  });

  test("a cache naming the running version is no update", async () => {
    writeFileSync(join(sb.env.CODING_SH_HOME!, "update.json"), JSON.stringify({ latest: version(), checkedAt: CHECKED_AT }));
    const j = (await runCmd(status, sb, { json: true })).json as Obj;
    assert.deepEqual(j.update, { current: version(), latest: version(), available: false, checkedAt: iso(CHECKED_AT) });
    assert.doesNotMatch((await runCmd(status, sb, {})).stdout, /Update/);
  });
});

test("an empty store has no Last capture row", async () => {
  const sb = sandbox();
  try {
    const r = await runCmd(status, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.doesNotMatch(r.stdout, /Last capture/);
    assert.deepEqual((await runCmd(status, sb, { json: true })).json.lastCapture, []);
  } finally {
    sb.cleanup();
  }
});

describe("lastCaptureText", () => {
  const row = (agent: string, at?: number) => ({ agent, at: at === undefined ? undefined : iso(at), sessionId: `${agent}-session`, shortId: `${agent}-s` });

  test("most recent first, on one line, past three agents ending with +N more", () => {
    const rows = [row("codex", NOW - 20 * HOUR), row("aider", NOW - 5 * MIN), row("claude-code", NOW - 30e3), row("cursor", NOW - 2 * HOUR), row("gemini-cli", NOW - 23 * HOUR)];
    assert.equal(lastCaptureText(rows, NOW), "claude-code 30s ago, aider 5m ago, cursor 2h ago, +2 more");
    assert.equal(lastCaptureText(rows.slice(0, 4), NOW), "claude-code 30s ago, aider 5m ago, cursor 2h ago, +1 more");
    assert.equal(lastCaptureText(rows.slice(0, 3), NOW), "claude-code 30s ago, aider 5m ago, codex 20h ago");
  });

  test("ties keep agent order, and a row with no time names the agent last", () => {
    assert.equal(lastCaptureText([row("codex", NOW - MIN), row("aider", NOW - MIN), row("pi")], NOW), "aider 1m ago, codex 1m ago, pi");
  });
});
