// Y-15: the model driver's tool-output cap. A prefix byte slice breaks JSON and
// drops the keys after the cut; the structure cut stays valid JSON under the
// cap with every top-level key, and cuts logs on whole lines.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { capOutput, CAP_MODES, type OutputCut } from "../../src/toolevals/model/cap.ts";
import { buildToolRuntime } from "../../src/toolevals/model/tools.ts";
import { runModelLoop } from "../../src/toolevals/model/loop.ts";
import { computeMetrics } from "../../src/toolevals/metrics.ts";
import { compareToolArms, summarizeArms } from "../../src/toolevals/compare.ts";
import { formatArms, formatToolCompare } from "../../src/toolevals/report.ts";
import { loadToolEvals } from "../../src/toolevals/config.ts";
import { effectiveModelDriver } from "../../src/toolevals/drivers/model.ts";
import { prepareSandbox } from "../../src/toolevals/sandbox.ts";
import type { McpClient } from "../../src/toolevals/mcp/client.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { Driver, McpTarget } from "../../src/toolevals/types.ts";
import { startFakeProvider } from "./fixtures/fake-provider.mjs";
import { cleanup, task, tmp, trial } from "./helpers.ts";

after(cleanup);

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const parses = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** ~40 KB: {items: [500 rows], summary, fault}. */
function bigReport(): string {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row-${i}`, status: i % 7 ? "ok" : "slow", note: "n".repeat(40) }));
  return JSON.stringify({ items, summary: { total: 500, slow: 72 }, fault: { code: "E_TIMEOUT", row: 417 } });
}

describe("capOutput", () => {
  const small = JSON.stringify({ a: 1, b: "two" });
  const cases: Record<string, string> = {
    "small JSON": small,
    "big object": bigReport(),
    "big top-level array": JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ i, v: `value-${i}` }))),
    "deeply nested": JSON.stringify(Array.from({ length: 40 }).reduce<unknown>((acc, _, i) => ({ level: i, pad: "p".repeat(500), child: acc }), { leaf: "x".repeat(2000) })),
    "non-JSON": Array.from({ length: 2000 }, (_, i) => `2026-11-08T10:00:${String(i % 60).padStart(2, "0")} INFO request ${i} served in ${i % 97} ms`).join("\n"),
    "multibyte boundary": "é漢🙂".repeat(3000),
  };

  for (const mode of CAP_MODES) {
    it(`${mode}: under-cap output is byte-identical with no cut`, () => {
      for (const t of [small, "plain text\n", "", "é漢🙂"]) {
        const r = capOutput(t, { mode, maxBytes: 16384 });
        assert.equal(r.text, t);
        assert.equal(r.cut, undefined);
      }
    });
    for (const [name, text] of Object.entries(cases)) {
      it(`${mode}: ${name}`, () => {
        const r = capOutput(text, { mode, maxBytes: 4096 });
        if (bytes(text) <= 4096 || mode === "none") {
          assert.equal(r.text, text);
          return;
        }
        assert.ok(r.cut);
        assert.equal(r.cut.mode, mode);
        assert.equal(r.cut.originalBytes, bytes(text));
        assert.equal(r.cut.deliveredBytes, bytes(r.text));
        assert.ok(!r.text.includes("�"), "no split characters");
        if (mode === "structure") {
          assert.ok(bytes(r.text) <= 4096, `${bytes(r.text)} <= 4096`);
          if (r.cut.json) assert.ok(parses(r.text));
        }
      });
    }
  }

  it("acceptance: 40 KB {items, summary, fault} at 16384", () => {
    const text = bigReport();
    assert.ok(bytes(text) > 38_000);
    const prefix = capOutput(text, { mode: "prefix", maxBytes: 16384 });
    assert.equal(parses(prefix.text), false);
    assert.ok(!prefix.text.includes('"summary"') && !prefix.text.includes('"fault"'));
    assert.deepEqual(prefix.cut?.topKeysKept, []);
    assert.equal(prefix.cut?.jsonValid, false);

    const s = capOutput(text, { mode: "structure", maxBytes: 16384 });
    assert.ok(bytes(s.text) <= 16384);
    const v = JSON.parse(s.text) as { items: unknown[]; summary: unknown; fault: unknown };
    assert.deepEqual(Object.keys(v), ["items", "summary", "fault"]);
    assert.deepEqual(v.summary, { total: 500, slow: 72 });
    assert.deepEqual(v.fault, { code: "E_TIMEOUT", row: 417 });
    assert.match(String(v.items.at(-1)), /^…\d+ more items$/);
    assert.equal(s.cut?.jsonValid, true);
    assert.deepEqual(s.cut?.topKeysKept, s.cut?.topKeys);
  });

  it("a 2,000-line log keeps whole head and tail lines with an exact omitted count", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"y".repeat(20 + (i % 13))}`);
    const r = capOutput(lines.join("\n"), { maxBytes: 16384 });
    assert.ok(bytes(r.text) <= 16384);
    const out = r.text.split("\n");
    const at = out.findIndex((l) => l.startsWith("[… omitted "));
    const m = /^\[… omitted (\d+) of 2000 lines …\]$/.exec(out[at]!);
    assert.ok(m);
    const head = out.slice(0, at);
    const tail = out.slice(at + 1);
    assert.deepEqual(head, lines.slice(0, head.length));
    assert.deepEqual(tail, lines.slice(2000 - tail.length));
    assert.equal(Number(m[1]), 2000 - head.length - tail.length);
    assert.equal(r.cut?.omittedLines, Number(m[1]));
    assert.ok(head.length > tail.length, "about 60/40");
  });

  it("property: 200 random JSON values cut in structure mode parse and fit", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const gen = (d: number): unknown => {
      const r = rnd();
      if (d > 3 || r < 0.3) return r < 0.1 ? null : r < 0.2 ? Math.floor(rnd() * 1e6) : "s".repeat(Math.floor(rnd() * 1500)) + "é";
      if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 25) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 12) }, (_, i) => [`k${i}`, gen(d + 1)]));
    };
    for (let i = 0; i < 200; i++) {
      const text = JSON.stringify(gen(0));
      const max = 256 + Math.floor(rnd() * 4000);
      const r = capOutput(text, { mode: "structure", maxBytes: max });
      assert.ok(parses(r.text), `case ${i} parses`);
      assert.ok(bytes(r.text) <= Math.max(max, bytes(text) <= max ? bytes(text) : 0), `case ${i}: ${bytes(r.text)} <= ${max}`);
    }
  });

  it("an object with too many keys falls back to a key list", () => {
    const o = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`key_${i}`, i]));
    const r = capOutput(JSON.stringify(o), { maxBytes: 2048 });
    const v = JSON.parse(r.text) as { _truncated: boolean; keys: string[]; originalBytes: number };
    assert.equal(v._truncated, true);
    assert.ok(v.keys.length > 0 && v.keys.at(-1)!.endsWith("more keys"));
    assert.ok(bytes(r.text) <= 2048);
    assert.deepEqual(r.cut?.topKeysKept, []);
  });
});

