// GET /api/sessions/:id/proof (ui + serve project isolation, verdicts, milestones, redaction)
// and the #/s/<id> Verification/Context Hygiene strip + Proof Review Card in headless Chrome.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";

const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
const CWD = "/work/demo";

type Step = [AgentEvent["kind"], Record<string, unknown>, { durationMs?: number; tsOffsetMs?: number }?];

const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

function makeTrace(id: string, steps: Step[], overrides?: Partial<Session>) {
  let ts = T0;
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

function leanVerifiedTrace(id: string) {
  return makeTrace(
    id,
    [
      ["session.start", {}],
      ["user.message", { text: "Prove add_zero in Proof/Add.lean" }],
      ["file.change", { path: "Proof/Add.lean", op: "modify", diff: diff("Proof/Add.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  sorry", "+  simp") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: false, output: "Proof/Add.lean:2:2: error: simp made no progress" }, { durationMs: 4200 }],
      ["file.change", { path: "Proof/Add.lean", op: "modify", diff: diff("Proof/Add.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  simp", "+  omega") }],
      ["tool.start", { tool: "Bash", toolUseId: "c2", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c2", ok: true, output: "" }, { durationMs: 800 }],
      ["assistant.message", { text: "Proof verified." }],
    ],
    {
      title: "Prove add_zero in Lean",
      stats: {
        contextHygiene: { supervisionRisk: "high", riskReasons: ["tactic-oscillation"] },
      } as never,
    },
  );
}

function leanIncompleteTrace(id: string) {
  return makeTrace(id, [
    ["session.start", {}],
    ["user.message", { text: "Start lemma" }],
    ["file.change", { path: "Proof/Main.lean", op: "modify", diff: diff("Proof/Main.lean", " theorem t : 1 = 1 := by", "-  rfl", "+  sorry") }],
    ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake env lean Proof/Main.lean" } }],
    ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "warning: declaration uses 'sorry'" }, { durationMs: 600 }],
  ]);
}

function dafnyTamperedTrace(id: string) {
  return makeTrace(id, [
    ["session.start", {}],
    ["user.message", { text: "Verify Sort.dfy" }],
    ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "dafny verify src/Sort.dfy" } }],
    ["tool.end", { tool: "Bash", toolUseId: "c1", ok: false, output: "src/Sort.dfy(8,0): Error: a postcondition could not be proved" }, { durationMs: 1200 }],
    ["file.change", { path: "src/Sort.dfy", op: "modify", diff: diff("src/Sort.dfy", " method Sort(a: array<int>)", "-  ensures Sorted(a)", "  ensures a.Length >= 0", " {") }],
    ["tool.start", { tool: "Bash", toolUseId: "c2", input: { command: "dafny verify src/Sort.dfy" } }],
    ["tool.end", { tool: "Bash", toolUseId: "c2", ok: true, output: "Dafny program verifier finished with 1 verified, 0 errors" }, { durationMs: 900 }],
  ]);
}

function plainSessionTrace(id: string) {
  return makeTrace(id, [
    ["session.start", {}],
    ["user.message", { text: "Say hello" }],
    ["assistant.message", { text: "Hello there." }],
  ]);
}

