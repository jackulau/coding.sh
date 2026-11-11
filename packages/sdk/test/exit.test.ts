// A process whose explicit flush() gave up on an unreachable server exits at once: no second
// bounded flush at exit and no retry timer keeping it alive.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts")).href;

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function run(script: string, env: Record<string, string>): Promise<{ end: number; code: number | null; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "csh-sdk-exit-"));
  const file = join(dir, "app.ts");
  writeFileSync(file, script);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", file], { env: { PATH: dirname(process.execPath), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("close", (code) => {
      clearTimeout(kill);
      rmSync(dir, { recursive: true, force: true });
      resolve({ end: Date.now(), code, stdout, stderr });
    });
  });
}

test("exits promptly after flush() timed out against an unreachable server, and says what was dropped", async () => {
  const port = await deadPort();
  const r = await run(
    `import { init, trace, flush } from ${JSON.stringify(src)};
     init({ flushIntervalMs: 10 });
     trace("t", () => 1);
     const drained = await flush(1000);
     process.stdout.write(drained + " " + Date.now());`,
    { CODING_SH_URL: `http://127.0.0.1:${port}` },
  );
  assert.equal(r.code, 0, r.stderr);
  const [drained, flushedAt] = r.stdout.split(" ");
  assert.equal(drained, "false");
  const lingered = r.end - Number(flushedAt);
  assert.ok(lingered < 750, `the process stayed ${lingered} ms after flush() gave up`);
  assert.equal((r.stderr.match(/\[coding\.sh\]/g) ?? []).length, 1, r.stderr);
  assert.match(r.stderr, /not sent|dropp/i);
});

test("exits promptly after flush() timed out against a server that accepts and never answers", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const hang = createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => undefined);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const port = (hang.address() as { port: number }).port;
  try {
    const r = await run(
      `import { init, trace, flush } from ${JSON.stringify(src)};
       init({ flushIntervalMs: 10 });
       trace("t", () => 1);
       const drained = await flush(1000);
       process.stdout.write(drained + " " + Date.now());`,
      { CODING_SH_URL: `http://127.0.0.1:${port}` },
    );
    assert.equal(r.code, 0, r.stderr);
    const [drained, flushedAt] = r.stdout.split(" ");
    assert.equal(drained, "false");
    const lingered = r.end - Number(flushedAt);
    assert.ok(lingered < 2000, `the process stayed ${lingered} ms after flush() gave up (the request in flight held it open)`);
    assert.match(r.stderr, /did not answer/);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hang.close(() => r()));
  }
});

test("with no explicit flush, the exit flush still sends what is queued", async () => {
  const { createServer: http } = await import("node:http");
  const got: string[] = [];
  const server = http((req, res) => {
    req.on("data", (d) => got.push(String(d.length)));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const r = await run(`import { init, trace } from ${JSON.stringify(src)};\ninit({ flushIntervalMs: 60000 });\ntrace("t", () => 1);`, { CODING_SH_URL: `http://127.0.0.1:${port}` });
  await new Promise<void>((res) => server.close(() => res()));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(got.length >= 1, "the queued events were sent at exit");
});
