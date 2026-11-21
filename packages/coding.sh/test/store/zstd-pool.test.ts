import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { zstdDecompressSync } from "node:zlib";
import { describe, it } from "node:test";
import { ZstdPool, zstdFrame } from "../../src/store/zstd-pool.ts";
import { tsNodeArgs } from "../capture/_helpers.ts";

const inputs = (): Uint8Array[] => [
  new Uint8Array(0),
  new TextEncoder().encode("hello"),
  new TextEncoder().encode(JSON.stringify({ tool: "Bash", input: { command: "ls -la" } }).repeat(20)),
  randomBytes(3000),
  ...Array.from({ length: 300 }, (_, i) => new TextEncoder().encode(`event ${i} `.repeat(i % 40))),
];

describe("ZstdPool", () => {
  it("writes the frames zstdCompressSync writes at the same level, byte for byte, across batches", async () => {
    for (const level of [3, 19]) {
      const pool = new ZstdPool(level);
      try {
        const ins = inputs();
        const frames = await Promise.all(ins.map((b) => pool.compress(b)));
        for (const [i, f] of frames.entries()) {
          assert.deepEqual(Buffer.from(f), Buffer.from(zstdFrame(ins[i]!, level)), `input ${i} at level ${level}`);
          assert.deepEqual(Buffer.from(zstdDecompressSync(f)), Buffer.from(ins[i]!));
        }
      } finally {
        await pool.close();
      }
    }
  });

  it("compresses on this thread what a dead worker had, and everything after", async () => {
    const pool = new ZstdPool(3);
    try {
      const ins = inputs();
      const first = ins.map((b) => pool.compress(b));
      pool.flush();
      // The worker dies with batches outstanding.
      const worker: unknown = Reflect.get(pool, "worker");
      assert.ok(worker instanceof Worker, "the pool started its worker");
      await worker.terminate();
      const frames = await Promise.all(first);
      for (const [i, f] of frames.entries()) assert.deepEqual(Buffer.from(f), Buffer.from(zstdFrame(ins[i]!, 3)));
      const later = await pool.compress(ins[2]!);
      assert.deepEqual(Buffer.from(later), Buffer.from(zstdFrame(ins[2]!, 3)));
    } finally {
      await pool.close();
    }
  });

  it("an idle pool does not keep the process alive", async () => {
    const url = pathToFileURL(join(import.meta.dirname, "../../src/store/zstd-pool.ts")).href;
    const script = `const { ZstdPool } = await import(${JSON.stringify(url)}); const p = new ZstdPool(3); const f = await p.compress(new TextEncoder().encode("x".repeat(500))); console.log(f.byteLength);`;
    const child = spawn(process.execPath, [...tsNodeArgs(), "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    const code = await new Promise<number | null>((res) => child.once("exit", res));
    clearTimeout(timer);
    assert.equal(code, 0, `exited on its own (stderr: ${err})`);
    assert.ok(Number(out.trim()) > 0);
  });
});
