// Live Steer Advisor Card in the viewer (#/s/<id> and #/w/<id>):
// zero-noise gating on healthy sessions/items, collapsible card (expanded on intervene,
// collapsed on nudge), copyable suggestedSteer + handoff hint, causeSessionId lookup
// on #/w/<id>, and strict XSS escaping in headless Chrome.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { workItemId } from "../../src/core/work.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";

const CWD = "/work/demo";
const MIN = 60e3;
const CLI = process.platform === "win32" ? "codingsh" : "coding\\.sh";
const XSS_PAYLOAD = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';

type Step = [AgentEvent["kind"], Record<string, unknown>, { durationMs?: number; tsOffsetMs?: number }?];

const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

function makeTrace(id: string, startTs: number, steps: Step[], overrides?: Partial<Session>) {
  let ts = startTs;
  const events: AgentEvent[] = steps.map(([kind, payload, extra], i) => {
    ts += extra?.tsOffsetMs ?? 1000;
    const ev: AgentEvent = {
      id: `${id}-e${i + 1}`,
      v: 0,
      sessionId: id,
      ts,
      agent: "claude-code",
      cwd: CWD,
      kind,
      payload,
    };
    if (extra?.durationMs !== undefined) ev.durationMs = extra.durationMs;
    return ev;
  });
  const base = buildSession(events);
  const session: Session = overrides
    ? { ...base, ...overrides, stats: overrides.stats ? { ...base.stats, ...overrides.stats } : base.stats }
    : base;
  return { session, events };
}

