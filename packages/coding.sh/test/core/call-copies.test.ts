// A model call logged twice, by the agent's hooks and by `coding.sh proxy`, is one
// line in `show`, the MCP timeline and the viewer. The fixtures are real captures:
// scripts/e2e/proxy-capture.mjs (Claude Code 2.1.319 and Codex 0.167.0 through
// `init --proxy` against the stub model), the sessions' events from `show --json --all`,
// with paths scrubbed to /work/demo and /home/user.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { callCopies, mergeCallCopies } from "../../src/core/call-copies.ts";
import { loadConfig } from "../../src/core/config.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { timeline } from "../../src/mcp/data.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openStores } from "../../src/store/factory.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const fixture = (agent: "claude-code" | "codex"): AgentEvent[] =>
  readFileSync(fileURLToPath(new URL(`../fixtures/proxy/${agent}-proxied.jsonl`, import.meta.url)), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AgentEvent);
const CLAUDE = fixture("claude-code");
const CODEX = fixture("codex");
const calls = (evs: AgentEvent[]) => evs.filter((e) => e.kind === "llm.call");

describe("call copies on real proxied captures", () => {
  for (const [agent, events, idKey] of [["claude-code", CLAUDE, "messageId"], ["codex", CODEX, "responseId"]] as const) {
    it(`${agent}: each call once, the proxy's copy with the hook copy's fields`, () => {
      const raw = calls(events);
      assert.equal(raw.length, 4, "the capture has both copies of 2 calls");
      const merged = calls(mergeCallCopies(events));
      assert.deepEqual(merged.map((e) => e.source), ["proxy", "proxy"]);
      assert.deepEqual(merged.map((e) => e.payload[idKey]), [...new Set(raw.map((e) => e.payload[idKey]))]);
      for (const m of merged) {
        const hook = raw.find((e) => e.source !== "proxy" && e.payload[idKey] === m.payload[idKey])!;
        const proxy = raw.find((e) => e.source === "proxy" && e.payload[idKey] === m.payload[idKey])!;
        assert.equal(m.id, proxy.id, "the call id show, diff-calls and exp replay take");
        assert.equal(m.durationMs, proxy.durationMs, "the proxy timed the call on the wire");
        assert.equal(m.payload.requestRef, proxy.payload.requestRef);
        assert.equal(m.turnId, hook.turnId, "fields only the hook copy has are filled in");
        assert.equal(m.usage?.cacheReadTokens, proxy.usage?.cacheReadTokens ?? hook.usage?.cacheReadTokens);
      }
      // Everything else is untouched.
      assert.equal(mergeCallCopies(events).length, events.length - 2);
      assert.equal(callCopies(events).folded.size, 2);
    });
  }

  it("leaves a call alone when only one path logged it, and pairs each copy once", () => {
    const [a, b, c, d] = calls(CLAUDE);
    // A proxy-only call (a retry, a title call) and a lone hook call stay.
    assert.equal(mergeCallCopies([b!, c!]).length, 2);
    // Two proxy calls with one hook copy: one merges, the other stays.
    const twice = [a!, b!, { ...b!, id: "x".repeat(64), ts: b!.ts + 1 }, d!];
    const m = calls(mergeCallCopies(twice));
    assert.equal(m.length, 3);
    // Another session's call with the same id is not a copy.
    assert.equal(mergeCallCopies([a!, { ...b!, sessionId: "other" }]).length, 2);
  });

  it("MCP timeline: one llm line per call", () => {
    for (const events of [CLAUDE, CODEX]) {
      const s = buildSession(events);
      const llm = timeline(events, s.startedAt).filter((t) => t.kind === "llm");
      assert.equal(llm.length, 2, JSON.stringify(llm));
    }
  });
});

describe("show on a session the proxy and the hooks both captured", () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-call-copies-")));
    env = { PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODING_SH_HOME: join(root, "data"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1", TZ: "UTC" };
    const stores = await openStores(loadConfig(env));
    try {
      // Claude Code: the stub sent no cache counts on the stream, the transcript has them. Given some, the merged line shows them.
      const claude = CLAUDE.map((e) => (e.kind === "llm.call" && e.source !== "proxy" ? { ...e, usage: { ...e.usage, cacheReadTokens: 4096 } } : e));
      for (const events of [claude, CODEX]) {
        await stores.index.putEvents(events);
        await stores.index.upsertSession(buildSession(events));
      }
    } finally {
      await stores.index.close();
      await stores.blobs.close?.();
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const show = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "show", ...args], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };

  for (const [agent, events] of [["claude-code", CLAUDE], ["codex", CODEX]] as const) {
    it(`${agent}: one llm line per call, with the proxy's call id`, () => {
      const out = show(events[0]!.sessionId);
      const llm = out.split("\n").filter((l) => /^\s*\+\S+\s+llm /.test(l));
      const proxied = calls(events).filter((e) => e.source === "proxy");
      assert.equal(llm.length, proxied.length, out);
      proxied.forEach((p, i) => assert.ok(llm[i]!.endsWith(p.id.slice(0, 12)), llm[i]));
      if (agent === "claude-code") assert.ok(llm.every((l) => / cache r4\.1k\/w0 /.test(l)), "cache reads from the hook copy");
      // --json stays the raw events, both copies.
      const doc = JSON.parse(show(events[0]!.sessionId, "--json")) as { data?: { events: AgentEvent[] }; events?: AgentEvent[] };
      assert.equal(calls((doc.data ?? doc).events!).length, 4);
    });
  }
});
