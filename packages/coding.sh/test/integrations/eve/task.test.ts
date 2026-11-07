import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createDataset } from "../../../src/datasets/dataset.ts";
import { containsGrader } from "../../../src/graders/builtin.ts";
import { runExperiment } from "../../../src/experiments/run.ts";
import type { GradeContext, Grader } from "../../../src/datasets/types.ts";
import { eveTask, type EveTaskOutput } from "../../../src/integrations/eve/index.ts";
import { ROOT_A, ROOT_B, STREAM_2TURNS, STREAM_TOOL_ERROR } from "./helpers.ts";

// A stand-in for `eve dev` that replays recorded session streams. It serves
// stored lines from ?startIndex=, cuts each lease after a few lines (like
// eve's renewable leases) and only reveals a turn after its message is sent.
interface Fake {
  lines: string[];
  /** Line index after which each delivery's turn is complete. */
  turnEnds: number[];
  deliveries: string[];
  sent: number;
  ended: boolean;
}

function fakeSession(file: string): Fake {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const turnEnds: number[] = [];
  const deliveries: string[] = [];
  lines.forEach((l, i) => {
    for (const f of (JSON.parse(l) as { facts?: { type: string; data: { deliveryId: string } }[] }).facts ?? [])
      if (f.type === "delivery.settled") {
        turnEnds.push(i);
        deliveries.push(f.data.deliveryId);
      }
  });
  return { lines, turnEnds, deliveries, sent: 0, ended: false };
}

const sessions = new Map<string, Fake>();
const requests: string[] = [];
let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    requests.push(`${req.method} ${u.pathname}${u.search}`);
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const m = u.pathname.match(/^\/eve\/v1\/session(?:\/([^/]+))?(?:\/(stream|end))?$/);
      if (!m) return send(404, { error: "not found" });
      const [, id, action] = m;
      if (req.method === "POST" && !id) {
        const msg = (JSON.parse(body) as { message: string }).message;
        const sid = /Atlantis/.test(msg) ? ROOT_B : ROOT_A;
        const s = fakeSession(sid === ROOT_B ? STREAM_TOOL_ERROR : STREAM_2TURNS);
        sessions.set(sid, s);
        return send(202, { ok: true, sessionId: sid, deliveryId: s.deliveries[s.sent++] });
      }
      const s = sessions.get(id!);
      if (!s) return send(404, { error: "unknown session" });
      if (req.method === "POST" && action === "end") {
        s.ended = true;
        return send(202, { ok: true });
      }
      if (req.method === "POST" && !action) return send(202, { ok: true, deliveryId: s.deliveries[s.sent++] });
      if (req.method === "GET" && action === "stream") {
        const start = Number(u.searchParams.get("startIndex") ?? 0);
        const visible = s.turnEnds[s.sent - 1]! + 1;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write('{"$eve":"heartbeat"}\n');
        const lease = s.lines.slice(start, Math.min(visible, start + 7));
        for (const l of lease) res.write(`${l}\n`);
        return res.end('{"$eve":"stream.lease-ended"}\n');
      }
      return send(405, { error: "method" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const ctx = { runId: "r", caseId: "c", trial: 0 };

describe("eveTask", () => {
  it("runs a multi-turn case over eve's HTTP API and returns replies plus the trace", async () => {
    const task = eveTask({ url });
    const result = (await task.fn({ messages: ["What is the weather in Paris?", "And the weather in London?"] }, ctx)) as { output: EveTaskOutput; trace: { kind: string }[] };
    assert.equal(result.output.sessionId, ROOT_A);
    assert.equal(result.output.outcome, "handled");
    assert.deepEqual(result.output.replies, ["Paris: Sunny, 21°C. Outlook: staying clear through tomorrow.", "London: Rain, 14°C. Outlook: showers easing by evening."]);
    assert.equal(result.output.reply, result.output.replies[1]);
    assert.deepEqual(result.output.subagents, ["forecaster", "forecaster"]);
    assert.deepEqual(
      result.output.toolCalls.filter((c) => c.kind === "tool").map((c) => [c.tool, c.input, c.ok]),
      [
        ["get_weather", { city: "Paris" }, true],
        ["get_weather", { city: "London" }, true],
      ],
    );
    assert.ok(result.trace.some((e) => e.kind === "subagent.end"));
    assert.equal(sessions.get(ROOT_A)!.ended, true, "ends the session afterwards");
    // Resumed across leases with startIndex, never re-reading a line.
    const reads = requests.filter((r) => r.startsWith("GET")).map((r) => Number(new URL(r.split(" ")[1]!, "http://x").searchParams.get("startIndex")));
    assert.deepEqual(reads, [...reads].sort((a, b) => a - b));
    assert.equal(reads[0], 0);
  });

  it("rejects inputs it cannot send", async () => {
    await assert.rejects(Promise.resolve(eveTask({ url }).fn({ prompt: 1 }, ctx)), /must be a string/);
  });

  it("works as an experiment task with output and trace graders", async () => {
    const dataset = createDataset({
      name: "weather",
      cases: [
        { id: "paris", input: "What is the weather in Paris?", expected: "Paris: Sunny" },
        { id: "atlantis", input: "What is the weather in Atlantis?", expected: "no weather data" },
      ],
    });
    const usedForecaster: Grader = {
      id: "used-forecaster",
      version: "1",
      kind: "trace",
      grade: async (g: GradeContext) => {
        const ok = g.trace?.some((e) => e.kind === "subagent.start" && e.payload?.type === "forecaster") ?? false;
        return { score: ok ? 1 : 0, pass: ok };
      },
    };
    const replyMatches = containsGrader({ name: "reply" });
    const res = await runExperiment({ name: "eve", dataset, task: eveTask({ url }), graders: [replyMatches, usedForecaster], concurrency: 1 });
    const byCase = Object.fromEntries(res.runs.map((r) => [r.caseId, r]));
    assert.equal(byCase.paris!.error, undefined);
    assert.equal(byCase.atlantis!.error, undefined);
    const score = (caseId: string, grader: string) => byCase[caseId]!.grades.find((g) => g.graderId === grader)?.result?.score;
    assert.equal(score("paris", "used-forecaster"), 1);
    assert.equal(score("atlantis", "used-forecaster"), 0);
    assert.equal(score("paris", "reply"), 1);
    assert.equal(score("atlantis", "reply"), 1);
  });
});
