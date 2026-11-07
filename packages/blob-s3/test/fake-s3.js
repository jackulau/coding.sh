// In-process S3 stand-in for unit tests (path style only). It re-verifies every
// SigV4 signature from the bytes it actually received, so a path, query or
// header that the transport changed after signing fails the request with 403,
// as real S3 would. Fault injection: push 503 / 429 / "reset" / "hang" onto
// `faults` to fail the next requests.
import { createServer } from "node:http";
import { sha256Hex, signV4 } from "../src/sigv4.js";

export const TEST_CREDS = { accessKeyId: "AKIDTEST", secretAccessKey: "test/secret+key" };

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const errXml = (code, message) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

/**
 * @param {{ bucket?: string, conditional?: boolean, credentials?: typeof TEST_CREDS }} [o]
 */
export async function startFakeS3(o = {}) {
  const bucket = o.bucket ?? "test-bucket";
  const creds = o.credentials ?? TEST_CREDS;
  /** @type {Map<string, { body: Buffer, mtime: number }>} */
  const objects = new Map();
  /** @type {Array<number | "reset" | "hang">} */
  const faults = [];
  /** @type {Array<{ method: string, url: string, headers: Record<string, string | string[] | undefined> }>} */
  const log = [];
  const hung = new Set();

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    log.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });

    const fault = faults.shift();
    if (fault === "reset") return req.socket.destroy();
    if (fault === "hang") {
      hung.add(res);
      return;
    }
    if (typeof fault === "number") {
      res.writeHead(fault, fault === 429 ? { "retry-after": "0" } : {});
      return res.end(errXml(fault === 429 ? "SlowDown" : "InternalError", "injected"));
    }

    // --- verify the signature against what arrived
    const auth = String(req.headers.authorization ?? "");
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    const [rawPath, rawQuery = ""] = (req.url ?? "/").split("?");
    const query = rawQuery ? rawQuery.split("&").map((p) => {
      const i = p.indexOf("=");
      return /** @type {[string, string]} */ (i < 0 ? [decodeURIComponent(p), ""] : [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))]);
    }) : [];
    const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
    let ok = false;
    if (m && m[1] === creds.accessKeyId) {
      const signed = m[4].split(";");
      const headers = Object.fromEntries(signed.map((h) => [h, String(req.headers[h] ?? "")]));
      const amz = String(req.headers["x-amz-date"] ?? "");
      const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
      const expect = signV4({ method: req.method ?? "", host: headers.host ?? "", path: rawPath, query, headers, payloadHash, region: m[3], service: "s3", credentials: creds, date });
      ok = expect.signature === m[5] && signed.includes("host") && signed.includes("x-amz-content-sha256");
    }
    if (!ok) {
      res.writeHead(403);
      return res.end(errXml("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided."));
    }
    if (payloadHash !== sha256Hex(body)) {
      res.writeHead(400);
      return res.end(errXml("XAmzContentSHA256Mismatch", "content hash mismatch"));
    }

    const segs = rawPath.split("/").slice(1).map(decodeURIComponent);
    if (segs[0] !== bucket) {
      res.writeHead(404);
      return res.end(errXml("NoSuchBucket", "The specified bucket does not exist"));
    }
    const key = segs.slice(1).join("/");

    if (!key && req.method === "GET") {
      const q = Object.fromEntries(query);
      if (q["list-type"] !== "2") {
        res.writeHead(400);
        return res.end(errXml("InvalidArgument", "only ListObjectsV2"));
      }
      const prefix = q.prefix ?? "";
      const max = Number(q["max-keys"] ?? 1000);
      const start = q["continuation-token"] ? Buffer.from(q["continuation-token"], "base64").toString("utf8") : "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > start).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      const token = truncated ? Buffer.from(page[page.length - 1], "utf8").toString("base64") : undefined;
      const contents = page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key><Size>${objects.get(k).body.length}</Size></Contents>`).join("");
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${token ? `<NextContinuationToken>${xmlEscape(token)}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`);
    }

    const obj = objects.get(key);
    switch (req.method) {
      case "PUT": {
        if (req.headers["if-none-match"] !== undefined) {
          if (o.conditional === false) {
            res.writeHead(501);
            return res.end(errXml("NotImplemented", "A header you provided implies functionality that is not implemented"));
          }
          if (req.headers["if-none-match"] === "*" && obj) {
            res.writeHead(412);
            return res.end(errXml("PreconditionFailed", "At least one of the pre-conditions you specified did not hold"));
          }
        }
        objects.set(key, { body, mtime: Date.now() });
        res.writeHead(200);
        return res.end();
      }
      case "GET":
      case "HEAD":
        if (!obj) {
          res.writeHead(404);
          return res.end(req.method === "GET" ? errXml("NoSuchKey", "The specified key does not exist.") : undefined);
        }
        res.writeHead(200, { "content-length": obj.body.length, "last-modified": new Date(obj.mtime).toUTCString() });
        return res.end(req.method === "GET" ? obj.body : undefined);
      case "DELETE":
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      default:
        res.writeHead(405);
        return res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return {
    bucket,
    objects,
    faults,
    log,
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      for (const r of hung) r.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}
