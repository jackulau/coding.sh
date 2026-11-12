import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { secretScan } from "../../gate/checks.mjs";
import { SECRET_ERE, SECRET_PATTERNS, secretsIn } from "../../release/secret-patterns.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A repo root holding only the given files. */
function tree(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "secret-scan-")));
  temps.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

// Vendor-shaped values are built from parts so no whole one sits in this file.
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const STRIPE = ["sk_te", "st_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");
const SLACK = ["xox", "b-", "123456789012-abcdefghijkl"].join("");

test("the scan reports an AWS key id and a Stripe test key in built output, with file and pattern name", () => {
  const root = tree({ "packages/coding.sh/dist/cli.mjs": `const a = "${AWS}";\n`, "apps/site/dist/docs/x/index.html": `<p>${STRIPE}</p>` });
  const r = secretScan(root);
  assert.equal(r.status, "fail");
  const text = r.detail.join("\n");
  assert.match(text, /packages\/coding\.sh\/dist\/cli\.mjs: aws-access-key-id/);
  assert.match(text, /apps\/site\/dist\/docs\/x\/index\.html: stripe-key/);
});

test("a regex source that names a shape is not a secret", () => {
  const root = tree({ "packages/coding.sh/dist/cli.mjs": "const re = /ghp_[0-9A-Za-z]{36}/; const s = /sk_(test|live)_[0-9A-Za-z]{10,}/;\n" });
  assert.equal(secretScan(root).status, "pass");
});

test("the scan walks the Python SDK dist and ignores binary files", () => {
  const root = tree({ "packages/sdk-python/dist/pkg/mod.py": `KEY = "${SLACK}"\n`, "packages/sdk/dist/logo.png": `${STRIPE}` });
  const r = secretScan(root);
  assert.equal(r.status, "fail");
  assert.match(r.detail.join("\n"), /sdk-python\/dist\/pkg\/mod\.py: slack-token/);
  assert.ok(!r.detail.join("\n").includes("logo.png"));
});

test("the scan opens the Python wheel and sdist and reports a token inside them", () => {
  const GHP = ["gh", "p_", "a".repeat(36)].join("");
  const root = tree({});
  const dist = join(root, "packages/sdk-python/dist");
  mkdirSync(join(dist, "src/coding_sh"), { recursive: true });
  writeFileSync(join(dist, "src/coding_sh/_client.py"), `TOKEN = "${GHP}"\n`);
  // Real archives, built with the system's own tools: a deflated zip and a gzipped tar.
  const py = process.platform === "win32" ? "python" : "python3";
  const zip = spawnSync(py, ["-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z: z.write(sys.argv[2], 'coding_sh/_client.py')", join(dist, "coding_sh-0.1.0-py3-none-any.whl"), join(dist, "src/coding_sh/_client.py")]);
  assert.equal(zip.status, 0, String(zip.stderr));
  const tgz = spawnSync("tar", ["-czf", join(dist, "coding_sh-0.1.0.tar.gz"), "-C", join(dist, "src"), "coding_sh"]);
  assert.equal(tgz.status, 0, String(tgz.stderr));
  rmSync(join(dist, "src"), { recursive: true });
  const r = secretScan(root);
  assert.equal(r.status, "fail");
  const text = r.detail.join("\n");
  assert.match(text, /coding_sh-0\.1\.0-py3-none-any\.whl!coding_sh\/_client\.py: github-token/);
  assert.match(text, /coding_sh-0\.1\.0\.tar\.gz!coding_sh\/_client\.py: github-token/);
});

test("no dist fails the scan, unless it runs static", () => {
  const root = tree({ "packages/coding.sh/src/a.ts": "export {};\n" });
  assert.equal(secretScan(root).status, "fail");
  assert.equal(secretScan(root, { static: true }).status, "pass");
});

test("the shared patterns cover the shapes the old smoke regex missed", () => {
  assert.deepEqual(secretsIn(STRIPE), ["stripe-key"]);
  assert.deepEqual(secretsIn(SLACK), ["slack-token"]);
  assert.deepEqual(secretsIn(AWS), ["aws-access-key-id"]);
  assert.ok(SECRET_PATTERNS.length >= 8);
});

test("smoke.sh reads the shared list: grep -E with SECRET_ERE finds the same shapes", () => {
  const sh = spawnSync("sh", ["-c", `printf '%s' "$1" | grep -E "$2"`, "sh", `x ${STRIPE} y`, SECRET_ERE], { encoding: "utf8" });
  assert.equal(sh.status, 0);
  const none = spawnSync("sh", ["-c", `printf '%s' "$1" | grep -E "$2"`, "sh", "nothing here", SECRET_ERE], { encoding: "utf8" });
  assert.equal(none.status, 1);
  const smoke = spawnSync("grep", ["-n", "secret-patterns", join(REPO, "scripts/release/smoke.sh")], { encoding: "utf8" });
  assert.equal(smoke.status, 0, "smoke.sh does not read secret-patterns.mjs");
});
