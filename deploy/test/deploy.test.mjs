// Static checks for the deploy recipes (docs/PRODUCTION.md §5) and gen-env.sh.
// Run: node --test "deploy/test/*.test.mjs"
// docker build / compose up are checked on the desk, not here (see docs/production/compose.md).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseToml } from "../../packages/coding.sh/src/core/toml.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const NAMES = ["POSTGRES_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "INGEST_KEY_DEMO", "INGEST_KEY_FLOOD", "READ_KEY"];
const KEY_RE = { ik: /^csh_ik_[A-Za-z0-9_-]{43}$/, rk: /^csh_rk_[A-Za-z0-9_-]{43}$/ };

describe("gen-env.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "csh-genenv-"));
  const envFile = join(dir, ".env");
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync("sh", [join(root, "deploy/compose/gen-env.sh"), ...args], {
      env: { PATH: process.env.PATH, HOME: dir, ENV_FILE: envFile },
      encoding: "utf8",
    });
  const parse = () =>
    Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );

  test("writes every variable, mode 600, and prints no secret", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    const env = parse();
    assert.deepEqual(Object.keys(env).sort(), [...NAMES].sort());
    for (const v of Object.values(env)) {
      assert.ok(v.length >= 8, "value too short");
      assert.ok(!(r.stdout + r.stderr).includes(v), "a secret was printed");
      // Safe to `. ./.env` in sh and to embed in postgres:// URLs.
      assert.match(v, /^[A-Za-z0-9_-]+$/);
    }
    assert.match(env.INGEST_KEY_DEMO, KEY_RE.ik);
    assert.match(env.INGEST_KEY_FLOOD, KEY_RE.ik);
    assert.match(env.READ_KEY, KEY_RE.rk);
    assert.notEqual(env.INGEST_KEY_DEMO, env.INGEST_KEY_FLOOD);
    assert.ok(env.POSTGRES_PASSWORD.length >= 32);
    assert.ok(env.MINIO_ROOT_PASSWORD.length >= 32);
  });

  test("keeps an existing file; --force regenerates it", () => {
    const before = readFileSync(envFile, "utf8");
    const r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /kept/);
    assert.equal(readFileSync(envFile, "utf8"), before);
    const f = run("--force");
    assert.equal(f.status, 0);
    assert.notEqual(readFileSync(envFile, "utf8"), before);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), [".env"], "no temp file left behind");
  });
});

describe("Dockerfile", () => {
  const df = read("Dockerfile");
  test("follows the contract", () => {
    assert.match(df, /^FROM node:22-bookworm-slim AS build$/m);
    assert.match(df, /^FROM gcr\.io\/distroless\/nodejs22-debian12:nonroot$/m);
    assert.match(df, /coding\.sh-store-postgres coding\.sh-store-s3/);
    assert.match(df, /npm ci /);
    assert.match(df, /CODING_SH_HOME=\/data/);
    assert.match(df, /CODING_SH_HOST=0\.0\.0\.0/);
    assert.match(df, /^EXPOSE 4318$/m);
    assert.match(df, /CMD \["\/nodejs\/bin\/node","\/app\/cli\.mjs","serve","healthcheck"\]/);
    assert.match(df, /^CMD \["\/app\/cli\.mjs","serve"\]$/m);
  });
  test("has no VOLUME (Railway rejects it) and does not set PORT", () => {
    assert.doesNotMatch(df, /^\s*VOLUME\b/m);
    assert.doesNotMatch(df, /CODING_SH_PORT=|\bPORT=/);
  });
  test(".dockerignore keeps secrets and build output out of the context", () => {
    const di = read(".dockerignore");
    for (const p of ["**/node_modules", "**/dist", "**/.env"]) assert.ok(di.split("\n").includes(p), p);
    assert.match(di, /^\*$/m);
  });
});

