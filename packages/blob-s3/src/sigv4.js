// @ts-check
// AWS Signature Version 4 on node:crypto, no SDK. Used for S3, R2 and MinIO.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
//
// The caller passes the path already encoded (one RFC 3986 pass per segment,
// see encodePath) and uses the same string in the request URL, so the signed
// path and the sent path are byte-identical and nothing is encoded twice.
import { createHash, createHmac } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} Credentials
 * @typedef {{
 *   method: string,
 *   host: string,
 *   path: string,
 *   query?: Array<[string, string]>,
 *   headers?: Record<string, string>,
 *   payloadHash: string,
 *   region: string,
 *   service: string,
 *   credentials: Credentials,
 *   date: Date,
 * }} SignInput
 */

/** @param {string | Uint8Array} data */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * RFC 3986 percent-encoding: unreserved characters (A-Z a-z 0-9 - . _ ~) stay,
 * every other UTF-8 byte becomes %XX with uppercase hex.
 * @param {string} s
 */
export function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Encodes each segment of a raw (unencoded) path once; slashes stay.
 * @param {string} rawPath
 */
export function encodePath(rawPath) {
  return rawPath.split("/").map(uriEncode).join("/");
}

/**
 * Sorted, encoded query string; the same string is signed and sent.
 * @param {Array<[string, string]>} query
 */
export function canonicalQuery(query) {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** "20150830T123600Z" @param {Date} d */
export function amzDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** @param {string} v */
const trimHeader = (v) => v.trim().replace(/ +/g, " ");

/** @param {string | Buffer} key @param {string} data */
const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();

/**
 * kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")
 * @param {string} secret @param {string} date YYYYMMDD @param {string} region @param {string} service
 */
export function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
}

/**
 * Builds the canonical request, string to sign and Authorization header.
 * Returns the headers to send: the input headers plus host, x-amz-date,
 * x-amz-security-token (with a session token) and authorization. Every header
 * passed in is signed, so pass only headers whose values the transport keeps.
 * @param {SignInput} input
 */
export function signV4(input) {
  const { credentials, region, service } = input;
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host ??= input.host;
  headers["x-amz-date"] = stamp;
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((n) => `${n}:${trimHeader(String(headers[n]))}\n`).join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path || "/",
    canonicalQuery(input.query ?? []),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(credentials.secretAccessKey, day, region, service))
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  /** @type {Record<string, string>} */
  const out = { ...headers, authorization };
  return { headers: out, canonicalRequest, stringToSign, signature, authorization };
}