function interveneLeanTrace(id: string, startTs: number, file = "Proof/Api.lean", overrides?: Partial<Session>) {
  return makeTrace(
    id,
    startTs,
    [
      ["session.start", {}],
      ["user.message", { text: `Prove theorem in ${file}` }],
      ["file.change", { path: file, op: "modify", diff: diff(file, " theorem api : True := by", "+  sorry") }],
      ["tool.start", { tool: "Bash", toolUseId: "l1", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l1", ok: false, output: `${file}:4:2: error: unsolved goals` }],
      ["tool.start", { tool: "Bash", toolUseId: "l2", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l2", ok: false, output: `${file}:5:2: error: unsolved goals` }],
      ["tool.start", { tool: "Bash", toolUseId: "l3", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l3", ok: false, output: `${file}:6:2: error: unsolved goals` }],
    ],
    { title: `Prove theorem in ${file}`, ...overrides },
  );
}

function nudgeUnverifiedTrace(id: string, startTs: number) {
  return makeTrace(
    id,
    startTs,
    [
      ["session.start", {}],
      ["user.message", { text: "Refactor helpers" }],
      ["file.change", { path: "src/a.ts", op: "modify", diff: diff("src/a.ts", "-export const a = 1;", "+export const a = 2;") }],
      ["file.change", { path: "src/b.ts", op: "modify", diff: diff("src/b.ts", "-export const b = 1;", "+export const b = 2;") }],
      ["file.change", { path: "src/c.ts", op: "modify", diff: diff("src/c.ts", "-export const c = 1;", "+export const c = 2;") }],
      ["assistant.message", { text: "Updated helpers." }],
    ],
    { title: "Refactor helpers without running checks" },
  );
}

function resetContextTrace(id: string, startTs: number) {
  return makeTrace(
    id,
    startTs,
    [
      ["session.start", {}],
      ["user.message", { text: "Fix failing suite" }],
      ["tool.start", { tool: "Bash", toolUseId: "r1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "r1", ok: false, output: "AssertionError: expected 1 to equal 2" }],
      ["context.compact", { trigger: "auto" }],
      ["tool.start", { tool: "Bash", toolUseId: "r2", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "r2", ok: false, output: "AssertionError: expected 1 to equal 2" }],
      ["tool.start", { tool: "Bash", toolUseId: "r3", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "r3", ok: false, output: "AssertionError: expected 1 to equal 2" }],
      ["tool.start", { tool: "Bash", toolUseId: "r4", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "r4", ok: false, output: "AssertionError: expected 1 to equal 2" }],
    ],
    { title: "Fix failing suite after compaction" },
  );
}

function cleanTrace(id: string, startTs: number) {
  return makeTrace(
    id,
    startTs,
    [
      ["session.start", {}],
      ["user.message", { text: "Run tests" }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "all passed" }],
      ["assistant.message", { text: "All tests pass." }],
    ],
    { title: "Clean passing session" },
  );
}

function xssWaitingTrace(id: string, startTs: number, now: number) {
  return makeTrace(
    id,
    startTs,
    [
      ["session.start", {}],
      ["user.message", { text: "Deploy build" }],
      ["assistant.message", { text: "Waiting for permission." }],
    ],
    {
      title: "XSS waiting session",
      endedAt: undefined,
      stats: {
        waiting: {
          kind: "permission",
          at: now - 2 * MIN,
          toolUseId: "w1",
          text: XSS_PAYLOAD,
        },
      } as never,
    },
  );
}

function workParentTraces(now: number) {
  const parent = makeTrace(
    "work-parent",
    now - 20 * MIN,
    [
      ["session.start", {}],
      ["user.message", { text: "Prove helper lemmas" }],
      ["assistant.message", { text: "Delegated proof to subagent." }],
    ],
    { title: "Prove helper lemmas", endedAt: undefined },
  );
  const child = interveneLeanTrace("work-parent:sub:a1", now - 18 * MIN, "Proof/Sub.lean", {
    parent: { sessionId: "work-parent", subagentId: "a1" },
    endedAt: undefined,
  });
  // Preserve folded verification/contextHygiene while adding a blocking wait on the subagent so work sets causeSessionId = child.
  child.session = {
    ...child.session,
    stats: {
      ...buildSession(child.events).stats,
      waiting: {
        kind: "permission",
        at: now - 3 * MIN,
        toolUseId: "sub-w1",
        text: "Approve lake build on Proof/Sub.lean",
      },
    },
  };
  return [parent, child];
}

function workCleanTrace(id: string, now: number) {
  const tr = makeTrace(
    id,
    now - 30 * MIN,
    [
      ["session.start", {}],
      ["user.message", { text: "Update README typo" }],
      ["file.change", { path: "README.md", op: "modify", diff: diff("README.md", "-teh", "+the") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "ok" }],
      ["assistant.message", { text: "Fixed typo." }],
    ],
    { title: "Update README typo", endedAt: now - 25 * MIN },
  );
  return tr;
}

describe("Live Steer fixtures HTTP contract", () => {
  const index = new MemoryIndexStore();
  const now = Date.now();
  let v: Viewer;

  before(async () => {
    const traces = [
      interveneLeanTrace("intervene-http", now - 25 * MIN),
      nudgeUnverifiedTrace("nudge-http", now - 22 * MIN),
      resetContextTrace("reset-http", now - 20 * MIN),
      cleanTrace("clean-http", now - 18 * MIN),
    ];
    for (const { session, events } of traces) {
      await index.upsertSession(session);
      await index.putEvents(events);
    }
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      updateStatus: async () => ({ disabled: "test" }) as never,
    });
  });

  after(async () => {
    await v?.close();
  });

  async function getSteer(id: string) {
    const res = await fetch(`http://127.0.0.1:${v.port}/api/sessions/${encodeURIComponent(id)}/steer`, {
      headers: { authorization: `Bearer ${v.token}` },
    });
    assert.equal(res.status, 200);
    return res.json();
  }

  test("returns intervene, nudge, reset-context, and continue advice", async () => {
    const inter = await getSteer("intervene-http");
    assert.equal(inter.status, "intervene");
    assert.equal(inter.risk, "high");
    assert.ok(inter.directives.some((d: { kind: string }) => d.kind === "break-oscillation"));
    assert.match(inter.suggestedSteer, /Proof\/Api\.lean/);

    const nudge = await getSteer("nudge-http");
    assert.equal(nudge.status, "nudge");
    assert.equal(nudge.risk, "medium");
    assert.ok(nudge.directives.some((d: { kind: string }) => d.kind === "verify-now"));
    assert.ok(nudge.suggestedSteer);

    const reset = await getSteer("reset-http");
    assert.equal(reset.status, "intervene");
    assert.ok(reset.directives.some((d: { kind: string }) => d.kind === "reset-context"));

    const clean = await getSteer("clean-http");
    assert.equal(clean.status, "continue");
    assert.equal(clean.suggestedSteer, undefined);
  });
});

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

describe(
  "Live Steer Advisor Card in a browser",
  { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" },
  () => {
    const index = new MemoryIndexStore();
    const now = Date.now();
    let dir = "";
    let v: Viewer;
    let browser: Browser;
    let page: Page | undefined;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), "steer-browser-"));
      const traces = [
        interveneLeanTrace("intervene-ui", now - 40 * MIN),
        nudgeUnverifiedTrace("nudge-ui", now - 35 * MIN),
        resetContextTrace("reset-ui", now - 32 * MIN),
        cleanTrace("clean-ui", now - 28 * MIN),
        xssWaitingTrace("xss-ui", now - 6 * MIN, now),
        ...workParentTraces(now),
        workCleanTrace("work-clean", now),
      ];
      for (const { session, events } of traces) {
        await index.upsertSession(session);
        await index.putEvents(events);
      }
      v = await startViewer({
        index,
        blobs: new FakeBlobs(),
        port: 0,
        updateStatus: async () => ({ disabled: "test" }) as never,
        work: { overlay: join(dir, "work.json"), home: dir, cwd: dir },
      });
      browser = await launchBrowser(chrome!);
    });

    after(async () => {
      await page?.close();
      await browser?.close();
      await v?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    async function openSession(hash: string): Promise<Page> {
      await page?.close();
      page = await browser.newPage();
      await page.viewport(1280, 900);
      await page.goto(v.url + hash);
      await page.waitFor("document.querySelector('#steps .st')", "session steps");
      return page;
    }

    async function openWork(hash: string, mobile = false): Promise<Page> {
      await page?.close();
      page = await browser.newPage();
      if (mobile) await page.viewport(390, 844, true);
      else await page.viewport(1280, 900);
      await page.goto(v.url + hash);
      await page.waitFor("document.querySelector('.work-page .work-kv')", "work item page");
      return page;
    }

    test("intervening session on #/s/<id> fetches /steer and renders expanded card with directives and copyable prompt", async () => {
      const p = await openSession("#/s/intervene-ui");
      await p.waitFor("document.querySelector('.steer-card [data-steer=prompt]')", "steer card loaded");

      assert.equal(await p.eval("document.querySelector('.steer-card').open"), true, "expanded by default on intervene");
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=status]').textContent"), "intervene");
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=status]').classList.contains('fail')"), true);
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=risk]').textContent"), "risk: high");

      const kinds: string[] = await p.eval("[...document.querySelectorAll('.steer-card [data-steer=kind]')].map((el) => el.textContent)");
      assert.ok(kinds.includes("break-oscillation"), `expected break-oscillation in ${kinds}`);

      const promptText: string = await p.eval("document.querySelector('.steer-card [data-steer=prompt]').textContent");
      assert.match(promptText, /Proof\/Api\.lean/);

      // Stub clipboard and verify Copy steer button copies suggestedSteer and shows Copied confirmation.
      await p.eval(`(() => {
        window.__copied = "";
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
        });
      })()`);
      await p.eval("document.querySelector('.steer-card [data-steer=copy]').click()");
      await p.waitFor("document.querySelector('.steer-card [data-steer=copy]').textContent === 'Copied'", "copy confirmation");
      assert.equal(await p.eval("window.__copied"), promptText);

      // Toggle collapse and re-expand.
      await p.eval("document.querySelector('.steer-card > summary').click()");
      await p.waitFor("document.querySelector('.steer-card').open === false", "card collapsed");
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=toggle]').textContent"), "Show");

      const steerReqs: string[] = await p.eval(
        "performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/api/sessions/intervene-ui/steer'))",
      );
      assert.equal(steerReqs.length, 1);
      assert.deepEqual(p.errors, []);
    });

    test("nudge session on #/s/<id> renders collapsed by default with warn badge", async () => {
      const p = await openSession("#/s/nudge-ui");
      await p.waitFor("document.querySelector('.steer-card [data-steer=status]')", "nudge steer card loaded");

      assert.equal(await p.eval("document.querySelector('.steer-card').open"), false, "collapsed by default on nudge");
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=status]').textContent"), "nudge");
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=status]').classList.contains('warn')"), true);
      assert.equal(await p.eval("document.querySelector('.steer-card [data-steer=toggle]').textContent"), "Show");

      await p.eval("document.querySelector('.steer-card > summary').click()");
      await p.waitFor("document.querySelector('.steer-card').open === true", "nudge card expanded");
      const kinds: string[] = await p.eval("[...document.querySelectorAll('.steer-card [data-steer=kind]')].map((el) => el.textContent)");
      assert.deepEqual(kinds, ["verify-now"]);
      assert.deepEqual(p.errors, []);
    });

    test("reset-context session on #/s/<id> renders a copyable handoff command hint", async () => {
      const p = await openSession("#/s/reset-ui");
      await p.waitFor("document.querySelector('.steer-card [data-steer=handoff] code')", "handoff hint rendered");
      const cmd: string = await p.eval("document.querySelector('.steer-card [data-steer=handoff] code').textContent");
      assert.match(cmd, new RegExp(`^${CLI} handoff `));
      assert.deepEqual(p.errors, []);
    });

    test("clean non-risk session on #/s/<id> stays hidden and makes zero /steer requests", async () => {
      const p = await openSession("#/s/clean-ui");
      assert.equal(await p.eval("document.querySelector('.steer-card')"), null);
      const steerReqs: string[] = await p.eval(
        "performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/steer'))",
      );
      assert.deepEqual(steerReqs, []);
      assert.deepEqual(p.errors, []);
    });

    test("high-risk / failed work item on #/w/<id> fetches /steer for its causeSessionId and renders the card", async () => {
      const id = workItemId("work-parent");
      const p = await openWork(`#/w/${id}`);
      await p.waitFor("document.querySelector('.work-steer [data-steer=prompt]')", "work steer card loaded");

      assert.equal(await p.eval("document.querySelector('.work-steer [data-steer=status]').textContent"), "intervene");
      const promptText: string = await p.eval("document.querySelector('.work-steer [data-steer=prompt]').textContent");
      assert.match(promptText, /Proof\/Sub\.lean/);

      const steerReqs: string[] = await p.eval(
        "performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/steer'))",
      );
      assert.equal(steerReqs.length, 1);
      assert.match(steerReqs[0]!, /\/api\/sessions\/work-parent%3Asub%3Aa1\/steer$/);
      assert.deepEqual(p.errors, []);

      // Verify mobile layout has no horizontal overflow with the Live Steer card present.
      const m = await openWork(`#/w/${id}`, true);
      await m.waitFor("document.querySelector('.work-steer [data-steer=prompt]')", "mobile work steer card loaded");
      assert.equal(await m.eval("document.documentElement.scrollWidth <= innerWidth"), true, "no sideways scroll on phone");
      assert.deepEqual(m.errors, []);
    });

    test("clean work item on #/w/<id> stays hidden and makes zero /steer requests", async () => {
      const id = workItemId("work-clean");
      const p = await openWork(`#/w/${id}`);
      assert.equal(await p.eval("document.querySelector('.work-steer')"), null);
      const steerReqs: string[] = await p.eval(
        "performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/steer'))",
      );
      assert.deepEqual(steerReqs, []);
      assert.deepEqual(p.errors, []);
    });

    test("escapes HTML tags in evidence and suggestedSteer literally without executing scripts", async () => {
      const s = await openSession("#/s/xss-ui");
      await s.waitFor("document.querySelector('.steer-card [data-steer=prompt]')", "xss session steer card");
      assert.equal(await s.eval("window.__xss"), undefined);
      assert.equal(await s.eval("document.querySelectorAll('.steer-card img, .steer-card script').length"), 0);
      const evText: string = await s.eval("document.querySelector('.steer-card [data-steer=evidence]').textContent");
      const promptText: string = await s.eval("document.querySelector('.steer-card [data-steer=prompt]').textContent");
      assert.ok(evText.includes('<img src=x onerror="window.__xss=1">'), `expected literal HTML in evidence: ${evText}`);
      assert.ok(promptText.includes('<img src=x onerror="window.__xss=1">'), `expected literal HTML in prompt: ${promptText}`);
      assert.deepEqual(s.errors, []);

      const wid = workItemId("xss-ui");
      const w = await openWork(`#/w/${wid}`);
      await w.waitFor("document.querySelector('.work-steer [data-steer=prompt]')", "xss work steer card");
      assert.equal(await w.eval("window.__xss"), undefined);
      assert.equal(await w.eval("document.querySelectorAll('.work-steer img, .work-steer script').length"), 0);
      const wPrompt: string = await w.eval("document.querySelector('.work-steer [data-steer=prompt]').textContent");
      assert.ok(wPrompt.includes('<img src=x onerror="window.__xss=1">'));
      assert.deepEqual(w.errors, []);
    });
  },
);
