// S3BlobStore against the in-process fake S3: the shared conformance suite plus
// the behaviours the suite cannot see (layout, conditional writes, the gc touch,
// retries, timeouts, pagination, error hygiene).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { S3BlobStore, blobStore } from "../src/index.js";
import { loadConformance } from "./conformance.js";
import { TEST_CREDS, startFakeS3 } from "./fake-s3.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const env = (endpoint) => ({ AWS_ACCESS_KEY_ID: TEST_CREDS.accessKeyId, AWS_SECRET_ACCESS_KEY: TEST_CREDS.secretAccessKey, AWS_ENDPOINT_URL_S3: endpoint });

const fake = await startFakeS3();
after(() => fake.close());
const make = (prefix = `t-${randomBytes(4).toString("hex")}`, opts = {}) =>
  S3BlobStore.fromUrl(`s3://${fake.bucket}/${prefix}`, { env: env(fake.endpoint), ...opts });

const { runBlobStoreConformance } = await loadConformance();
runBlobStoreConformance("s3 (fake)", async () => make());
// Page size 1 makes every list() walk continuation tokens.
runBlobStoreConformance("s3 (fake, paginated, prefix with spaces and &)", async () => make(`p q&r/${randomBytes(3).toString("hex")}`, { listPageSize: 1 }));
const extraFakes = [];
after(() => Promise.all(extraFakes.map((f) => f.close())));
runBlobStoreConformance("s3 (fake, no prefix)", async () => {
  const f = await startFakeS3({ bucket: `b-${randomBytes(3).toString("hex")}` });
  extraFakes.push(f);
  return S3BlobStore.fromUrl(`s3://${f.bucket}`, { env: env(f.endpoint) });
});