describe("GET /api/sessions/:id/proof in viewer ui", () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  const secretKey = ["sk-ant-api03-", "Z".repeat(40)].join("");

  before(async () => {
    const traces = [
      leanVerifiedTrace("s-verified"),
      leanIncompleteTrace("s-incomplete"),
      dafnyTamperedTrace("s-tampered"),
      plainSessionTrace("s-plain"),
      makeTrace("s-secret", [
        ["session.start", {}],
        ["file.change", { path: `specs/${secretKey}.lean`, op: "modify", diff: diff(`specs/${secretKey}.lean`, "-theorem a : True := trivial", "+theorem a : True := trivial") }],
        ["file.change", { path: `specs/${secretKey}.lean`, op: "modify", diff: diff(`specs/${secretKey}.lean`, "-def specVal := 1", "+def specVal := 2") }],
      ]),
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

  async function apiGet(path: string, opts?: { method?: string; auth?: boolean }) {
    const headers: Record<string, string> = {};
    if (opts?.auth !== false) headers.authorization = `Bearer ${v.token}`;
    const res = await fetch(`http://127.0.0.1:${v.port}${path}`, { method: opts?.method ?? "GET", headers });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) };
  }

  test("returns verified report with ordered milestones and eventIds", async () => {
    const r = await apiGet("/api/sessions/s-verified/proof");
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.sessionId, "s-verified");
    assert.equal(body.verdict, "verified");
    assert.deepEqual(body.langs, ["lean"]);
    assert.deepEqual(body.proofFiles, ["Proof/Add.lean"]);
    assert.equal(body.specUntouched, true);
    assert.deepEqual(body.escapes, { added: 0, removed: 1, remaining: 0, kinds: [] });
    assert.deepEqual(body.checks, { total: 2, passed: 1, failed: 1, wholeProject: 1, lastOk: true, medianMs: 2500 });
    assert.deepEqual(body.tamperFindings, []);
    assert.match(body.verifyHints[0], /lake env lean Proof\/Add\.lean/);
    assert.match(body.verifyHints[0], /#print axioms/);
    assert.equal(body.diskCheck, undefined);
    assert.deepEqual(body.milestones, [
      { eventId: "s-verified-e5", ts: T0 + 5000, ok: false, lang: "lean", wholeProject: true, durationMs: 4200 },
      { eventId: "s-verified-e8", ts: T0 + 8000, ok: true, lang: "lean", wholeProject: false, durationMs: 800 },
    ]);
  });

  test("returns incomplete, tampered, and no-proof verdicts", async () => {
    const inc = await apiGet("/api/sessions/s-incomplete/proof");
    assert.equal(inc.status, 200);
    assert.equal(inc.json().verdict, "incomplete");
    assert.deepEqual(inc.json().escapes, { added: 1, removed: 0, remaining: 1, kinds: ["sorry"] });
    assert.equal(inc.json().milestones.length, 1);
    assert.equal(inc.json().milestones[0].eventId, "s-incomplete-e5");

    const tamp = await apiGet("/api/sessions/s-tampered/proof");
    assert.equal(tamp.status, 200);
    assert.equal(tamp.json().verdict, "tampered");
    assert.equal(tamp.json().specUntouched, false);
    assert.deepEqual(tamp.json().specFilesTouched, ["src/Sort.dfy"]);
    assert.ok(tamp.json().tamperFindings.some((f: { kind: string }) => f.kind === "statement"));
    assert.equal(tamp.json().milestones.length, 2);

    const plain = await apiGet("/api/sessions/s-plain/proof");
    assert.equal(plain.status, 200);
    assert.equal(plain.json().verdict, "no-proof");
    assert.deepEqual(plain.json().langs, []);
    assert.equal(plain.json().milestones, undefined);
  });

  test("redacts secrets in tamper findings and hints", async () => {
    const r = await apiGet("/api/sessions/s-secret/proof");
    assert.equal(r.status, 200);
    assert.equal(r.json().verdict, "tampered");
    assert.ok(!r.text.includes(secretKey), "secret is redacted from the proof response");
  });

  test("returns 404 for unknown session, 401 without auth, and 405 for non-GET", async () => {
    assert.equal((await apiGet("/api/sessions/does-not-exist/proof")).status, 404);
    assert.equal((await apiGet("/api/sessions/s-verified/proof", { auth: false })).status, 401);
    assert.equal((await apiGet("/api/sessions/s-verified/proof", { method: "POST" })).status, 405);
  });
});

describe("GET /api/sessions/:id/proof in serve mode with project-scoped read keys", () => {
  let root = "";
  let server: ServeHandle | undefined;
  let teamIngest = "";
  let teamRead = "";
  let supportRead = "";
  let allRead = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-serve-proof-"));
    mkdirSync(join(root, "home"));
    teamIngest = generateKey("ingest");
    teamRead = generateKey("read");
    supportRead = generateKey("read");
    allRead = generateKey("read");

    const cfg = resolveServeConfig(
      { port: 0 },
      {
        HOME: join(root, "home"),
        CODING_SH_HOME: join(root, "data"),
        CODING_SH_INGEST_KEYS: `team:${teamIngest}`,
        CODING_SH_READ_KEYS: `*:${allRead},team:${teamRead},support:${supportRead}`,
      },
    );
    server = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false });

    const now = Date.now();
    const res = await fetch(`${server.url}/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${teamIngest}`, "content-type": "application/json" },
      body: JSON.stringify({
        v: 0,
        service: "prover",
        events: [
          { v: 0, id: "p-1", sessionId: "lean-1", ts: now - 4000, kind: "file.change", payload: { path: "Proof/Add.lean", op: "modify", diff: diff("Proof/Add.lean", " theorem t : True := by", "-  sorry", "+  trivial") } },
          { v: 0, id: "p-2", sessionId: "lean-1", ts: now - 3000, kind: "tool.start", payload: { tool: "Bash", toolUseId: "c1", input: { command: "lake env lean Proof/Add.lean" } } },
          { v: 0, id: "p-3", sessionId: "lean-1", ts: now - 2000, durationMs: 500, kind: "tool.end", payload: { tool: "Bash", toolUseId: "c1", ok: true, output: "" } },
        ],
      }),
    });
    assert.equal(res.status, 200);
  });

  after(async () => {
    await server?.shutdown().catch(() => {});
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("enforces read key auth and project isolation without disk I/O", async () => {
    const path = "/api/sessions/team%2Flean-1/proof";
    const unauth = await fetch(server!.url + path);
    assert.equal(unauth.status, 401);

    const wrongProj = await fetch(server!.url + path, { headers: { authorization: `Bearer ${supportRead}` } });
    assert.equal(wrongProj.status, 404);

    const rightProj = await fetch(server!.url + path, { headers: { authorization: `Bearer ${teamRead}` } });
    assert.equal(rightProj.status, 200);
    const body = await rightProj.json();
    assert.equal(body.sessionId, "team/lean-1");
    assert.equal(body.verdict, "verified");
    assert.equal(body.diskCheck, undefined);
    assert.equal(body.milestones.length, 1);

    const star = await fetch(server!.url + path, { headers: { authorization: `Bearer ${allRead}` } });
    assert.equal(star.status, 200);
    assert.equal((await star.json()).verdict, "verified");
  });
});

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