// ------------------------------------------------------------ model loop

const mcpTarget: McpTarget = { name: "big", kind: "mcp", transport: "stdio", command: ["unused"] };
const fakeMcp = (payload: string): McpClient => ({
  era: "legacy",
  protocolVersion: "2025-11-25",
  listResources: async () => [],
  listResourceTemplates: async () => [],
  readResource: async () => [],
  listPrompts: async () => [],
  getPrompt: async () => ({ messages: [] }),
  async listTools() {
    return [{ name: "report", description: "Big report", inputSchema: { type: "object" } }];
  },
  async callTool() {
    return { content: [{ type: "text", text: payload }] };
  },
  async close() {},
});

describe("model loop: cut on tool.end", () => {
  for (const mode of ["structure", "prefix"] as const) {
    it(`${mode}: a 40 KB MCP result is cut and recorded`, async () => {
      const payload = bigReport();
      const p = await startFakeProvider([{ toolCalls: [{ name: "report", input: {} }] }, { text: "done" }]);
      try {
        const sb = await prepareSandbox(task(), mcpTarget, { name: "base" }, "trial_cap", tmp());
        const tools = await buildToolRuntime(mcpTarget, sb, { mcp: fakeMcp(payload), outputCap: { mode } });
        const events: AgentEvent[] = [];
        const driver: Extract<Driver, { kind: "model" }> = { kind: "model", provider: "anthropic", model: "fake-model", baseUrl: p.url, apiKeyEnv: "K" };
        await runModelLoop({ driver, instruction: "go", tools, apiKey: "k", fetch, budget: {}, trialId: `trial_cap_${mode}`, emit: (e) => events.push(e) });
        const end = events.find((e) => e.kind === "tool.end")!;
        const cut = end.payload.cut as OutputCut;
        assert.equal(cut.mode, mode);
        assert.equal(cut.jsonValid, mode === "structure");
        assert.equal(end.payload.outputBytes, bytes(payload));
        assert.equal(end.payload.deliveredBytes, cut.deliveredBytes);
        // What the model got on the next request is the cut text.
        const sent = JSON.stringify(p.requests[1]!.body);
        assert.equal(sent.includes('\\"fault\\"'), mode === "structure");
        const m = computeMetrics({ task: task(), target: mcpTarget, tap: [], events, sessions: [], run: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, checksPass: true });
        assert.equal(m.outputCuts, 1);
        assert.equal(m.brokenJsonCuts, mode === "prefix" ? 1 : 0);
        assert.equal(m.fieldDelivery?.["report.fault"], mode === "prefix" ? 0 : 1);
      } finally {
        await p.close();
      }
    });
  }

  it("under the cap the result is untouched and tool.end has no cut", async () => {
    const sb = await prepareSandbox(task(), mcpTarget, { name: "base" }, "trial_cap_small", tmp());
    const tools = await buildToolRuntime(mcpTarget, sb, { mcp: fakeMcp('{"ok":true}') });
    const r = await tools.exec({ id: "1", name: "report", input: {} });
    assert.equal(r.content, '{"ok":true}');
    assert.equal(r.cut, undefined);
  });
});