describe("S3BlobStore behaviour", () => {
  it("stores zstd objects at <prefix>/ab/cd/<sha256>.zst", async () => {
    const s = make("layout/x");
    const ref = await s.put("hello");
    assert.equal(ref, sha("hello"));
    const key = `layout/x/${ref.slice(0, 2)}/${ref.slice(2, 4)}/${ref}.zst`;
    assert.ok(fake.objects.has(key));
    assert.equal(zstdDecompressSync(fake.objects.get(key).body).toString(), "hello");
    const put = fake.log.findLast((l) => l.method === "PUT");
    assert.equal(put.headers["if-none-match"], "*");
    assert.equal(put.headers["content-type"], "application/zstd");
    assert.equal(put.headers["x-amz-content-sha256"], sha(fake.objects.get(key).body));
  });

  it("a dedupe hit (412) is success and does not rewrite a fresh object", async () => {
    const s = make();
    await s.put("dup");
    const before = fake.log.length;
    await s.put("dup");
    const calls = fake.log.slice(before).map((l) => l.method);
    assert.deepEqual(calls, ["PUT", "HEAD"]);
  });

  it("a dedupe hit on an old object re-writes it so gc's age guard sees it as fresh", async () => {
    const s = make();
    const ref = await s.put("old blob");
    const key = s.keyFor(ref);
    fake.objects.get(key).mtime = Date.now() - 3 * 86_400_000;
    const old = await s.stat(ref);
    assert.ok(Date.now() - old.mtimeMs > 2 * 86_400_000);
    const before = fake.log.length;
    await s.put("old blob");
    const calls = fake.log.slice(before);
    assert.deepEqual(calls.map((l) => l.method), ["PUT", "HEAD", "PUT"]);
    assert.equal(calls[2].headers["if-none-match"], undefined);
    assert.ok(Date.now() - (await s.stat(ref)).mtimeMs < 60_000);
    assert.equal(await s.getText(ref), "old blob");
  });

  it("falls back to HEAD + PUT when conditional writes are unsupported", async () => {
    const f = await startFakeS3({ conditional: false });
    try {
      const s = S3BlobStore.fromUrl(`s3://${f.bucket}/nc`, { env: env(f.endpoint) });
      const ref = await s.put("no conditional");
      assert.equal(await s.getText(ref), "no conditional");
      assert.equal(s.conditionalUnsupported, true);
      const before = f.log.length;
      await s.put("no conditional"); // exists: HEAD only
      assert.deepEqual(f.log.slice(before).map((l) => l.method), ["HEAD"]);
      await s.put("second");
      assert.deepEqual(f.log.slice(before + 1).map((l) => [l.method, l.headers["if-none-match"]]), [["HEAD", undefined], ["PUT", undefined]]);
    } finally {
      await f.close();
    }
  });

  it("retries 503, 429 and dropped connections, then succeeds", async () => {
    const s = make();
    fake.faults.push(503, 429, "reset");
    const ref = await s.put("retried");
    assert.equal(fake.faults.length, 0);
    assert.equal(await s.getText(ref), "retried");
  });

  it("gives up after 3 retries and names bucket and key, never credentials", async () => {
    const s = make("errs");
    fake.faults.push(503, 503, 503, 503);
    const ref = sha("x");
    await assert.rejects(() => s.get(ref), (err) => {
      assert.match(err.message, new RegExp(`s3 GET s3://${fake.bucket}/errs/${ref.slice(0, 2)}/${ref.slice(2, 4)}/${ref}\\.zst`));
      assert.match(err.message, /HTTP 503 InternalError/);
      assert.ok(!err.message.includes(TEST_CREDS.secretAccessKey) && !err.message.includes(TEST_CREDS.accessKeyId));
      assert.ok(!/authorization|x-amz-date|Signature=/i.test(err.message));
      return true;
    });
  });

  it("times out a hung request and retries it", async () => {
    const s = make("hang", { timeoutMs: 300 });
    fake.faults.push("hang");
    const t0 = Date.now();
    const ref = await s.put("after a hang");
    assert.ok(Date.now() - t0 >= 300);
    assert.equal(await s.getText(ref), "after a hang");
    fake.faults.push("hang", "hang", "hang", "hang");
    await assert.rejects(() => s.get(ref), /timed out after 300 ms/);
  });

  it("does not retry a 403 and hints at credentials", async () => {
    const s = S3BlobStore.fromUrl(`s3://${fake.bucket}/p`, { env: { ...env(fake.endpoint), AWS_SECRET_ACCESS_KEY: "wrong" } });
    const before = fake.log.length;
    await assert.rejects(() => s.put("nope"), (err) => {
      assert.match(err.message, /HTTP 403 SignatureDoesNotMatch/);
      assert.match(err.message, /check the credentials/);
      assert.ok(!err.message.includes("wrong"));
      return true;
    });
    assert.equal(fake.log.length - before, 1);
  });

  it("has() runs at most 16 HEADs at once and keeps input order", async () => {
    const s = make();
    const present = await s.put("present");
    const refs = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? present : sha(`missing ${i}`)));
    assert.deepEqual(await s.has(refs), refs.map((r) => r === present));
    assert.equal(s.concurrency, 16);
    await assert.rejects(() => s.has([present, "nope"]), /invalid blob ref/);
  });

  it("stat and size report compressed bytes", async () => {
    const s = make();
    const ref = await s.put("a".repeat(10_000));
    const st = await s.stat(ref);
    assert.ok(st.size > 0 && st.size < 1000);
    assert.equal(await s.size(), st.size);
    assert.equal(await s.stat(sha("absent")), undefined);
  });

  it("list ignores foreign objects and other prefixes", async () => {
    const s = make("mine");
    const ref = await s.put("listed");
    fake.objects.set("mine/readme.txt", { body: Buffer.from("x"), mtime: Date.now() });
    fake.objects.set(`mine2/${ref.slice(0, 2)}/${ref.slice(2, 4)}/${ref}.zst`, { body: Buffer.from("x"), mtime: Date.now() });
    fake.objects.set(`mine/00/00/${ref}.zst`, { body: Buffer.from("x"), mtime: Date.now() }); // wrong fan-out dirs
    const got = [];
    for await (const r of s.list()) got.push(r);
    assert.deepEqual(got, [ref]);
  });

  it("ping() checks the bucket", async () => {
    await make().ping();
    const missing = S3BlobStore.fromUrl("s3://no-such-bucket/x", { env: env(fake.endpoint) });
    await assert.rejects(() => missing.ping(), /HTTP 404 NoSuchBucket/);
  });

  it("blobStore() is the plugin factory coding.sh calls", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, env(fake.endpoint));
    try {
      const s = await blobStore(`s3://${fake.bucket}/factory`);
      assert.equal(s.kind, "s3");
      assert.equal(String(s), `s3://${fake.bucket}/factory`);
      assert.equal(await s.getText(await s.put("via factory")), "via factory");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
