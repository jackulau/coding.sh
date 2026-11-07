import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { startViewer } from "../../src/viewer/server.ts";
import type { UpdateStatus } from "../../src/update/index.ts";
import { FakeBlobs, FakeIndex } from "../viewer/fakes.ts";
import { tmpEnv } from "./helpers.ts";

function get(port: number, path: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (token) headers.authorization = `Bearer ${token}`;
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let s = "";
      res.on("data", (c: Buffer) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : null }));
    })
      .on("error", reject)
      .end();
  });
}

const status = (o: Partial<UpdateStatus>): UpdateStatus => ({
  current: "0.1.0",
  latest: "0.2.0",
  updateAvailable: true,
  url: "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0",
  notes: "<img src=x onerror=alert(1)>",
  install: "https://example.test/x.tgz",
  checkedAt: 1,
  disabled: null,
  error: null,
  command: "coding.sh update",
  ...o,
});

test("/api/update serves the version fields only, behind the token", async () => {
  let s = status({});
  const v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, updateStatus: async () => s });
  try {
    assert.equal((await get(v.port, "/api/update")).status, 401);
    const r = await get(v.port, "/api/update", v.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { current: "0.1.0", latest: "0.2.0", updateAvailable: true, url: s.url, command: "coding.sh update", checkedAt: 1 });
    s = status({ disabled: "config" });
    assert.equal((await get(v.port, "/api/update", v.token)).body.updateAvailable, false, "an opt-out hides the pill");
    assert.equal((await get(v.port, "/api/update/x", v.token)).status, 404);
  } finally {
    await v.close();
  }
});

test("/api/update defaults to getUpdateStatus(env) and does no network when opted out", async () => {
  const env = tmpEnv({ CODING_SH_NO_UPDATE_CHECK: "1" });
  const v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, env });
  try {
    const r = await get(v.port, "/api/update", v.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.updateAvailable, false);
    assert.equal(r.body.latest, null);
    assert.equal(r.body.command, "coding.sh update");
  } finally {
    await v.close();
  }
});

test("the header pill reads /api/update and renders text only", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /<button class="update-pill" id="update" type="button" hidden>/);
  assert.match(html, /fetch\("\/api\/update"/);
  assert.match(html, /copy\("coding\.sh update"\)/);
});
