import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const HOMES = ["HOME", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_HOME", "COPILOT_HOME", "PI_CODING_AGENT_DIR"];
const URLS = ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_URL", "CODING_SH_FORWARD_URL"];

test("smoke.sh isolation moves every home inside its work dir and drops store URLs, whatever the caller exports", () => {
  const w = realpathSync(mkdtempSync(join(tmpdir(), "smoke-env-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "smoke-outside-")));
  temps.push(w, outside);
  const env = { PATH: process.env.PATH };
  for (const k of HOMES) env[k] = join(outside, k);
  for (const k of URLS) env[k] = `postgres://real/${k}`;
  const script = `. "${REPO}/scripts/release/smoke-env.sh"; smoke_isolate_env "${w}"; env`;
  const r = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  for (const k of HOMES) assert.ok(got[k]?.startsWith(`${w}/`), `${k}=${got[k]} is not under ${w}`);
  for (const k of URLS) assert.equal(got[k], undefined, `${k} is still set`);
});

test("smoke.sh sources the isolation and checks the path init writes", () => {
  const sh = readFileSync(join(REPO, "scripts/release/smoke.sh"), "utf8");
  assert.match(sh, /smoke_isolate_env "\$W"/);
  assert.match(sh, /\$CLAUDE_CONFIG_DIR\/settings\.json/);
  assert.ok(!/export HOME="\$W\/home"/.test(sh), "smoke.sh still sets HOME on its own line");
});
