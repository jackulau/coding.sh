// Live S3-compatible tests (MinIO in CI/desk, works against AWS or R2 too).
// Skipped unless CODING_SH_TEST_S3_URL is set, e.g.
//   CODING_SH_TEST_S3_URL='s3://coding-sh/test?endpoint=http://127.0.0.1:9000'
//   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… npm test -w coding.sh-store-s3
// Every store gets a random prefix under a per-run root, removed afterwards.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import { S3BlobStore } from "../src/index.js";
import { loadConformance } from "./conformance.js";

const BASE = process.env.CODING_SH_TEST_S3_URL;
const RUN = `csh-test-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** s3://bucket/<base prefix>/<RUN>[/<sub>]?<params> */
function urlFor(sub) {
  const [head, query] = BASE.split("?");
  return `${head.replace(/\/+$/, "")}/${RUN}${sub ? "/" + sub : ""}${query ? "?" + query : ""}`;
}
const make = (opts = {}) => S3BlobStore.fromUrl(urlFor(`t-${randomBytes(4).toString("hex")}`), opts);

if (!BASE) {
  describe("s3 live (MinIO)", () => it.skip("set CODING_SH_TEST_S3_URL and AWS_* to run against a real endpoint"));
} else {
  after(async () => {
    // Remove every object this run wrote, under all sub-prefixes.
    const root = S3BlobStore.fromUrl(urlFor(""));
    for await (const o of root.objects()) await root.send("DELETE", o.key);
  });

  const { runBlobStoreConformance } = await loadConformance();
  runBlobStoreConformance("s3 (live)", async () => make());
  runBlobStoreConformance("s3 (live, paginated)", async () => make({ listPageSize: 2 }));

  describe("s3 live behaviour", () => {
    it("ping() reaches the bucket", async () => {
      await make().ping();
    });

    it("conditional writes are supported: a duplicate put is a 412, not a fallback", async () => {
      const s = make();
      const a = await s.put("conditional");
      const b = await s.put("conditional");
      assert.equal(a, b);
      assert.equal(s.conditionalUnsupported, false);
    });

    it("a stale dedupe hit refreshes Last-Modified (gc age guard)", async () => {
      const s = make({ touchAfterMs: 0 });
      const ref = await s.put("touch me");
      const t1 = (await s.stat(ref)).mtimeMs;
      await new Promise((r) => setTimeout(r, 1100)); // Last-Modified has 1 s resolution
      await s.put("touch me");
      const t2 = (await s.stat(ref)).mtimeMs;
      assert.ok(t2 > t1, `Last-Modified moved forward (${t1} -> ${t2})`);
      assert.equal(await s.getText(ref), "touch me");
    });

    it("round-trips a 5 MiB incompressible blob", async () => {
      const s = make();
      const big = randomBytes(5 * 1024 * 1024);
      const ref = await s.put(big);
      assert.deepEqual(Buffer.from(await s.get(ref)), big);
      assert.ok((await s.stat(ref)).size >= big.length);
    });

    it("has() over 100 refs with 16-way concurrency", async () => {
      const s = make();
      const refs = await Promise.all(Array.from({ length: 50 }, (_, i) => s.put(`blob ${i}`)));
      const missing = Array.from({ length: 50 }, () => randomBytes(32).toString("hex"));
      assert.deepEqual(await s.has([...refs, ...missing]), [...refs.map(() => true), ...missing.map(() => false)]);
    });

    it("a prefix with spaces and unicode signs and lists correctly", async () => {
      const s = S3BlobStore.fromUrl(urlFor(`odd ${encodeURIComponent("prefix é+&=")}`));
      const ref = await s.put("odd prefix");
      const got = [];
      for await (const r of s.list()) got.push(r);
      assert.deepEqual(got, [ref]);
      assert.equal(await s.getText(ref), "odd prefix");
    });

    it("wrong credentials fail with 403 and no secret in the message", async () => {
      const s = make({ credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: "definitely-wrong-secret" } });
      await assert.rejects(() => s.put("x"), (err) => {
        assert.match(err.message, /HTTP 403/);
        assert.ok(!err.message.includes("definitely-wrong-secret"));
        assert.ok(!err.message.includes(process.env.AWS_SECRET_ACCESS_KEY));
        return true;
      });
    });
  });
}
