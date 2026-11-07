// @ts-check
// S3 BlobStore (AWS S3, Cloudflare R2, MinIO, any S3-compatible endpoint).
//
//   s3://bucket/prefix?region=auto&endpoint=https://<acct>.r2.cloudflarestorage.com&style=path|virtual
//
// Same layout and semantics as the core fs store: objects live at
// <prefix>/ab/cd/<sha256>.zst, zstd-compressed, addressed by the sha256 of the
// *uncompressed* bytes, write-once. Credentials come only from the environment
// (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, optional AWS_SESSION_TOKEN).
// Zero dependencies: SigV4 on node:crypto, fetch, zstd from node:zlib.
import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";
import { EMPTY_SHA256, canonicalQuery, encodePath, sha256Hex, signV4 } from "./sigv4.js";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

/**
 * @typedef {import("./sigv4.js").Credentials} Credentials
 * @typedef {{ bucket: string, prefix: string, region: string, endpoint: URL, style: "path" | "virtual" }} S3Location
 * @typedef {S3Location & {
 *   credentials: Credentials,
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 *   retries?: number,
 *   concurrency?: number,
 *   touchAfterMs?: number,
 *   level?: number,
 *   listPageSize?: number,
 * }} S3BlobStoreOptions
 * @typedef {{ status: number, headers: Headers, body: Buffer }} S3Response
 */

const URL_PARAMS = new Set(["region", "endpoint", "style"]);
const REF_RE = /^[0-9a-f]{64}$/;

/** @param {unknown} ref @returns {asserts ref is string} */
export function assertBlobRef(ref) {
  if (typeof ref !== "string" || !REF_RE.test(ref)) {
    throw new Error(`invalid blob ref ${JSON.stringify(ref)}: expected 64 lowercase hex chars (sha256)`);
  }
}

/**
 * Parses an s3:// store URL. Refuses credentials in the URL (they belong in the
 * environment) and unknown parameters (a typo should not silently hit AWS).
 * @param {string} url
 * @param {Record<string, string | undefined>} [env]
 * @returns {S3Location}
 */
export function parseS3Url(url, env = process.env) {
  const m = /^s3:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(url);
  // Never echo the URL in errors: a refused URL may hold a secret.
  if (!m) throw new Error("s3 store URL must look like s3://bucket/prefix?region=…&endpoint=…");
  const authority = m[1] ?? "";
  if (authority.includes("@")) {
    throw new Error("s3 store URL must not contain credentials; set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN) in the environment");
  }
  const bucket = authority;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(bucket)) {
    throw new Error(`s3 store URL has an invalid bucket name ${JSON.stringify(bucket)}`);
  }
  const segments = (m[2] ?? "").split("/").filter((s, i, a) => !((i === 0 || i === a.length - 1) && s === ""));
  const prefix = segments.map((s) => {
    let d;
    try {
      d = decodeURIComponent(s);
    } catch {
      throw new Error(`s3 store URL prefix has a malformed escape in ${JSON.stringify(s)}`);
    }
    if (d === "" || d === "." || d === "..") throw new Error("s3 store URL prefix must not contain empty, '.' or '..' segments");
    return d;
  }).join("/");

  const params = new URLSearchParams(m[3] ?? "");
  for (const k of params.keys()) {
    if (!URL_PARAMS.has(k)) throw new Error(`s3 store URL has an unknown parameter "${k}" (supported: ${[...URL_PARAMS].join(", ")})`);
  }
  const region = params.get("region") || env.AWS_REGION || "us-east-1";
  const endpointRaw = params.get("endpoint") || env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL || "";
  let endpoint;
  if (endpointRaw) {
    try {
      endpoint = new URL(endpointRaw);
    } catch {
      throw new Error("s3 endpoint must be an http(s) URL, e.g. endpoint=http://127.0.0.1:9000");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("s3 endpoint must be an http(s) URL");
    if (endpoint.username || endpoint.password) throw new Error("s3 endpoint must not contain credentials");
    if (endpoint.search || endpoint.hash) throw new Error("s3 endpoint must not have a query or fragment");
  } else {
    endpoint = new URL(`https://s3.${region}.amazonaws.com`);
  }
  const style = params.get("style") || (endpointRaw || bucket.includes(".") ? "path" : "virtual");
  if (style !== "path" && style !== "virtual") throw new Error(`s3 style must be "path" or "virtual", not ${JSON.stringify(style)}`);
  return { bucket, prefix, region, endpoint, style };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Credentials}
 */