// ------------------------------------------------------------ metrics, compare, report

function cutEvents(cuts: (OutputCut | undefined)[]): AgentEvent[] {
  return cuts.flatMap((cut, i) => [
    { id: `s${i}`, v: 0, sessionId: "t", ts: i * 10, agent: "coding.sh-model", kind: "tool.start", payload: { tool: "t", toolUseId: `u${i}` } },
    { id: `e${i}`, v: 0, sessionId: "t", ts: i * 10 + 1, agent: "coding.sh-model", kind: "tool.end", payload: { tool: "t", toolUseId: `u${i}`, ok: true, ...(cut ? { cut } : {}) } },
  ]) as AgentEvent[];
}

describe("cut metrics", () => {
  const run = { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" };
  const prefixCut: OutputCut = { mode: "prefix", originalBytes: 40000, deliveredBytes: 16400, json: true, jsonValid: false, topKeys: ["items", "summary", "fault"], topKeysKept: [] };
  const structCut: OutputCut = { mode: "structure", originalBytes: 40000, deliveredBytes: 16000, json: true, jsonValid: true, topKeys: ["items", "summary", "fault"], topKeysKept: ["items", "summary", "fault"] };

  it("3 cuts of 6 calls: rate 0.5; fieldDelivery t.fault 0 (prefix) vs 1 (structure)", () => {
    for (const [cut, fault, broken] of [
      [prefixCut, 0, 3],
      [structCut, 1, 0],
    ] as const) {
      const m = computeMetrics({ task: task(), target: mcpTarget, tap: [], events: cutEvents([cut, undefined, cut, undefined, cut, undefined]), sessions: [], run, checksPass: true });
      assert.equal(m.outputCuts, 3);
      assert.equal(m.outputCutRate, 0.5);
      assert.equal(m.brokenJsonCuts, broken);
      assert.equal(m.fieldDelivery?.["t.fault"], fault);
    }
  });

  it("no tool calls: rate null, no fieldDelivery", () => {
    const m = computeMetrics({ task: task(), target: mcpTarget, tap: [], events: [], sessions: [], run, checksPass: true });
    assert.equal(m.outputCutRate, null);
    assert.equal(m.outputCuts, 0);
    assert.equal(m.fieldDelivery, undefined);
  });

  it("compare and report show cut metrics only when an arm has cuts", () => {
    const D = "model:anthropic/m";
    const plain = [trial("a", "prefix", D, 1, true), trial("a", "structure", D, 1, true), trial("b", "prefix", D, 1, true), trial("b", "structure", D, 1, true)];
    const r0 = compareToolArms(plain, { baseline: `prefix@${D}`, candidate: `structure@${D}`, seed: 1 });
    assert.equal(r0.metrics.outputCutRate, undefined);
    assert.ok(!formatArms(summarizeArms(plain)).includes("output cuts"));
    const cut = [
      trial("a", "prefix", D, 1, false, { outputCuts: 2, outputCutRate: 0.5, brokenJsonCuts: 2, toolCalls: 4 }),
      trial("a", "structure", D, 1, true, { outputCuts: 2, outputCutRate: 0.5, brokenJsonCuts: 0, toolCalls: 4 }),
      trial("b", "prefix", D, 1, false, { outputCuts: 1, outputCutRate: 0.25, brokenJsonCuts: 1, toolCalls: 4 }),
      trial("b", "structure", D, 1, true, { outputCuts: 1, outputCutRate: 0.25, brokenJsonCuts: 0, toolCalls: 4 }),
    ];
    const r1 = compareToolArms(cut, { baseline: `prefix@${D}`, candidate: `structure@${D}`, seed: 1 });
    assert.equal(r1.metrics.brokenJsonCuts?.baseline, 1.5);
    assert.equal(r1.metrics.brokenJsonCuts?.candidate, 0);
    assert.match(formatToolCompare(r1), /broken JSON cuts/);
    const arms = formatArms(summarizeArms(cut));
    assert.match(arms, /prefix@model:anthropic\/m: output cuts 3\/8 \(37\.5%\) · broken JSON 3/);
  });
});

// ------------------------------------------------------------ config

describe("outputCap config", () => {
  const repo = (toml: string, variants: Record<string, string> = {}) => {
    const d = tmp();
    writeFileSync(join(d, "coding.sh.toml"), `[toolevals.targets.big]\nkind = "mcp"\ncommand = ["x"]\n${toml}`);
    const vdir = join(d, "evals", "toolevals", "big", "variants");
    mkdirSync(vdir, { recursive: true });
    for (const [n, t] of Object.entries(variants)) writeFileSync(join(vdir, `${n}.toml`), t);
    return d;
  };

  it("parses driver and variant caps; the variant wins", async () => {
    const cfg = await loadToolEvals(repo(`[toolevals.drivers."model:anthropic/m"]\noutputCap = { mode = "prefix", maxBytes = 8192 }\n`, { structure: `[outputCap]\nmode = "structure"\n` }));
    assert.deepEqual(cfg.drivers["model:anthropic/m"]?.outputCap, { mode: "prefix", maxBytes: 8192 });
    const v = cfg.variants.get("big")!.get("structure")!;
    assert.deepEqual(v.outputCap, { mode: "structure" });
    const d: Extract<Driver, { kind: "model" }> = { kind: "model", provider: "anthropic", model: "m", apiKeyEnv: "K", outputCap: { mode: "prefix", maxBytes: 8192 } };
    assert.deepEqual(effectiveModelDriver(d, v).outputCap, { mode: "structure", maxBytes: 8192 });
  });

  it("rejects a bad mode and maxBytes 0", async () => {
    await assert.rejects(() => loadToolEvals(repo(`[toolevals.drivers."model:anthropic/m"]\noutputCap = { mode = "middle" }\n`)), /outputCap.mode must be one of structure, prefix, none/);
    await assert.rejects(() => loadToolEvals(repo(`[toolevals.drivers."model:anthropic/m"]\noutputCap = { maxBytes = 0 }\n`)), /outputCap.maxBytes must be a whole number above 0/);
    const cfg = await loadToolEvals(repo("", { bad: `[outputCap]\nmaxBytes = 0\n` }));
    assert.ok(cfg.problems.some((p) => /maxBytes/.test(p)));
    assert.equal(cfg.variants.get("big")!.has("bad"), false);
  });
});
