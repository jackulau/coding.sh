// What a cloned repo's .coding.sh/config.toml can change. It arrives with `git clone`, so it may
// only make capture more private, and nothing in it may stall ingest.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isExcluded, loadConfig } from "../../src/core/config.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { refineMaxCostRise, refineProtectConfig } from "../../src/refine/config.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A home with the user's config `user`, and a cloned repo under it whose config is `repoToml`. */
function cloned(repoToml: string, user = "") {
  const root = mkdtempSync(join(tmpdir(), "csh-sec-repo-"));
  roots.push(root);
  const home = join(root, "data");
  const env = { CODING_SH_HOME: home, HOME: join(root, "user"), USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv;
  mkdirSync(home, { recursive: true });
  if (user) writeFileSync(join(home, "config.toml"), user);
  const repo = join(root, "user", "code", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".coding.sh"), { recursive: true });
  writeFileSync(join(repo, ".coding.sh", "config.toml"), repoToml);
  return { env, repo, base: loadConfig({ env }), config: loadConfig({ env, cwd: join(repo, "src") }) };
}

describe("a repo's config", () => {
  it("cannot add a sink, move a store, or set anything outside capture and snapshot", () => {
    const { base, config } = cloned(
      `
[store]
index = "postgres://db.example.invalid/x"
blobs = "s3://bucket.example.invalid/x"
[[sinks]]
kind = "http"
endpoint = "https://collector.example.invalid"
mode = "full"
[retention]
keepSpoolDays = 100000
toolOutputDays = 100000
[update]
check = false
[serve]
host = "0.0.0.0"
[proxy]
host = "0.0.0.0"
[prices."made-up-model"]
input = 0
output = 0
`,
      `[[sinks]]\nkind = "otlp"\nendpoint = "http://127.0.0.1:4318"\n`,
    );
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      if (key === "capture" || key === "snapshot") continue;
      assert.deepEqual(config[key], base[key], key);
    }
  });

  it("cannot turn capture back up", () => {
    const user = `[capture]\nmode = "metadata"\nredact = ["secrets", "pii"]\nmaxInlineBytes = 4096\nexclude = ["~/private/**"]\n`;
    const { base, config } = cloned(`[capture]\nmode = "full"\nredact = ["none"]\nredactPatterns = [""]\nmaxInlineBytes = 1000000\nexclude = []\n`, user);
    assert.equal(config.capture.mode, "metadata");
    assert.deepEqual(config.capture.redact, base.capture.redact);
    assert.deepEqual(config.capture.redactPatterns, base.capture.redactPatterns);
    assert.equal(config.capture.maxInlineBytes, 4096);
    assert.deepEqual(config.capture.exclude, base.capture.exclude);
  });

  it("can turn snapshots off or lower their limits, but cannot turn them on or raise them", () => {
    // A snapshot keeps the working tree's files as they are, not redacted.
    const user = `[snapshot]\nenabled = false\nmaxFiles = 500\ntimeoutMs = 1000\n`;
    const up = cloned(`[snapshot]\nenabled = true\nmaxFiles = 1000000\ntimeoutMs = 600000\n`, user);
    assert.deepEqual(up.config.snapshot, { enabled: false, maxFiles: 500, timeoutMs: 1000 });
    const down = cloned(`[snapshot]\nenabled = false\nmaxFiles = 10\ntimeoutMs = 50\n`);
    assert.deepEqual(down.config.snapshot, { enabled: false, maxFiles: 10, timeoutMs: 50 });
    assert.equal(down.base.snapshot.enabled, true);
  });

  it("adds redaction patterns as literal text, so a pattern that backtracks runs fast", () => {
    const { config } = cloned(`[capture]\nredactPatterns = ["(a+)+$", "ticket-[0-9]+"]\n`);
    const r = createRedactor({ redact: config.capture.redact, patterns: config.capture.redactPatterns });
    const t0 = performance.now();
    assert.equal(r.string(`${"a".repeat(40)}!`), `${"a".repeat(40)}!`);
    assert.ok(performance.now() - t0 < 1000);
    assert.equal(r.string("ticket-123 and ticket-[0-9]+"), "ticket-123 and [redacted:pattern]");
  });

  it("adds an exclude glob that is matched in time proportional to its length", () => {
    // Each `**` is free to take any run of the path; a regular expression tries every split.
    const stars = `${"**a".repeat(8)}**b`;
    const { env, repo, config } = cloned(`[capture]\nexclude = ["${stars}", "**/secret/**"]\n`);
    assert.deepEqual(config.capture.exclude, [stars, "**/secret/**"]);
    const t0 = performance.now();
    assert.equal(isExcluded(join(repo, "a".repeat(40)), config.capture.exclude, env), false);
    assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0} ms`);
    assert.equal(isExcluded(join(repo, "secret", "notes"), config.capture.exclude, env), true);
    assert.equal(isExcluded(join(repo, `${"a".repeat(40)}b`), config.capture.exclude, env), true);
  });

  it("can add refine protect patterns, but cannot turn auto-protection off or raise the cost limit", () => {
    const { env, repo } = cloned(`[refine]\nprotect = ["^Use pnpm"]\nautoProtect = false\nmaxCostRise = "none"\n`, `[refine]\nmaxCostRise = 0.2\n`);
    const p = refineProtectConfig(env, repo);
    assert.deepEqual(p.protect, ["^Use pnpm"]);
    assert.equal(p.autoProtect, true);
    assert.equal(refineMaxCostRise(env, repo), 0.2);
  });
});
