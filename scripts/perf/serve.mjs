// Static server for perf runs: serves a built site the way production does,
// close enough that byte counts and request timing mean something.
//  - HTTP/2 over TLS (a throwaway self-signed cert; Chrome runs with
//    --ignore-certificate-errors), like Cloudflare. Over plain HTTP Chrome
//    would use HTTP/1.1 with 6 connections and refuse brotli.
//  - brotli (else gzip) for text, compressed once up front and cached on disk by
//    content hash, so no request pays for compression.
//  - Cloudflare's html_handling "drop-trailing-slash" (apps/site/wrangler.jsonc):
//    /docs/quickstart serves docs/quickstart.html or docs/quickstart/index.html,
//    and /docs/quickstart/ redirects to it. Unknown paths get 404.html, status 404.
//  - apps/site/public/_headers are not applied: perf runs start with an empty cache.
// Usage as a module: const s = await serve(dir); s.origin; await s.close().
// Usage from a shell: node scripts/perf/serve.mjs <dir> [port]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".svg", ".xml", ".txt", ".md", ".sh", ".ttf", ".otf"]);

const CACHE = join(tmpdir(), "coding-sh-perf-cache");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** {br, gzip} for one file, from the on-disk cache when the same bytes were compressed before. */
function compressed(body) {
  const key = createHash("sha256").update(body).digest("hex");
  const br = join(CACHE, `${key}.br`);
  const gz = join(CACHE, `${key}.gz`);
  if (existsSync(br) && existsSync(gz)) return { br: readFileSync(br), gzip: readFileSync(gz) };
  const out = {
    br: brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } }),
    gzip: gzipSync(body, { level: 9 }),
  };
  writeFileSync(br, out.br);
  writeFileSync(gz, out.gzip);
  return out;
}

/** A self-signed cert for 127.0.0.1, made once per machine (openssl). */
function cert() {
  const key = join(CACHE, "localhost-key.pem");
  const crt = join(CACHE, "localhost-cert.pem");
  if (!existsSync(key) || !existsSync(crt)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "3650", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], {
      stdio: "ignore",
    });
  }
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

/** Load every file of `dir` into memory (compressed forms included). */
function load(dir) {
  mkdirSync(CACHE, { recursive: true });
  const files = new Map();
  for (const p of walk(dir)) {
    const rel = p.slice(dir.length).split(sep).join("/");
    const ext = extname(p).toLowerCase();
    const body = readFileSync(p);
    const f = { body, type: TYPES[ext] ?? "application/octet-stream" };
    if (COMPRESSIBLE.has(ext) && body.length > 512) Object.assign(f, compressed(body));
    files.set(rel, f);
  }
  return files;
}

export async function serve(dirArg, opts = {}) {
  const dir = resolve(dirArg);
  if (!existsSync(join(dir, "index.html"))) throw new Error(`${dir} has no index.html; build the site first`);
  const files = load(dir);
  const notFound = files.get("/404.html");
  const lookup = (path) => {
    if (path === "/") return files.get("/index.html");
    return files.get(`${path}.html`) ?? files.get(`${path}/index.html`) ?? (extname(path) ? files.get(path) : undefined);
  };
  const server = http2.createSecureServer({ ...cert(), allowHTTP1: true });
  const sessions = new Set();
  /** path → body bytes of each response, in order. */
  const served = new Map();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  server.on("request", (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "https://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path.length > 1 && path.endsWith("/")) {
      res.writeHead(307, { location: path.replace(/\/+$/, "") || "/" }).end();
      return;
    }
    const hit = lookup(path);
    const f = hit ?? notFound;
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    const accept = String(req.headers["accept-encoding"] ?? "");
    // Body bytes sent per path (encoded, headers excluded): exact byte counts for the harness.
    const enc = f.br && /\bbr\b/.test(accept) ? "br" : f.gzip && /\bgzip\b/.test(accept) ? "gzip" : undefined;
    const body = enc ? f[enc] : f.body;
    const headers = { "content-type": f.type, "content-length": body.length, "cache-control": "no-store" };
    if (enc) {
      headers["content-encoding"] = enc;
      headers.vary = "accept-encoding";
    }
    const log = served.get(path) ?? [];
    log.push(body.length);
    served.set(path, log);
    res.writeHead(hit ? 200 : 404, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, "127.0.0.1", ok);
  });
  const { port } = server.address();
  return {
    origin: `https://127.0.0.1:${port}`,
    files: files.size,
    /** Body bytes sent for each request to `path` since the last reset, oldest first. */
    served: (path) => served.get(path) ?? [],
    reset: () => served.clear(),
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        // Chrome keeps HTTP/2 sessions open; don't wait for it to hang up.
        for (const s of sessions) s.destroy();
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, port] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node scripts/perf/serve.mjs <built-site-dir> [port]");
    process.exit(2);
  }
  const s = await serve(dir, { port: port ? Number(port) : 0 });
  console.error(`serving ${resolve(dir)} (${s.files} files) at ${s.origin}`);
}