describe("Proof Review Card and Verification/Hygiene strip in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    for (const trace of [leanVerifiedTrace("lean-ui"), dafnyTamperedTrace("dafny-ui"), plainSessionTrace("plain-ui")]) {
      await index.upsertSession(trace.session);
      await index.putEvents(trace.events);
    }
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      updateStatus: async () => ({ disabled: "test" }) as never,
    });
    browser = await launchBrowser(chrome!);
  });

  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor("document.querySelector('#steps .st')", "session steps");
    return page;
  }

  test("renders Verification/Risk strip and Proof Review Card on Lean session, and milestone clicks jump to timeline steps", async () => {
    const p = await open("#/s/lean-ui");
    await p.waitFor("document.querySelector('.proof-card [data-proof=verdict]')", "proof card loaded");

    // Verification & Context Hygiene strip in header.
    const strip: string = await p.eval("document.querySelector('.vh-strip').textContent");
    assert.match(strip, /Checks: 1\/2/);
    assert.match(strip, /max blind streak: 1/);
    assert.match(strip, /Risk: high \(tactic-oscillation\)/);

    // Proof Review Card contents.
    assert.equal(await p.eval("document.querySelector('[data-proof=verdict]').textContent"), "verified");
    assert.equal(await p.eval("document.querySelector('[data-proof=verdict]').classList.contains('pass')"), true);
    assert.equal(await p.eval("document.querySelector('[data-proof=langs]').textContent"), "lean");
    assert.equal(await p.eval("document.querySelector('[data-proof=spec]').textContent"), "Spec untouched");
    assert.equal(await p.eval("document.querySelector('[data-proof=escapes]').textContent"), "0 remaining");
    const checksText: string = await p.eval("document.querySelector('[data-proof=checks]').textContent");
    assert.match(checksText, /1\/2 passed/);
    assert.match(checksText, /1 whole-project/);

    const hintText: string = await p.eval("document.querySelector('.proof-hints code').textContent");
    assert.match(hintText, /lake env lean Proof\/Add\.lean/);
    assert.match(hintText, /#print axioms/);

    // Milestone pills: #1 fail, #2 pass.
    const msLabels: string[] = await p.eval("[...document.querySelectorAll('.proof-ms')].map((b) => b.textContent)");
    assert.deepEqual(msLabels, ["#1 fail", "#2 pass"]);

    // Click #2 pass milestone and verify timeline jumps to the second checker step.
    await p.eval("document.querySelectorAll('.proof-ms')[1].click()");
    await p.waitFor("/lake env lean Proof\\/Add\\.lean/.test(document.querySelector('#steps .st[aria-selected=true]')?.textContent ?? '')", "jumped to milestone #2");

    // Click #1 fail milestone and verify timeline jumps to the first checker step.
    await p.eval("document.querySelectorAll('.proof-ms')[0].click()");
    await p.waitFor("/lake build/.test(document.querySelector('#steps .st[aria-selected=true]')?.textContent ?? '')", "jumped to milestone #1");

    assert.deepEqual(p.errors, []);
  });

  test("renders tampered verdict and tamper findings on tampered proof session", async () => {
    const p = await open("#/s/dafny-ui");
    await p.waitFor("document.querySelector('.proof-card [data-proof=verdict]')", "tampered proof card");
    assert.equal(await p.eval("document.querySelector('[data-proof=verdict]').textContent"), "tampered");
    assert.equal(await p.eval("document.querySelector('[data-proof=verdict]').classList.contains('fail')"), true);
    assert.equal(await p.eval("document.querySelector('[data-proof=spec]').textContent"), "1 spec file touched");
    const findings: string = await p.eval("document.querySelector('.proof-tamper').textContent");
    assert.match(findings, /statement/);
    assert.match(findings, /weakened/);
    assert.deepEqual(p.errors, []);
  });

  test("stays hidden and makes zero /proof requests on a plain non-proof session", async () => {
    const p = await open("#/s/plain-ui");
    assert.equal(await p.eval("document.querySelector('.vh-strip')"), null);
    assert.equal(await p.eval("document.querySelector('.proof-card')"), null);
    const proofReqs: string[] = await p.eval("performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/proof'))");
    assert.deepEqual(proofReqs, []);
    assert.deepEqual(p.errors, []);
  });
});
