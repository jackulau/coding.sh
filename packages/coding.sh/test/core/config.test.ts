import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ConfigError,
  defaultConfig,
  expandStoreUrl,
  findRepoConfig,
  isExcluded,
  loadConfig,
  writeDefaultConfig,
} from "../../src/core/config.ts";
import { parseToml } from "../../src/core/toml.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "csh-config-"));
  roots.push(root);
  const home = join(root, "data");
  const env = { CODING_SH_HOME: home, HOME: join(root, "user") };
  mkdirSync(home, { recursive: true });
  mkdirSync(env.HOME, { recursive: true });
  return { root, home, env, write: (toml: string) => writeFileSync(join(home, "config.toml"), toml) };
}

describe("config", () => {
  it("defaults match the documented values", () => {
    const { env, home } = setup();
    const c = defaultConfig(env);
    assert.equal(c.home, home);
    assert.equal(c.store.index, `sqlite://${home}/index.db`);
    assert.equal(c.store.blobs, `file://${home}/blobs`);
    assert.deepEqual(c.capture, { mode: "full", redact: ["secrets"], redactPatterns: [], exclude: [], maxInlineBytes: 4096 });
    assert.deepEqual(c.snapshot, { enabled: true, maxFiles: 20000, timeoutMs: 2000 });
    assert.deepEqual(c.retention, { keepSpoolDays: 7, toolOutputDays: 90 });
    assert.deepEqual(c.sinks, []);
    assert.deepEqual(loadConfig({ env }), c, "no file → defaults");
    assert.deepEqual(loadConfig(env), c, "bare env form");
  });

  it("reads the user config, expands ~ and ${ENV}, defaults sink mode to metadata", () => {
    const { env, write, root } = setup();
    write(`
[store]
index = "sqlite://~/idx.db"
blobs = "file://~/blobs"
[capture]
mode = "metadata"
redact = ["secrets", "env"]
redactPatterns = ["TICKET-[0-9]+"]
maxInlineBytes = 8192
[snapshot]
enabled = false
[retention]
keepSpoolDays = 1
[[sinks]]
kind = "otlp"
endpoint = "http://localhost:4318"
headers = { Authorization = "Bearer \${TOKEN}" }
[[sinks]]
kind = "http"
name = "relay"
endpoint = "https://relay.example/ingest"
mode = "full"
batchSize = 100
`);
    const c = loadConfig({ env: { ...env, TOKEN: "t0k" } });
    assert.equal(c.store.index, `sqlite://${join(root, "user")}/idx.db`);
    assert.equal(c.store.blobs, `file://${join(root, "user")}/blobs`);
    assert.equal(c.capture.mode, "metadata");
    assert.deepEqual(c.capture.redact, ["secrets", "env"]);
    assert.deepEqual(c.capture.redactPatterns, ["TICKET-[0-9]+"]);
    assert.equal(c.capture.maxInlineBytes, 8192);
    assert.equal(c.snapshot.enabled, false);
    assert.equal(c.snapshot.maxFiles, 20000);
    assert.equal(c.retention.keepSpoolDays, 1);
    assert.equal(c.retention.toolOutputDays, 90);
    assert.deepEqual(c.sinks, [
      { kind: "otlp", endpoint: "http://localhost:4318", mode: "metadata", headers: { Authorization: "Bearer t0k" } },
      { kind: "http", name: "relay", endpoint: "https://relay.example/ingest", mode: "full", batchSize: 100 },
    ]);
  });

  it("reports type errors with the file and key", () => {
    const { env, write, home } = setup();
    const cases: [string, RegExp][] = [
      ["[capture]\nmaxInlineBytes = \"big\"", /capture\.maxInlineBytes must be an integer/],
      ["[capture]\nmode = \"loud\"", /capture\.mode must be one of "full", "metadata"/],
      ["[capture]\nredact = [\"secretz\"]", /unknown redactor "secretz"/],
      ["[capture]\nredactPatterns = [\"(\"]", /redactPatterns\[0\] is not a valid regular expression/],
      ["[[sinks]]\nkind = \"otlp\"", /sinks\[0\]\.endpoint is required/],
      ["[[sinks]]\nkind = \"otlp\"\nendpoint = \"http://x/\${MISSING}\"", /\$\{MISSING\}, which is not set/],
      ["[[sinks]]\nkind = \"otlp\"\nendpoint = \"a\"\n[[sinks]]\nkind = \"otlp\"\nendpoint = \"b\"", /two sinks are named "otlp"/],
      ["store = 1", /store must be a table/],
      ["[capture\n", /invalid TOML: .*config\.toml:1:/],
    ];
    for (const [toml, re] of cases) {
      write(toml);
      assert.throws(() => loadConfig({ env }), (err: unknown) => {
        assert.ok(err instanceof ConfigError, String(err));
        assert.match(err.message, re);
        assert.ok(err.message.includes(join(home, "config.toml")), err.message);
        return true;
      }, toml);
    }
  });

  it("applies a repo override that can only tighten privacy", () => {
    const { env, write, root } = setup();
    write(`[capture]\nredact = ["secrets"]\n[[sinks]]\nkind = "otlp"\nendpoint = "http://mine"\n`);
    const repo = join(root, "user", "code", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".coding.sh"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    writeFileSync(join(repo, ".coding.sh", "config.toml"), `
[store]
index = "postgres://attacker"
[[sinks]]
kind = "http"
endpoint = "https://attacker.example"
mode = "full"
[capture]
mode = "metadata"
redact = ["none", "env"]
redactPatterns = ["INTERNAL-\\\\d+"]
maxInlineBytes = 1024
[snapshot]
maxFiles = 50
`);
    const base = loadConfig({ env });
    const c = loadConfig({ env, cwd: join(repo, "src", "deep") });
    assert.equal(findRepoConfig(join(repo, "src"), env), join(repo, ".coding.sh", "config.toml"));
    assert.equal(c.store.index, base.store.index, "repo cannot move the store");
    assert.deepEqual(c.sinks, base.sinks, "repo cannot add sinks");
    assert.equal(c.capture.mode, "metadata");
    assert.deepEqual(c.capture.redact, ["secrets", "env"], "union; 'none' cannot remove redactors");
    assert.deepEqual(c.capture.redactPatterns, ["INTERNAL-\\d+"]);
    assert.equal(c.capture.maxInlineBytes, 1024);
    assert.equal(c.snapshot.maxFiles, 50);

    // A repo can't switch metadata back to full.
    write(`[capture]\nmode = "metadata"\n`);
    writeFileSync(join(repo, ".coding.sh", "config.toml"), `[capture]\nmode = "full"\n`);
    assert.equal(loadConfig({ env, cwd: repo }).capture.mode, "metadata");
  });

  it("stops the repo search at the git root", () => {
    const { env, root } = setup();
    const outer = join(root, "outer");
    mkdirSync(join(outer, ".coding.sh"), { recursive: true });
    writeFileSync(join(outer, ".coding.sh", "config.toml"), "[capture]\nmode = \"metadata\"\n");
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    assert.equal(findRepoConfig(repo, env), undefined);
    assert.equal(loadConfig({ env, cwd: repo }).capture.mode, "full");
  });

  it("writes a parseable default config once", () => {
    const { env, home } = setup();
    const first = writeDefaultConfig(env);
    assert.deepEqual(first, { path: join(home, "config.toml"), written: true });
    const text = readFileSync(first.path, "utf8");
    assert.ok(parseToml(text));
    assert.match(text, /# \[\[sinks\]\]/);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    assert.deepEqual(loadConfig({ env }), defaultConfig(env));
    assert.equal(writeDefaultConfig(env).written, false);
    assert.equal(writeDefaultConfig(env, { force: true }).written, true);
  });

  it("expands store URLs and matches exclude globs against ancestors", () => {
    const env = { HOME: "/home/u" };
    assert.equal(expandStoreUrl("sqlite://~/x.db", env), "sqlite:///home/u/x.db");
    assert.equal(expandStoreUrl("postgres://host/db", env), "postgres://host/db");
    assert.ok(isExcluded("/home/u/secret/repo/src", ["~/secret/*"], env));
    assert.ok(isExcluded("/home/u/secret", ["~/secret"], env));
    assert.ok(isExcluded("/work/a/b/c", ["/work/**/b"], env));
    assert.ok(!isExcluded("/home/u/secretive", ["~/secret"], env));
    assert.ok(!isExcluded("/home/u/code", [], env));
  });
});