export function credentialsFromEnv(env = process.env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("s3 blob store needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment (AWS_SESSION_TOKEN optional)");
  }
  return env.AWS_SESSION_TOKEN ? { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN } : { accessKeyId, secretAccessKey };
}

/** @param {string} s */
export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    return String.fromCodePoint(l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  });
}

/**
 * Minimal ListObjectsV2 parser: keys and sizes, truncation and the next token.
 * @param {string} xml
 */
export function parseListObjects(xml) {
  /** @type {Array<{ key: string, size: number }>} */
  const objects = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1] ?? "";
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    if (key === undefined) continue;
    objects.push({ key: decodeXml(key), size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0) });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, truncated, nextToken: token === undefined ? undefined : decodeXml(token) };
}

/** @param {Buffer} body */
function errorInfo(body) {
  const xml = body.toString("utf8");
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(xml)?.[1];
  const message = /<Message>([\s\S]*?)<\/Message>/.exec(xml)?.[1];
  return { code: code && decodeXml(code), message: message && decodeXml(message).slice(0, 300) };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(x: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(/** @type {T} */ (items[i]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class S3BlobStore {
  kind = "s3";

  /** @param {S3BlobStoreOptions} opts */
  constructor(opts) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.region = opts.region;
    this.endpoint = opts.endpoint;
    this.style = opts.style;
    /** @private */ this.credentials = opts.credentials;
    /** @private */ this.fetch = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 3;
    this.concurrency = opts.concurrency ?? 16;
    /** A dedupe hit on an object older than this re-writes it, so gc's age guard sees it as fresh. */
    this.touchAfterMs = opts.touchAfterMs ?? 60 * 60_000;
    this.level = opts.level ?? 3;
    this.listPageSize = opts.listPageSize;
    /** Set when the endpoint rejects `If-None-Match: *` on PUT; puts then use HEAD + PUT. */
    this.conditionalUnsupported = false;
  }

  /**
   * @param {string} url
   * @param {{ env?: Record<string, string | undefined> } & Partial<S3BlobStoreOptions>} [opts]
   */
  static fromUrl(url, opts = {}) {
    const env = opts.env ?? process.env;
    return new S3BlobStore({ ...parseS3Url(url, env), credentials: credentialsFromEnv(env), ...opts });
  }

  /** "s3://bucket/prefix" (no endpoint, no credentials) for messages. */
  toString() {
    return `s3://${this.bucket}${this.prefix ? "/" + this.prefix : ""}`;
  }

  /** @param {string} ref */
  keyFor(ref) {
    assertBlobRef(ref);
    return `${this.prefix ? this.prefix + "/" : ""}${ref.slice(0, 2)}/${ref.slice(2, 4)}/${ref}.zst`;
  }

  /** @param {string} key */
  refFromKey(key) {
    const lp = this.prefix ? this.prefix + "/" : "";
    if (!key.startsWith(lp)) return undefined;
    const m = /^([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.zst$/.exec(key.slice(lp.length));
    return m && m[3]?.startsWith(m[1] + m[2]) ? m[3] : undefined;
  }

  /**
   * Host, encoded path and URL for an object key (or the bucket when undefined).
   * @private @param {string | undefined} key @param {Array<[string, string]>} query
   */
  target(key, query) {
    const base = this.endpoint.pathname.replace(/\/+$/, "");
    const host = this.style === "virtual" ? `${this.bucket}.${this.endpoint.host}` : this.endpoint.host;
    const raw = this.style === "virtual" ? `${base}/${key ?? ""}` : `${base}/${this.bucket}${key === undefined ? "" : "/" + key}`;
    const path = encodePath(raw);
    const qs = canonicalQuery(query);
    return { host, path, url: `${this.endpoint.protocol}//${host}${path}${qs ? "?" + qs : ""}` };
  }

  /**
   * Signed request with a 30 s timeout and up to `retries` jittered retries on
   * 429, 5xx, network errors and timeouts (plus `retryOn` statuses). The body is
   * read inside the attempt, so a connection dropped mid-body is retried too.
   * @private
   * @param {string} method
   * @param {string | undefined} key
   * @param {{ query?: Array<[string, string]>, body?: Buffer, headers?: Record<string, string>, retryOn?: number[] }} [o]
   * @returns {Promise<S3Response>}
   */
  async send(method, key, o = {}) {
    const query = o.query ?? [];
    const t = this.target(key, query);
    const payloadHash = o.body ? sha256Hex(o.body) : EMPTY_SHA256;
    for (let attempt = 0; ; attempt++) {
      const { headers } = signV4({
        method, host: t.host, path: t.path, query, payloadHash,
        headers: { ...o.headers, "x-amz-content-sha256": payloadHash },
        region: this.region, service: "s3", credentials: this.credentials, date: new Date(),
      });
      delete headers.host; // fetch derives the same value from the URL
      /** @type {S3Response | undefined} */
      let res;
      /** @type {unknown} */
      let err;
      try {
        const body = /** @type {BodyInit | undefined} */ (/** @type {unknown} */ (o.body));
        const r = await this.fetch(t.url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        res = { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
      } catch (e) {
        err = e;
      }
      const retryable = res ? res.status === 429 || res.status >= 500 || (o.retryOn ?? []).includes(res.status) : true;
      if (!retryable || attempt >= this.retries) {
        if (res) return res;
        throw this.networkError(method, key, err);
      }
      await sleep(this.backoff(attempt, res));
    }
  }

  /** Full jitter, capped; honours a numeric Retry-After. @private @param {number} attempt @param {S3Response} [res] */
  backoff(attempt, res) {
    const jitter = Math.random() * Math.min(2_000, 100 * 2 ** attempt);
    const ra = Number(res?.headers.get("retry-after"));
    return Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) + jitter : jitter;
  }

  /** @private @param {string} key */
  where(key) {
    return `s3://${this.bucket}/${key} (${this.endpoint.host})`;
  }

  /** @private @param {string} method @param {string | undefined} key @param {unknown} err */
  networkError(method, key, err) {
    const e = /** @type {Error & { cause?: { code?: string, message?: string } }} */ (err);
    const detail = e?.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : [e?.message, e?.cause?.code ?? e?.cause?.message].filter(Boolean).join(": ");
    return new Error(`s3 ${method} ${this.where(key ?? "")} failed after ${this.retries + 1} attempts: ${detail}`);
  }

  /** Names bucket, key and the S3 error code; never headers or credentials. @private @param {string} method @param {string} key @param {S3Response} res */
  fail(method, key, res) {
    const { code, message } = errorInfo(res.body);
    const hint = res.status === 403 ? " (check the credentials, the bucket policy and the clock)" : "";
    return new Error(`s3 ${method} ${this.where(key)} failed: HTTP ${res.status}${code ? " " + code : ""}${message ? ": " + message : ""}${hint}`);
  }

  /**
   * Content-addressed write. `PUT` with `If-None-Match: *`; a 412 means the
   * blob exists and counts as success. Endpoints without conditional writes
   * fall back to HEAD then PUT.
   * @param {Uint8Array | string} data
   * @param {{ contentType?: string }} [_meta]
   */
  async put(data, _meta) {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const ref = sha256Hex(bytes);
    const key = this.keyFor(ref);
    const body = await compress(bytes, { params: { [constants.ZSTD_c_compressionLevel]: this.level } });
    if (!this.conditionalUnsupported) {
      // 409 ConditionalRequestConflict: a concurrent conditional PUT of the same key; retry it.
      const res = await this.send("PUT", key, { body, headers: { "content-type": "application/zstd", "if-none-match": "*" }, retryOn: [409] });
      if (res.status >= 200 && res.status < 300) return ref;
      if (res.status === 412) {
        await this.refresh(key, body);
        return ref;
      }
      const { code } = errorInfo(res.body);
      if (res.status !== 501 && code !== "NotImplemented") throw this.fail("PUT", key, res);
      this.conditionalUnsupported = true;
    }
    const existing = await this.statKey(key);
    if (existing) await this.refresh(key, body, existing.mtimeMs);
    else await this.putUnconditional(key, body);
    return ref;
  }

  /**
   * Dedupe hit. gc only sweeps blobs older than its age guard, and the fs store
   * refreshes mtime on a hit so a blob re-referenced during a sweep survives.
   * S3 has no touch, so an object older than `touchAfterMs` is re-written with
   * the same bytes, which refreshes Last-Modified. A blob gone since the 412 is
   * written again.
   * @private @param {string} key @param {Buffer} body @param {number} [mtimeMs]
   */
  async refresh(key, body, mtimeMs) {
    const lm = mtimeMs ?? (await this.statKey(key))?.mtimeMs;
    if (lm !== undefined && Number.isFinite(lm) && Date.now() - lm < this.touchAfterMs) return;
    await this.putUnconditional(key, body);
  }

  /** @private @param {string} key @param {Buffer} body */
  async putUnconditional(key, body) {
    const res = await this.send("PUT", key, { body, headers: { "content-type": "application/zstd" } });
    if (res.status < 200 || res.status >= 300) throw this.fail("PUT", key, res);
  }

  /** @param {string} ref @returns {Promise<Uint8Array | undefined>} */
  async get(ref) {
    const key = this.keyFor(ref);
    const res = await this.send("GET", key);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw this.fail("GET", key, res);
    let out;
    try {
      out = await decompress(res.body);
    } catch (err) {
      throw new Error(`blob ${ref} is corrupt (${this.where(key)}): ${/** @type {Error} */ (err).message}`);
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }

  /** @param {string} ref */
  async getText(ref) {
    const b = await this.get(ref);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  /** Batch existence check: HEAD per ref, 16 at a time, in input order. @param {string[]} refs */
  async has(refs) {
    const keys = refs.map((r) => this.keyFor(r));
    return mapLimit(keys, this.concurrency, async (k) => (await this.statKey(k)) !== undefined);
  }

  /** Stored (compressed) size and Last-Modified. gc uses mtimeMs for its age guard. @param {string} ref */
  async stat(ref) {
    return this.statKey(this.keyFor(ref));
  }

  /** @private @param {string} key @returns {Promise<{ size: number, mtimeMs: number } | undefined>} */
  async statKey(key) {
    const res = await this.send("HEAD", key);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw this.fail("HEAD", key, res);
    return { size: Number(res.headers.get("content-length") ?? 0), mtimeMs: Date.parse(res.headers.get("last-modified") ?? "") };
  }

  /** @private @returns {AsyncGenerator<{ key: string, size: number }>} */
  async *objects() {
    const lp = this.prefix ? this.prefix + "/" : "";
    /** @type {string | undefined} */
    let token;
    do {
      /** @type {Array<[string, string]>} */
      const query = [["list-type", "2"]];
      if (lp) query.push(["prefix", lp]);
      if (token) query.push(["continuation-token", token]);
      if (this.listPageSize) query.push(["max-keys", String(this.listPageSize)]);
      const res = await this.send("GET", undefined, { query });
      if (res.status !== 200) throw this.fail("LIST", lp + "*", res);
      const page = parseListObjects(res.body.toString("utf8"));
      yield* page.objects;
      token = page.truncated ? page.nextToken : undefined;
    } while (token);
  }

  /** Every blob ref under the prefix (ListObjectsV2, paginated). */
  async *list() {
    for await (const o of this.objects()) {
      const ref = this.refFromKey(o.key);
      if (ref) yield ref;
    }
  }

  /** Total compressed bytes under the prefix. */
  async size() {
    let total = 0;
    for await (const o of this.objects()) if (this.refFromKey(o.key)) total += o.size;
    return total;
  }

  /** @param {string} ref */
  async delete(ref) {
    const key = this.keyFor(ref);
    const res = await this.send("DELETE", key);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw this.fail("DELETE", key, res);
  }

  /** Cheap reachability and permission check (one ListObjectsV2 with max-keys=1). */
  async ping() {
    const lp = this.prefix ? this.prefix + "/" : "";
    /** @type {Array<[string, string]>} */
    const query = [["list-type", "2"], ["max-keys", "1"]];
    if (lp) query.push(["prefix", lp]);
    const res = await this.send("GET", undefined, { query });
    if (res.status !== 200) throw this.fail("LIST", lp + "*", res);
  }

  async close() {}
}
