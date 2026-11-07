import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { S3BlobStore, credentialsFromEnv, decodeXml, parseListObjects, parseS3Url } from "../src/index.js";

const CREDS = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "s3cr3t" };

describe("parseS3Url", () => {
  it("AWS defaults: us-east-1, virtual-host style", () => {
    const l = parseS3Url("s3://my-bucket/blobs", {});
    assert.equal(l.bucket, "my-bucket");
    assert.equal(l.prefix, "blobs");
    assert.equal(l.region, "us-east-1");
    assert.equal(l.endpoint.href, "https://s3.us-east-1.amazonaws.com/");
    assert.equal(l.style, "virtual");
  });

  it("region from AWS_REGION, then the URL", () => {
    assert.equal(parseS3Url("s3://b/p", { AWS_REGION: "eu-west-1" }).region, "eu-west-1");
    assert.equal(parseS3Url("s3://b/p", { AWS_REGION: "eu-west-1" }).endpoint.host, "s3.eu-west-1.amazonaws.com");
    assert.equal(parseS3Url("s3://b/p?region=auto", { AWS_REGION: "eu-west-1" }).region, "auto");
  });

  it("endpoint: URL param, then AWS_ENDPOINT_URL_S3, then AWS_ENDPOINT_URL; path style by default", () => {
    const env = { AWS_ENDPOINT_URL_S3: "http://s3env:9000", AWS_ENDPOINT_URL: "http://generic:9000" };
    assert.equal(parseS3Url("s3://b/p?endpoint=http://minio:9000", env).endpoint.host, "minio:9000");
    assert.equal(parseS3Url("s3://b/p", env).endpoint.host, "s3env:9000");
    assert.equal(parseS3Url("s3://b/p", { AWS_ENDPOINT_URL: "http://generic:9000" }).endpoint.host, "generic:9000");
    assert.equal(parseS3Url("s3://b/p", env).style, "path");
    assert.equal(parseS3Url("s3://b/p?endpoint=https://acct.r2.cloudflarestorage.com&region=auto&style=virtual", {}).style, "virtual");
  });

  it("dotted bucket names default to path style (TLS wildcard certs do not cover them)", () => {
    assert.equal(parseS3Url("s3://logs.example.com/x", {}).style, "path");
  });

  it("prefix: trims slashes, decodes escapes, may be empty", () => {
    assert.equal(parseS3Url("s3://b", {}).prefix, "");
    assert.equal(parseS3Url("s3://b/", {}).prefix, "");
    assert.equal(parseS3Url("s3://b/a/b/", {}).prefix, "a/b");
    assert.equal(parseS3Url("s3://b/my%20blobs", {}).prefix, "my blobs");
  });

  it("refuses credentials in the URL without echoing them", () => {
    for (const u of ["s3://AKID:topsecret@bucket/p", "s3://topsecret@bucket", "s3://b/p?endpoint=http://u:topsecret@minio:9000"]) {
      assert.throws(() => parseS3Url(u, {}), (err) => {
        assert.match(err.message, /credentials/);
        assert.ok(!err.message.includes("topsecret"));
        return true;
      });
    }
  });

  it("refuses unknown params, bad styles, dot segments and odd endpoints", () => {
    assert.throws(() => parseS3Url("s3://b/p?regoin=x", {}), /unknown parameter "regoin"/);
    assert.throws(() => parseS3Url("s3://b/p?style=weird", {}), /style/);
    assert.throws(() => parseS3Url("s3://b/a/../c", {}), /'\.\.'/);
    assert.throws(() => parseS3Url("s3://b/a//c", {}), /empty/);
    assert.throws(() => parseS3Url("s3://b/p?endpoint=ftp://x", {}), /http\(s\)/);
    assert.throws(() => parseS3Url("s3:///p", {}), /bucket/);
    assert.throws(() => parseS3Url("file:///p", {}), /s3:\/\/bucket/);
  });
});

describe("credentialsFromEnv", () => {
  it("needs both keys; session token optional", () => {
    assert.throws(() => credentialsFromEnv({}), /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    assert.throws(() => credentialsFromEnv({ AWS_ACCESS_KEY_ID: "x" }), /AWS_SECRET_ACCESS_KEY/);
    assert.deepEqual(credentialsFromEnv(CREDS), { accessKeyId: "AKID", secretAccessKey: "s3cr3t" });
    assert.equal(credentialsFromEnv({ ...CREDS, AWS_SESSION_TOKEN: "tok" }).sessionToken, "tok");
  });
});

describe("request targets", () => {
  const ref = "ab".repeat(32);
  it("path style: endpoint/bucket/key, each segment encoded once", () => {
    const s = S3BlobStore.fromUrl("s3://b/my%20blobs?endpoint=http://minio:9000/base/", { env: CREDS });
    const t = s.target(s.keyFor(ref), []);
    assert.equal(t.host, "minio:9000");
    assert.equal(t.url, `http://minio:9000/base/b/my%20blobs/ab/ab/${ref}.zst`);
    assert.equal(new URL(t.url).pathname, t.path); // fetch sends exactly what was signed
  });
  it("virtual style: bucket.host/key; list targets the bucket root", () => {
    const s = S3BlobStore.fromUrl("s3://bkt/p", { env: CREDS });
    assert.equal(s.target(s.keyFor(ref), []).url, `https://bkt.s3.us-east-1.amazonaws.com/p/ab/ab/${ref}.zst`);
    assert.equal(s.target(undefined, [["prefix", "p/"], ["list-type", "2"]]).url, "https://bkt.s3.us-east-1.amazonaws.com/?list-type=2&prefix=p%2F");
  });
  it("keyFor rejects malformed refs", () => {
    const s = S3BlobStore.fromUrl("s3://b", { env: CREDS });
    assert.throws(() => s.keyFor("../../etc/passwd"), /invalid blob ref/);
    assert.equal(s.refFromKey(`ab/ab/${ref}.zst`), ref);
    assert.equal(s.refFromKey(`ab/cd/${ref}.zst`), undefined);
  });
});

describe("ListObjectsV2 parsing", () => {
  it("decodes entities, sizes, truncation and the continuation token", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=&amp;x</NextContinuationToken>
      <Contents><Key>a&amp;b/&lt;c&gt;&#39;&#x41;.zst</Key><LastModified>2009-10-12T17:50:30.000Z</LastModified><Size>434234</Size></Contents>
      <Contents><Key>z</Key><Size>0</Size></Contents></ListBucketResult>`;
    const p = parseListObjects(xml);
    assert.deepEqual(p.objects, [{ key: "a&b/<c>'A.zst", size: 434234 }, { key: "z", size: 0 }]);
    assert.equal(p.truncated, true);
    assert.equal(p.nextToken, "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=&x");
    assert.equal(parseListObjects("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").truncated, false);
    assert.equal(decodeXml("&quot;&apos;&amp;amp;"), `"'&amp;`);
  });
});
