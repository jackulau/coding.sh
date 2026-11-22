// A long session's /events pages as the viewer loads them (rows=1): compact rows, long payload text
// clipped, gzip on the wire. The whole run still goes on screen with the same timeline, and an
// opened step shows its full payload. The browser half is skipped when no Chrome is installed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import type { AgentEvent } from "../../src/core/types.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { EVENT_ROW_TEXT_CAP, STEP_INPUT_KEYS, eventRows, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { session } from "./fakes.ts";

const chrome = findChrome();
const ID = "7c41e0d2-9a35-4b6f-8e21-3f5d0a9c6b18";
const EVENTS = 20_000;
const PAGE = 5000; // EVENTS_PAGE in ui/index.html
const T0 = 1_762_500_000_000;
const MARKER = "tail of the long read output";
const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");

/** A source file's text, `lines` lines long. */
function code(n: number, lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(`${String(i + 1).padStart(4)}\t  const value${(n + i) % 97} = parseRow(rows[${i}], { strict: ${i % 2 === 0} }); // step ${n}`);
  return out.join("\n");
}

/** A hand-written long Claude Code run: turns of model calls, reads, edits, shell runs and test results. */
function longRun(): { events: AgentEvent[]; target: AgentEvent } {
  const events: AgentEvent[] = [];
  const env = { v: 0 as const, sessionId: ID, agent: "claude-code" as const, agentVersion: "2.1.3", cwd: "/work/demo", source: "transcript" };
  let n = 0, turn = 0, call = 0;
  const push = (e: Partial<AgentEvent> & Pick<AgentEvent, "kind" | "payload">) => {
    events.push({ ...env, id: `${ID}-e${n}`, ts: T0 + n * 1500, turnId: `turn-${turn}`, ...e } as AgentEvent);
    n++;
  };
  while (n < EVENTS) {
    if (n % 400 === 0) { turn++; push({ kind: "user.message", payload: { text: `Make the parser accept trailing commas in step ${n}, then run the tests` } }); continue; }
    push({
      kind: "llm.call", model: "claude-opus-5-5", durationMs: 2400 + (n % 7) * 300,
      usage: { inputTokens: 1200 + (n % 50), outputTokens: 180 + (n % 30), cacheReadTokens: 48_000 + n, costUsd: 0.0123 },
      payload: { provider: "anthropic", responseModel: "claude-opus-5-5", stopReason: "tool_use", ok: true, costByTokenType: { input: 0.006, output: 0.0045, cacheRead: 0.0018 } },
    });
    const use = `toolu_${String(call++).padStart(6, "0")}`;
    const pick = call % 5;
    if (pick === 0) {
      push({ kind: "tool.start", payload: { tool: "Read", toolUseId: use, input: { file_path: `/work/demo/src/parse/row${call % 40}.ts` } } });
      push({ kind: "tool.end", durationMs: 40, payload: { tool: "Read", toolUseId: use, ok: true, output: code(call, 30) } });
    } else if (pick === 1) {
      push({ kind: "tool.start", payload: { tool: "Edit", toolUseId: use, input: { file_path: `/work/demo/src/parse/row${call % 40}.ts`, old_string: code(call, 3), new_string: code(call + 1, 4) } } });
      push({ kind: "tool.end", durationMs: 25, payload: { tool: "Edit", toolUseId: use, ok: true, output: "The file has been updated." } });
      push({ kind: "file.change", payload: { path: `src/parse/row${call % 40}.ts`, op: "modify", additions: 4, deletions: 3 } });
    } else if (pick === 2) {
      push({ kind: "tool.start", payload: { tool: "Bash", toolUseId: use, input: { command: "npm test -- --reporter dot test/parse", description: "Run the parser tests" } } });
      push({ kind: "tool.end", durationMs: 5200, payload: { tool: "Bash", toolUseId: use, ok: call % 9 !== 0, output: `> demo@1.0.0 test\n${".".repeat(180)}\n\n  ${180 - (call % 3)} passing (2s)\n  ${call % 3} failing\n\n  1) parse row ${call}\n     AssertionError: expected [ 1, 2 ] to deeply equal [ 1, 2, 3 ]` } });
      push({ kind: "test.result", payload: { runner: "mocha", passed: 180 - (call % 3), failed: call % 3 } });
    } else {
      push({ kind: "tool.start", payload: { tool: "Grep", toolUseId: use, input: { pattern: `parseRow${call % 11}`, path: "/work/demo/src" } } });
      push({ kind: "tool.end", durationMs: 120, payload: { tool: "Grep", toolUseId: use, ok: true, output: `src/parse/row${call % 40}.ts:12:export function parseRow${call % 11}(row: string) {\nsrc/parse/index.ts:3:import { parseRow${call % 11} } from "./row.ts";` } });
    }
  }
  events.length = EVENTS;
  // The step a deep link opens: a long read past the first page, its last line past the clip.
  const at = events.findIndex((e, i) => i > 12_000 && e.kind === "tool.end" && e.payload.tool === "Read");
  const end = events[at]!;
  end.payload = { ...end.payload, output: `${end.payload.output as string}\n// ${MARKER}` };
  const target = events.findLast((e, i) => i < at && e.kind === "tool.start")!;
  return { events, target };
}

