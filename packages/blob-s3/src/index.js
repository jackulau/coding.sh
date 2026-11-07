// @ts-check
// coding.sh-store-s3: the s3:// BlobStore plugin. coding.sh loads this package
// by naming convention (coding.sh-store-<scheme>) when a blob URL uses s3://:
//
//   CODING_SH_BLOB_URL=s3://bucket/prefix?region=auto&endpoint=https://<acct>.r2.cloudflarestorage.com
//
// Plain JavaScript on purpose: Node does not strip TypeScript types under
// node_modules, and this package must load from an npm install with no build.
import { S3BlobStore } from "./store.js";

export { S3BlobStore, parseS3Url, credentialsFromEnv, parseListObjects, decodeXml } from "./store.js";
export { signV4, signingKey, uriEncode, encodePath, canonicalQuery } from "./sigv4.js";

/**
 * Factory coding.sh calls for an s3:// blob URL.
 * @param {string} url
 * @param {unknown} [_config]
 */
export function blobStore(url, _config) {
  return S3BlobStore.fromUrl(url);
}
