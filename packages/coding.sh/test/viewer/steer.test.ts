// GET /api/sessions/:id/steer on both `coding.sh ui` (startViewer) and `coding.sh serve` (startServe).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { SteerAdvice } from "../../src/core/steer.ts";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { sessionEvents } from "../helpers-decision.ts";
import { FakeBlobs, FakeIndex } from "./fakes.ts";

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

describe("GET /api/sessions/:id/steer (ui)", () => {
  const index = new FakeIndex();
  const blobs = new FakeBlobs();
  let viewer: Viewer;

  before(async () => {
    const cleanEvents = sessionEvents("ui-clean", { cwd: "/work/demo", startedAt: T0 }, [
      ["session.start", {}],
      ["user.message", { text: "Run tests." }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "ok" }],
    ]);
    await index.putEvents(cleanEvents);
    await index.upsertSession(buildSession(cleanEvents));

    const stuckEvents = sessionEvents("ui-lean", { cwd: "/work/demo", startedAt: T0 + 10_000 }, [
      ["session.start", {}],
      ["user.message", { text: "Prove theorem." }],
      ["file.change", { path: "Proof/Api.lean", op: "modify", diff: diff("Proof/Api.lean", " theorem api : True := by", "+  sorry") }],
      ["tool.start", { tool: "Bash", toolUseId: "l1", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l1", ok: false, output: "Proof/Api.lean:4:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "l2", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l2", ok: false, output: "Proof/Api.lean:5:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "l3", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l3", ok: false, output: "Proof/Api.lean:6:2: error: unsolved goals" }],
    ]);
    await index.putEvents(stuckEvents);
    await index.upsertSession(buildSession(stuckEvents));

    viewer = await startViewer({ index, blobs, port: 0, serverRender: false });
  });

  after(async () => {
    await viewer.close();
  });

  const baseUrl = () => `http://127.0.0.1:${viewer.port}`;

  it("returns 200 with SteerAdvice for clean and intervening sessions", async () => {
    const headers = { authorization: `Bearer ${viewer.token}` };

    const resClean = await fetch(`${baseUrl()}/api/sessions/ui-clean/steer`, { headers });
    assert.equal(resClean.status, 200);
    const clean = (await resClean.json()) as SteerAdvice;
    assert.equal(clean.sessionId, "ui-clean");
    assert.equal(clean.status, "continue");
    assert.equal(clean.suggestedSteer, undefined);

    const resStuck = await fetch(`${baseUrl()}/api/sessions/ui-lean/steer`, { headers });
    assert.equal(resStuck.status, 200);
    const stuck = (await resStuck.json()) as SteerAdvice;
    assert.equal(stuck.sessionId, "ui-lean");
    assert.equal(stuck.status, "intervene");
    assert.equal(stuck.risk, "high");
    assert.ok(stuck.directives.some((d) => d.kind === "break-oscillation"));
    assert.ok(stuck.suggestedSteer?.includes("Proof/Api.lean"));
  });

  it("enforces 401 without auth, 404 on unknown session, and 405 on non-GET", async () => {
    const noAuth = await fetch(`${baseUrl()}/api/sessions/ui-clean/steer`);
    assert.equal(noAuth.status, 401);

    const headers = { authorization: `Bearer ${viewer.token}` };
    const missing = await fetch(`${baseUrl()}/api/sessions/does-not-exist/steer`, { headers });
    assert.equal(missing.status, 404);

    const post = await fetch(`${baseUrl()}/api/sessions/ui-clean/steer`, { method: "POST", headers });
    assert.equal(post.status, 405);
  });
});

describe("GET /api/sessions/:id/steer (serve + project isolation)", () => {
  let root = "";
  let server: ServeHandle | undefined;
  let ingestTeam = "";
  let readAll = "";
  let readTeam = "";
  let readOther = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-serve-steer-"));
    mkdirSync(join(root, "home"));
    ingestTeam = generateKey("ingest");
    readAll = generateKey("read");
    readTeam = generateKey("read");
    readOther = generateKey("read");

    const env: NodeJS.ProcessEnv = {
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      CODING_SH_HOME: join(root, "data"),
      CODING_SH_INGEST_KEYS: `team:${ingestTeam}`,
      CODING_SH_READ_KEYS: `*:${readAll},team:${readTeam},other:${readOther}`,
    };
    const cfg = resolveServeConfig({ port: 0 }, env);
    server = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false });

    const now = Date.now() - 10_000;
    const batch = {
      v: 0,
      service: "steer-bot",
      events: [
        { v: 0, id: "se-1", sessionId: "chat-steer", ts: now, kind: "user.message", payload: { text: "Edit files" } },
        { v: 0, id: "se-2", sessionId: "chat-steer", ts: now + 1000, kind: "file.change", payload: { path: "src/a.ts", op: "modify" } },
        { v: 0, id: "se-3", sessionId: "chat-steer", ts: now + 2000, kind: "file.change", payload: { path: "src/b.ts", op: "modify" } },
        { v: 0, id: "se-4", sessionId: "chat-steer", ts: now + 3000, kind: "file.change", payload: { path: "src/c.ts", op: "modify" } },
      ],
    };
    const ingestRes = await fetch(`${server.url}/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestTeam}`, "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    assert.equal(ingestRes.status, 200);
  });

  after(async () => {
    await server?.shutdown().catch(() => {});
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("answers for * and matching project read keys, and isolates other projects with 404", async () => {
    const path = "/api/sessions/team%2Fchat-steer/steer";

    const unauth = await fetch(server!.url + path);
    assert.equal(unauth.status, 401);

    const wrongKey = await fetch(server!.url + path, { headers: { authorization: `Bearer ${ingestTeam}` } });
    assert.equal(wrongKey.status, 401);

    const wrongMethod = await fetch(server!.url + path, { method: "POST", headers: { authorization: `Bearer ${readAll}` } });
    assert.equal(wrongMethod.status, 405);

    const otherProject = await fetch(server!.url + path, { headers: { authorization: `Bearer ${readOther}` } });
    assert.equal(otherProject.status, 404);

    const teamRes = await fetch(server!.url + path, { headers: { authorization: `Bearer ${readTeam}` } });
    assert.equal(teamRes.status, 200);
    const teamDoc = (await teamRes.json()) as SteerAdvice;
    assert.equal(teamDoc.sessionId, "team/chat-steer");
    assert.equal(teamDoc.status, "nudge");
    assert.ok(teamDoc.directives.some((d) => d.kind === "verify-now"));

    const allRes = await fetch(server!.url + path, { headers: { authorization: `Bearer ${readAll}` } });
    assert.equal(allRes.status, 200);
    assert.equal(((await allRes.json()) as SteerAdvice).sessionId, "team/chat-steer");
  });
});