/** GET a viewer API path: the body's bytes as they went over the wire, and the response headers. */
function get(v: Viewer, path: string, gzip: boolean): Promise<{ status: number; wire: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${v.token}` };
    if (gzip) headers["accept-encoding"] = "gzip, deflate, br";
    const r = request({ host: "127.0.0.1", port: v.port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, wire: body.length, headers: res.headers, body });
      });
      res.on("error", reject);
    });
    r.on("error", reject);
    r.end();
  });
}

const expandRows: (body: unknown, clipped: Set<string> | null) => any = runInNewContext(
  `${html.slice(html.indexOf("/** Envelope fields a compact row always carries"), html.indexOf("function buildTimeline("))}\nexpandRows`,
  { Set, Array, Object },
);

/** `got` is `want`, apart from strings clipped to their first EVENT_ROW_TEXT_CAP - 1 characters and an ellipsis. */
function sameOrClipped(got: unknown, want: unknown, where: string): void {
  if (typeof want === "string" && got !== want) {
    assert.ok(want.length > EVENT_ROW_TEXT_CAP && got === `${want.slice(0, EVENT_ROW_TEXT_CAP - 1)}…`, `${where}: ${JSON.stringify(got)?.slice(0, 80)}`);
    return;
  }
  if (want && typeof want === "object") {
    assert.equal(typeof got, "object", where);
    assert.deepEqual(Object.keys(got as object).sort(), Object.keys(want).sort(), where);
    for (const [k, x] of Object.entries(want)) sameOrClipped((got as Record<string, unknown>)[k], x, `${where}.${k}`);
    return;
  }
  assert.equal(got, want, where);
}

describe("a long session's events pages (rows=1)", () => {
  const index = new MemoryIndexStore();
  const { events, target } = longRun();
  let v: Viewer;
  let dir: string;
  const eventsPath = (q: string) => `/api/sessions/${encodeURIComponent(ID)}/events?${q}`;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "event-rows-"));
    await index.upsertSession(session(ID, { startedAt: T0, endedAt: T0 + EVENTS * 1500, title: "Trailing commas in the parser", stats: { events: EVENTS, turns: 50, toolCalls: 4000, toolErrors: 0, filesChanged: 40 } }));
    await index.putEvents(events);
    v = await startViewer({ index, blobs: new MemoryBlobStore(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, env: { CODING_SH_HOME: dir }, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
  });
  after(async () => {
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the pages the viewer loads move under a third of the plain pages' bytes, and read back to the same events", async () => {
    let plain = 0, rows = 0, rowsJson = 0;
    const clipped = new Set<string>();
    const back: AgentEvent[] = [];
    for (let offset = 0; offset < EVENTS; offset += PAGE) {
      const before = await get(v, eventsPath(`limit=${PAGE}&offset=${offset}`), false);
      assert.equal(before.status, 200);
      assert.equal(before.headers["content-encoding"], undefined, "no gzip unless the client takes it");
      plain += before.wire;
      const now = await get(v, eventsPath(`limit=${PAGE}&offset=${offset}&rows=1`), true);
      assert.equal(now.status, 200);
      assert.equal(now.headers["content-encoding"], "gzip");
      assert.equal(now.headers.vary, "Accept-Encoding");
      rows += now.wire;
      const { gunzipSync } = await import("node:zlib");
      const json = gunzipSync(now.body).toString("utf8");
      rowsJson += Buffer.byteLength(json);
      // JSON again: the vm realm has its own Object prototype.
      back.push(...JSON.parse(JSON.stringify(expandRows(JSON.parse(json), clipped).items)));
    }
    console.log(`# plain ${plain} B, rows=1 ${rowsJson} B (${(rowsJson / plain).toFixed(3)}), on the wire ${rows} B (${(rows / plain).toFixed(3)}); ${clipped.size} of ${EVENTS} events clipped`);
    assert.ok(rows * 3 < plain, `rows=1 moves ${rows} B against ${plain} B`);
    assert.ok(rowsJson < plain * 0.75, `the rows themselves are smaller too: ${rowsJson} B against ${plain} B`);
    assert.equal(back.length, EVENTS);
    for (let i = 0; i < EVENTS; i++) {
      const want = JSON.parse(JSON.stringify(events[i]));
      if (!clipped.has(want.id)) assert.deepEqual(back[i], want, `event ${i}`);
      else sameOrClipped(back[i], want, `event ${i}`);
    }
    assert.ok(clipped.size > 0, "long outputs were clipped");
  });

  test("rows keep whole what a timeline row reads, and say which payloads they clipped", () => {
    const long = "x".repeat(EVENT_ROW_TEXT_CAP + 50);
    const base = { v: 0 as const, sessionId: ID, agent: "claude-code" as const, cwd: "/work/demo", ts: T0 };
    const r = eventRows([
      { ...base, id: "a", kind: "tool.start", payload: { tool: "Bash", toolUseId: "u", input: { command: long, description: long } } },
      { ...base, id: "b", kind: "user.message", payload: { text: long } },
      { ...base, id: "c", kind: "file.change", payload: { path: long, op: "add", note: long } },
      { ...base, id: "d", kind: "tool.end", payload: { tool: "Bash", toolUseId: "u", ok: true, output: "short" } },
      { ...base, id: "e", kind: "tool.end", cwd: undefined, payload: { tool: "Bash", toolUseId: "u", ok: true, output: long } },
    ] as AgentEvent[], true);
    assert.equal((r[0]!.payload as any).input.command, long, "the command names the step and Find searches it");
    assert.equal((r[0]!.payload as any).input.description.length, EVENT_ROW_TEXT_CAP);
    assert.equal(r[0]!["…"], 1);
    assert.equal((r[1]!.payload as any).text, long, "a prompt is never clipped");
    assert.equal(r[1]!["…"], undefined);
    assert.equal((r[2]!.payload as any).path, long);
    assert.equal((r[2]!.payload as any).note.length, EVENT_ROW_TEXT_CAP);
    assert.equal(r[3]!["…"], undefined);
    assert.equal(r[3]!.cwd, undefined, "carried from the row before");
    assert.deepEqual(r[4]!["~"], ["cwd"], "a field the row before has and this one does not");
    assert.deepEqual(eventRows([{ ...base, id: "e", kind: "tool.end", payload: { output: long } }] as AgentEvent[], false)[0]!.payload, { output: long }, "nothing clipped without a store that reads an event by id");
    // The keys must match what the page names a step by.
    assert.match(html, new RegExp(`const INPUT_KEYS = ${JSON.stringify(STEP_INPUT_KEYS).replace(/[[\]]/g, "\\$&").replace(/,/g, ", ")};`));
  });

  test("an event's own route has its payload whole", async () => {
    const end = events.find((e) => e.kind === "tool.end" && String(e.payload.output).includes(MARKER))!;
    const r = await get(v, `/api/events/${encodeURIComponent(end.id)}`, true);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString("utf8")).payload, end.payload);
  });

  describe("in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
    let browser: Browser;
    let page: Page | undefined;
    before(async () => {
      browser = await launchBrowser(chrome!);
    });
    after(async () => {
      await page?.close();
      await browser?.close();
    });

    test("a deep link past the first page opens the step with its full output, and the whole run loads with the same timeline", async () => {
      page = await browser.newPage();
      await page.viewport(1280, 900);
      await page.goto(v.url);
      await page.waitFor("document.querySelector('[role=listbox], .panel.empty:not([aria-busy])')", "sessions list");
      await page.eval(`location.hash = ${JSON.stringify(`#/s/${encodeURIComponent(ID)}/${encodeURIComponent(target.id)}`)}`);
      const pane: string = await page.waitFor(`document.querySelector('#event-pane')?.innerText.includes(${JSON.stringify(MARKER)}) && document.querySelector('#event-pane').innerText`, "the full output in the pane", 20_000);
      assert.match(pane, /Read/);
      // The same steps, names and searchable text as the plain events give.
      const same = await page.eval(`(async () => {
        const path = ${JSON.stringify(eventsPath(`limit=${EVENTS}`))};
        const sig = (evs) => JSON.stringify(buildTimeline(evs).map((it) => [it.type, it.id, itemView(it).label, it.type === "tool" ? pickInput(((it.start || {}).payload || {}).input) : ""]));
        const plain = await fetchJson(path);
        const rows = expandRows(await fetchJson(path + "&rows=1"), null);
        return { same: sig(plain.items) === sig(rows.items), steps: buildTimeline(plain.items).length };
      })()`);
      assert.ok(same.same, "the timeline from rows=1 matches the plain one");
      // Every page loads behind the first: the whole run is on screen.
      const head = await page.eval(`plural(${same.steps}, "step")`);
      await page.waitFor(`document.querySelector('.timeline-head')?.textContent === ${JSON.stringify(head)}`, "every step", 20_000);
      assert.equal(await page.eval("document.querySelector('#load-events')"), null, "no Load button left");
      assert.deepEqual(page.errors, []);
    });
  });
});
