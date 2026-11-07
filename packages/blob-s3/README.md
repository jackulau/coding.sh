# coding.sh-store-s3

S3 blob store for [coding.sh](https://coding.sh): AWS S3, Cloudflare R2, MinIO, or any S3-compatible
endpoint. Zero dependencies (SigV4 on `node:crypto`, `fetch`, zstd from `node:zlib`).

```sh
npm i coding.sh coding.sh-store-s3
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…          # credentials only from the environment
export CODING_SH_BLOB_URL='s3://my-bucket/blobs?region=us-east-1'
# R2:    s3://bucket/blobs?region=auto&endpoint=https://<account>.r2.cloudflarestorage.com
# MinIO: s3://bucket/blobs?endpoint=http://127.0.0.1:9000   (path style by default with an endpoint)
```

coding.sh loads this package by name when a blob URL starts with `s3://`. Objects live at
`<prefix>/ab/cd/<sha256>.zst`, the same layout as the local store. Parameters: `region` (default
`AWS_REGION`, then `us-east-1`), `endpoint` (default `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`,
then AWS) and `style=path|virtual`. A URL with credentials in it is refused.

The credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on the
bucket and prefix. Contract: `docs/PRODUCTION.md` §3.3.

Tests: `npm test` runs the SigV4 reference vectors and the conformance suite against an in-process
fake. Set `CODING_SH_TEST_S3_URL` (plus `AWS_*`) to run it against a real endpoint as well.