describe("docker-compose.yml", () => {
  const dc = read("docker-compose.yml");
  test("has the four services", () => {
    for (const s of ["coding-sh", "postgres", "minio", "minio-init"]) assert.match(dc, new RegExp(`^  ${s}:$`, "m"), s);
    assert.match(dc, /image: postgres:17$/m);
  });
  test("passes the contract's env to serve", () => {
    assert.match(dc, /CODING_SH_STORE_URL: postgres:\/\/coding:\$\{POSTGRES_PASSWORD[^}]*\}@postgres:5432\/coding$/m);
    assert.match(dc, /CODING_SH_BLOB_URL: s3:\/\/coding-sh\/blobs\?endpoint=http:\/\/minio:9000$/m);
    assert.match(dc, /CODING_SH_INGEST_KEYS: demo:\$\{INGEST_KEY_DEMO[^}]*\},flood:\$\{INGEST_KEY_FLOOD[^}]*\}$/m);
    assert.match(dc, /CODING_SH_READ_KEYS: "\*:\$\{READ_KEY[^}]*\}"$/m);
    assert.match(dc, /\.\/deploy\/compose\/config\.toml:\/etc\/coding\.sh\/config\.toml:ro/);
  });
  test("publishes ports on loopback only", () => {
    const ports = [...dc.matchAll(/^\s+- "([^"]+:\d+)"/gm)].map((m) => m[1]);
    assert.ok(ports.length >= 3);
    for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, p);
    assert.ok(ports.includes("127.0.0.1:4318:4318"));
    assert.ok(ports.includes("127.0.0.1:5432:5432"));
  });
  test("pins every image tag", () => {
    for (const [, img] of dc.matchAll(/image: (\S+)/g)) {
      if (img === "coding-sh:local") continue;
      assert.match(img, /:[\w.-]+$/, img);
      assert.doesNotMatch(img, /:latest$/, img);
    }
  });
  test("every ${VAR} it needs is one gen-env.sh writes", () => {
    const vars = new Set([...dc.matchAll(/\$\{([A-Z_]+)/g)].map((m) => m[1]));
    for (const v of vars) assert.ok(NAMES.includes(v), v);
  });
});

describe("pinned prices", () => {
  const cfg = parseToml(read("deploy/compose/config.toml"));
  test("match §5 and give the journeys' exact costs", () => {
    assert.deepEqual(cfg.pricing["mock-gpt"], { input: 1, output: 2 });
    assert.deepEqual(cfg.pricing["mock-claude"], { input: 3, output: 15 });
    const cost = (m, i, o) => (i * cfg.pricing[m].input + o * cfg.pricing[m].output) / 1e6;
    assert.ok(Math.abs(3 * cost("mock-gpt", 1000, 500) - 0.006) < 1e-9); // J1
    assert.ok(Math.abs(cost("mock-gpt", 1000, 500) + cost("mock-claude", 1000, 500) - 0.0125) < 1e-9); // J2
  });
  test("set no [serve] or [store] (the same file serves sqlite and postgres)", () => {
    assert.equal(cfg.serve, undefined);
    assert.equal(cfg.store, undefined);
  });
});

describe("platform recipes", () => {
  test("fly.toml", () => {
    const fly = parseToml(read("deploy/fly.toml"));
    assert.equal(fly.http_service.internal_port, 4318);
    assert.equal(fly.http_service.checks[0].path, "/readyz");
    assert.equal(fly.http_service.auto_stop_machines, "off");
    assert.equal(fly.mounts.destination, "/data");
    assert.equal(fly.kill_signal, "SIGTERM");
    assert.ok(fly.kill_timeout >= 26, "longer than the 25 s drain");
  });
  test("railway.json", () => {
    const r = JSON.parse(read("deploy/railway.json"));
    assert.equal(r.build.builder, "DOCKERFILE");
    assert.equal(r.build.dockerfilePath, "Dockerfile");
    assert.equal(r.deploy.healthcheckPath, "/healthz");
    assert.ok(r.deploy.drainingSeconds >= 26);
  });
  test("render.yaml", () => {
    const y = read("render.yaml");
    assert.match(y, /runtime: docker/);
    assert.match(y, /healthCheckPath: \/healthz/);
    assert.match(y, /key: CODING_SH_STORE_URL\n\s+fromDatabase:\n\s+name: coding-sh-db\n\s+property: connectionString/);
    assert.match(y, /^databases:\n  - name: coding-sh-db$/m);
    for (const k of ["CODING_SH_INGEST_KEYS", "CODING_SH_READ_KEYS"]) {
      assert.match(y, new RegExp(`key: ${k}[^\\n]*\\n\\s+sync: false`), k);
    }
  });
});

describe("docs/production", () => {
  const dir = join(root, "docs/production");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  test("has the quickstarts", () => {
    for (const f of ["README.md", "compose.md", "fly.md", "railway.md", "render.md", "serverless.md"]) assert.ok(files.includes(f), f);
  });
  test("relative links resolve", () => {
    for (const f of files) {
      for (const [, href] of read(`docs/production/${f}`).matchAll(/\]\(([^)]+)\)/g)) {
        if (/^[a-z]+:/.test(href)) continue;
        const target = resolve(dir, href.split("#")[0]);
        assert.ok(existsSync(target), `${f}: ${href}`);
      }
    }
  });
  test("contain no real-looking keys", () => {
    for (const f of files) assert.doesNotMatch(read(`docs/production/${f}`), /csh_(ik|rk)_[A-Za-z0-9_-]{20,}/, f);
  });
});
