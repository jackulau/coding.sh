// Viewer fixes from hands-on QA (round 9) in headless Chrome: Find in steps matches a tool's output
// and error, also past the part a row loads, as the event search does; the Agent facet's picked
// host app (agent:t3code) counts the sessions the list shows; the top bar says the stats are being
// rebuilt while the index is folded again after an upgrade; a workflow run's error keeps its lines.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { ganttRunFixture } from "../workflows/_fixtures.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const SID = "qa9v-find";
const t0 = Date.UTC(2026, 10, 20, 9);
const RUN_ERROR = "booting <img src=x>\nstep 2 of 3\nfailed at <a href=#>step</a> </div></td>";

function events(): AgentEvent[] {
  const base = { v: 0, sessionId: SID, agent: "claude-code", cwd: "/work/demo" } as const;
  let n = 0;
  const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>, dt: number): AgentEvent => ({ ...base, id: `${SID}-${n++}`, ts: t0 + dt, kind, payload });
  // Output past the 240 characters a row carries: the phrase sits after them.
  const long = "x ".repeat(200) + "bash: warning: here-document at line 3 delimited by end-of-file";
  return [
    ev("user.message", { text: "Read the config and run the script" }, 0),
    ev("tool.start", { tool: "Read", toolUseId: "t1", input: { file_path: "/work/demo/config.json" } }, 1000),
    ev("tool.end", { tool: "Read", toolUseId: "t1", ok: false, error: "ENOENT: no such file or directory" }, 1200),
    ev("tool.start", { tool: "Bash", toolUseId: "t2", input: { command: "sh run.sh" } }, 2000),
    ev("tool.end", { tool: "Bash", toolUseId: "t2", ok: true, output: long }, 2600),
    ev("tool.start", { tool: "Bash", toolUseId: "t3", input: { command: "ls" } }, 3000),
    ev("tool.end", { tool: "Bash", toolUseId: "t3", ok: true, output: "run.sh" }, 3100),
    ev("assistant.message", { text: "The config file is missing." }, 4000),
  ];
}

describe("round 9 viewer QA fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;
  let dir: string;
  let ingest: Record<string, unknown> = { ingesting: false, filesPending: 0, lastIngestAt: null };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "qa9v-"));
    const index = new MemoryIndexStore();
    await index.upsertSession(session(SID, { startedAt: t0, endedAt: t0 + 4000, title: "Run the script", stats: { events: 8, turns: 1, toolCalls: 3, toolErrors: 1, filesChanged: 0 } }));
    await index.putEvents(events());
    // Three sessions T3 Code drove (two Claude Code, one Codex) and two run on their own.
    for (let i = 0; i < 3; i++) await index.upsertSession(session(`qa9v-t3-${i}`, { agent: i === 2 ? "codex" : "claude-code", host: "t3code", startedAt: t0 - (i + 1) * 60_000, endedAt: t0 - (i + 1) * 60_000 + 5000 } as any));
    for (let i = 0; i < 2; i++) await index.upsertSession(session(`qa9v-own-${i}`, { startedAt: t0 - (i + 10) * 60_000, endedAt: t0 - (i + 10) * 60_000 + 5000 }));
    const store = new WorkflowStore(join(dir, "workflows"));
    const fx = ganttRunFixture();
    await store.putRun({ ...fx.run, id: "wf_lines01", status: "failed", error: RUN_ERROR }, fx.nodes.map((x) => ({ ...x, runId: "wf_lines01" })));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, workflows: store, ingestStatus: () => ingest as any, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, wait: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor(wait, "the page");
    return page;
  }

  test("Find in steps matches a tool's error and its output, also past what a row loads", async () => {
    const p = await open("#/s/" + SID, "document.querySelector('#find') && document.querySelectorAll('.st').length >= 4");
    const find = async (q: string, want: string) => {
      await p.eval(`(() => { const f = document.querySelector('#find'); f.value = ${JSON.stringify(q)}; f.dispatchEvent(new Event('input')); })()`);
      await p.waitFor(`document.querySelector('.find .count').textContent === ${JSON.stringify(want)}`, `find ${q} reads ${want}`);
      return p.eval("document.querySelectorAll('.st.is-match').length");
    };
    assert.equal(await find("ENOENT", "1/1"), 1, "the failed Read's error");
    assert.equal(await find("here-document at line 3", "1/1"), 1, "the Bash output past the clipped row");
    assert.equal(await find("zzqq-nothing", "0"), 0);
    assert.deepEqual(p.errors, []);
  });

  test("the picked host app's Agent chip counts the sessions the list shows", async () => {
    const p = await open("#/?where=" + encodeURIComponent("agent:t3code"), "document.querySelector('[data-filter=\"agent\"] [data-value=\"t3code\"]') && document.querySelectorAll('.list .row').length === 3");
    const chip = await p.eval("document.querySelector('[data-filter=\"agent\"] [data-value=\"t3code\"] .count').textContent");
    assert.equal(chip, "3");
    assert.deepEqual(p.errors, []);
  });

  test("the top bar says the stats are being rebuilt while the index is folded again", async () => {
    ingest = { ingesting: false, filesPending: 0, lastIngestAt: Date.now(), refolding: true };
    try {
      const p = await open("#/", "document.querySelector('#indexing') && !document.querySelector('#indexing').hidden");
      const m = await p.eval("({ text: document.querySelector('#indexing').textContent, title: document.querySelector('#indexing').title })");
      assert.equal(m.text, "Rebuilding stats…");
      assert.match(m.title, /older version/);
      assert.deepEqual(p.errors, []);
    } finally {
      ingest = { ingesting: false, filesPending: 0, lastIngestAt: Date.now() };
    }
  });

  test("a workflow run's error keeps its line breaks, as text", async () => {
    const p = await open("#/workflows/wf_lines01", "document.querySelector('.alert .run-error')");
    const m = await p.eval("(() => { const e = document.querySelector('.alert .run-error'); return { text: e.textContent, ws: getComputedStyle(e).whiteSpace, tags: e.querySelectorAll('*').length }; })()");
    assert.equal(m.text, RUN_ERROR);
    assert.equal(m.ws, "pre-wrap");
    assert.equal(m.tags, 0, "the markup stays text");
    assert.deepEqual(p.errors, []);
  });
});
