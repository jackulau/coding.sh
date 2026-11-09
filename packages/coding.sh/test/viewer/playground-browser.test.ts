// The playground page in headless Chrome: an llm.call pane links to it, the
// call opens as an editable request, Run goes to a stub OpenAI-compatible
// server and shows the answer beside the recorded one, Save adds a case to a
// dataset version, the phone layout fits, and nothing logs a console error.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { viewerPlayground } from "../../src/viewer/playground.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { call, startTestProxy, startUpstream, type TestProxy, type Upstream } from "../proxy/_helpers.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const chatAnswer = (text: string) => ({
  id: "chatcmpl-pg",
  object: "chat.completion",
  model: "stub-coder-1",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 40, completion_tokens: 7 },
});

describe("Playground page in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let stub: Server;
  const seen: any[] = [];
  let up: Upstream;
  let t: TestProxy;
  let v: Viewer;
  let bare: Viewer;
  let dir: string;
  let store: FileEvalStore;
  let callId: string;
  let sessionId: string;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        seen.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(chatAnswer(`echo: ${body.messages.at(-1).content}`)));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    up = await startUpstream((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(chatAnswer("4")));
    });
    t = await startTestProxy(up.url);
    await call(t.proxy.url, { path: "/v1/chat/completions", body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "2+2?" }] }), headers: { "content-type": "application/json", authorization: "Bearer sk-stub" } });
    const e = (await t.events()).find((x) => x.kind === "llm.call")!;
    callId = e.id;
    sessionId = e.sessionId;
    dir = mkdtempSync(join(tmpdir(), "csh-playground-ui-"));
    const env = { HOME: dir, CODING_SH_HOME: join(dir, ".coding.sh"), OPENAI_BASE_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1` };
    store = new FileEvalStore({ env });
    const playground = viewerPlayground({ env, datasets: store, prices: {} });
    v = await startViewer({ index: t.index, blobs: t.blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any, playground });
    bare = await startViewer({ index: t.index, blobs: t.blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    await bare?.close();
    await t?.close();
    await up?.close();
    await new Promise<void>((r) => { stub?.closeAllConnections(); stub ? stub.close(() => r()) : r(); });
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(viewer: Viewer, hash: string, mobile = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
    await page.goto(viewer.url + hash);
    return page;
  }

  test("the call pane links to the playground; edit, run against the stub, save as a case", async () => {
    const p = await open(v, `#/s/${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}`);
    await p.waitFor("document.querySelector('.pg-slot a')", "playground link");
    await p.eval("document.querySelector('.pg-slot a').click()");
    await p.waitFor("document.querySelector('.pg-msg textarea')", "playground editor");
    assert.match(await p.eval("location.hash"), /^#\/playground\//);
    assert.equal(await p.eval("document.querySelector('textarea[aria-label=\"System prompt\"]').value"), "Be terse.");
    assert.equal(await p.eval("document.querySelector('select[aria-label=Provider]').value"), "openai-compatible");
    assert.match(await p.eval("document.querySelector('.pg-outs .pg-out').textContent"), /Recorded response.*4/s);
    // Edit the user message and run it.
    await p.eval("(() => { const t = document.querySelector('.pg-msg[data-role=user] textarea'); t.value = '3+3?'; t.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await p.eval("[...document.querySelectorAll('.pg-actions button')].find((b) => b.textContent === 'Run').click()");
    await p.waitFor("document.querySelector('.pg-out-slot .pg-out-text')?.textContent === 'echo: 3+3?'", "run output");
    assert.equal(seen.at(-1).messages.at(-1).content, "3+3?");
    assert.equal(seen.at(-1).messages[0].content, "Be terse.");
    // Save with this run's answer as the expected output.
    await p.eval("(() => { const i = document.querySelector('.pg-save input'); i.value = 'arith'; const s = document.querySelector('.pg-save select'); s.value = 'run'; i.form.requestSubmit(); })()");
    await p.waitFor("/arith/.test(document.querySelector('.pg-status').textContent)", "saved");
    assert.match(await p.eval("document.querySelector('.pg-status').textContent"), /^Created dataset arith: version [0-9a-f]{12}, 1 case\.$/);
    const sets = await store.listDatasets();
    assert.deepEqual(sets.map((d) => [d.id, d.cases]), [["arith", 1]]);
    const ds = await store.getDataset("arith");
    assert.deepEqual((ds!.cases[0] as any).expected, { text: "echo: 3+3?", toolCalls: [] });
    assert.deepEqual(p.errors, []);
  });

  test("a bad tool-calls field is named inline and nothing is sent", async () => {
    const p = await open(v, `#/playground/${encodeURIComponent(callId)}?session=${encodeURIComponent(sessionId)}`);
    await p.waitFor("document.querySelector('.pg-msg textarea')", "playground editor");
    const before = seen.length;
    await p.eval("[...document.querySelectorAll('.pg-row button')].find((b) => b.textContent === 'Add assistant message').click()");
    await p.eval("(() => { const t = [...document.querySelectorAll('textarea[data-tool-calls]')].at(-1); t.value = '[{'; })()");
    await p.eval("[...document.querySelectorAll('.pg-actions button')].find((b) => b.textContent === 'Run').click()");
    await p.waitFor("/not valid JSON/.test(document.querySelector('.pg-status').textContent)", "inline error");
    assert.equal(seen.length, before);
    assert.deepEqual(p.errors, []);
  });

  test("phone width fits without sideways scroll", async () => {
    const p = await open(v, `#/playground/${encodeURIComponent(callId)}?session=${encodeURIComponent(sessionId)}`, true);
    await p.waitFor("document.querySelector('.pg-msg textarea')", "playground editor");
    assert.equal(await p.eval("document.documentElement.scrollWidth <= window.innerWidth"), true);
    assert.deepEqual(p.errors, []);
  });

  test("a viewer without the playground hides the link and explains the page", async () => {
    const p = await open(bare, `#/s/${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}`);
    await p.waitFor("document.querySelector('.pg-slot')", "call pane");
    await p.waitFor("document.querySelector('.call-meta, .kpis')", "call details");
    assert.equal(await p.eval("document.querySelector('.pg-slot a')"), null);
    const q = await open(bare, `#/playground/${encodeURIComponent(callId)}`);
    await q.waitFor("document.querySelector('.pg-body h2')", "not available");
    assert.match(await q.eval("document.querySelector('.pg-body h2').textContent"), /local viewer/);
    assert.deepEqual(q.errors.filter((e) => !/404/.test(e)), []);
  });
});
