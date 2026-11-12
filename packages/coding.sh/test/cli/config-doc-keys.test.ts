// Every key docs/reference/config.md lists is one `config get` answers, and `config set` takes the
// refine and forward keys the doc shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as config from "../../src/cli/commands/config.ts";
import { FILE_KEYS, SETTABLE } from "../../src/cli/commands/config.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/reference/config.md"), "utf8");
let sb: Sandbox;
before(() => {
  sb = sandbox();
});
after(() => sb.cleanup());

/** The dotted keys the doc's tables name: `store.index`, `[serve.forward]` `endpoint`, and a `[refine]` row's bare key. */
function documentedKeys(): string[] {
  const keys = new Set<string>();
  let table = "";
  for (const line of doc.split("\n")) {
    const h = /^## `\[{1,2}([\w.]+)\]{1,2}`/.exec(line);
    if (h) table = h[1]!;
    const cell = /^\| ((?:`[^`]+`,? ?)+) \|/.exec(line)?.[1];
    if (!cell) continue;
    const m = /^`\[([\w.]+)\]` `(\w+)`/.exec(cell);
    const bare = /^`([^`]+)`$/.exec(cell.trim())?.[1];
    if (m) keys.add(`${m[1]}.${m[2]}`);
    else if (bare && /^[a-z]+\.[A-Za-z_]+$/.test(bare)) keys.add(bare);
    else if (bare && table === "refine" && /^[A-Za-z_]+$/.test(bare)) keys.add(`refine.${bare}`);
    else if (bare && table === "proxy" && /^[a-z_]+$/.test(bare)) keys.add(`proxy.${bare}`);
    else if (table === "gateway") {
      // `[gateway]` rows name top-level keys; `accountId`, `gatewayId` are [gateway.cloudflare]'s.
      for (const k of cell.match(/`(\w+)`/g)?.map((x) => x.slice(1, -1)) ?? []) keys.add(["accountId", "gatewayId"].includes(k) ? `gateway.cloudflare.${k}` : `gateway.${k}`);
    }
  }
  return [...keys];
}

test("the doc names the keys the bug report found", () => {
  const k = documentedKeys();
  for (const want of ["refine.maxCostRise", "refine.canary_model", "serve.forward.endpoint", "gateway.default", "gateway.apiKey", "gateway.baseUrl", "gateway.cloudflare.accountId"]) assert.ok(k.includes(want), want);
});

test("config get reads [gateway] keys from the file and never prints a key", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const file = join(sb.env.CODING_SH_HOME!, "config.toml");
  mkdirSync(dirname(file), { recursive: true });
  const secret = ["or", "-v1-", "R7kq2Zx9Lm4Tv8Wn"].join("");
  writeFileSync(file, `[gateway]\ndefault = "openrouter"\n\n[gateway.openrouter]\nbaseUrl = "https://openrouter.example/api/v1"\napiKey = "${secret}"\n`);
  try {
    const d = await runCmd(config, sb, { action: "get", positionals: ["gateway.default"], json: true });
    assert.deepEqual(d.json, { key: "gateway.default", value: "openrouter" });
    const u = await runCmd(config, sb, { action: "get", positionals: ["gateway.openrouter.baseUrl"], json: true });
    assert.equal(u.json.value, "https://openrouter.example/api/v1");
    const k = await runCmd(config, sb, { action: "get", positionals: ["gateway.openrouter.apiKey"] });
    assert.equal(k.code, 0);
    assert.ok(!k.stdout.includes(secret), k.stdout);
    assert.match(k.stdout, /is set/);
    const bad = await runCmd(config, sb, { action: "get", positionals: ["gateway.nosuch.baseUrl"] });
    assert.match(bad.error?.message, /Unknown config key/);
  } finally {
    writeFileSync(file, "");
  }
});

test("config set serve.forward.endpoint refuses a value that is not a URL", async () => {
  const r = await runCmd(config, sb, { action: "set", positionals: ["serve.forward.endpoint", "not a url"] });
  assert.equal(r.error?.reason ?? (r.error as { reason?: string } | undefined)?.reason, "invalid_value");
  assert.match(r.error?.message, /http:\/\/ or https:\/\/ URL/);
});

test("config get knows every documented key; an unset one says so instead of 'unknown'", async () => {
  for (const key of documentedKeys()) {
    const r = await runCmd(config, sb, { action: "get", positionals: [key] });
    assert.equal(r.error, undefined, `${key}: ${r.error?.message}`);
    assert.equal(r.code, 0, key);
  }
  const unset = await runCmd(config, sb, { action: "get", positionals: ["refine.canary_model"], json: true });
  assert.deepEqual(unset.json, { key: "refine.canary_model", value: null });
  const bad = await runCmd(config, sb, { action: "get", positionals: ["refine.nope"] });
  assert.match(bad.error?.message, /Unknown config key/);
});

test("config set takes refine.maxCostRise, refine.canary_model and serve.forward.endpoint, and get reads them back", async () => {
  for (const [key, raw, want] of [["refine.maxCostRise", "100%", "100%"], ["refine.canary_model", "claude-haiku-4-5", "claude-haiku-4-5"], ["serve.forward.endpoint", "http://localhost:4318", "http://localhost:4318"]] as const) {
    assert.ok((SETTABLE as readonly string[]).includes(key));
    const s = await runCmd(config, sb, { action: "set", positionals: [key, raw], json: true });
    assert.equal(s.error, undefined, `${key}: ${s.error?.message}`);
    assert.equal(s.json.value, want);
    const g = await runCmd(config, sb, { action: "get", positionals: [key], json: true });
    assert.equal(g.json.value, want, key);
  }
  const text = readFileSync(join(sb.env.CODING_SH_HOME!, "config.toml"), "utf8");
  assert.match(text, /\[refine\]\nmaxCostRise = "100%"/);
  assert.match(text, /\[serve\.forward\]\nendpoint = /);
});

test("config set refuses a refine.maxCostRise that is not a rise", async () => {
  const r = await runCmd(config, sb, { action: "set", positionals: ["refine.maxCostRise", "lots"] });
  assert.equal(r.error?.reason, "invalid_value");
});

test("every FILE_KEYS entry is documented", () => {
  const k = documentedKeys();
  for (const key of FILE_KEYS) assert.ok(k.includes(key) || doc.includes(`\`${key.split(".").pop()}\``), `${key} is in config.md`);
});
