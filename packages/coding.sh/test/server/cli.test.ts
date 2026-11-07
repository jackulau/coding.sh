// `coding.sh serve` through the bundled CLI: the --help --json contract, the
// refusal rule (exit 2), keygen, healthcheck, SIGTERM → exit 0, and the global
// --store flag that points read commands at another store.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createInterface } from "node:readline";
import { bundle } from "../../scripts/bundle.mjs";

let distDir = "";
let CLI = "";
const roots: string[] = [];
before(async () => {
  distDir = realpathSync(mkdtempSync(join(tmpdir(), "csh-serve-dist-")));
  CLI = (await bundle(distDir)).cli;
});
after(() => {
  rmSync(distDir, { recursive: true, force: true });
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-serve-cli-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  return { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: dirname(process.execPath), NO_COLOR: "1", CODING_SH_LOG: "json", ...extra };
}

const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 30_000 });

describe("coding.sh serve (CLI)", () => {
  it("describes itself with --help --json", () => {
    const r = run(["serve", "--help", "--json"], tmpEnv());
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.command.name, "serve");
    const opts = doc.command.options.map((o: { name: string }) => o.name);
    for (const o of ["host", "port", "config", "role", "insecure"]) assert.ok(opts.includes(o), o);
    const actions = (doc.command.actions ?? doc.command.commands ?? []).map((a: { name: string }) => a.name);
    assert.deepEqual(actions.sort(), ["healthcheck", "keygen"]);
    const kg = run(["serve", "keygen", "--help", "--json"], tmpEnv());
    assert.equal(kg.status, 0, kg.stderr);
    const root = JSON.parse(run(["--help", "--json"], tmpEnv()).stdout);
    assert.ok(JSON.stringify(root).includes('"serve"'));
    assert.ok(JSON.stringify(root).includes('"store"'), "--store is a global option");
  });

  it("refuses a public bind without keys (exit 2) and names the fix", () => {
    const r = run(["serve", "--host", "0.0.0.0", "--port", "0"], tmpEnv());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CODING_SH_INGEST_KEYS/);
    assert.match(r.stderr, /--insecure/);
    assert.equal(r.stdout, "");
    const j = run(["serve", "--host", "0.0.0.0", "--port", "0", "--json"], tmpEnv());
    assert.equal(j.status, 2);
    assert.equal(JSON.parse(j.stderr.trim()).reason, "insecure_bind");
    assert.equal(run(["serve", "--config", "/nonexistent/serve.toml"], tmpEnv()).status, 2);
    assert.equal(run(["serve", "--role", "nope"], tmpEnv()).status, 2);
  });

  it("keygen prints the key on stdout and the hash line on stderr", () => {
    const r = run(["serve", "keygen", "--project", "demo"], tmpEnv());
    assert.equal(r.status, 0, r.stderr);
    const key = r.stdout.trim();
    assert.match(key, /^csh_ik_[A-Za-z0-9_-]{43}$/);
    assert.match(r.stderr, /CODING_SH_INGEST_KEYS=demo:sha256:[0-9a-f]{64}/);
    assert.ok(!r.stderr.includes(key), "the key itself is only on stdout");
    const j = JSON.parse(run(["serve", "keygen", "--read", "--project", "*", "--json"], tmpEnv()).stdout);
    assert.equal(j.kind, "read");
    assert.equal(j.project, "*");
    assert.match(j.key, /^csh_rk_/);
    assert.match(j.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(run(["serve", "keygen", "--project", "Bad_Id"], tmpEnv()).status, 2);
    assert.equal(run(["serve", "keygen", "--project", "*"], tmpEnv()).status, 2, "only read keys span every project");
  });

  it("serves, passes healthcheck, stops on SIGTERM with exit 0; --store reads its store", async () => {
    const env = tmpEnv();
    const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const line = await new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout });
      rl.once("line", resolve);
      child.once("exit", () => reject(new Error(`serve exited early: ${stderr}`)));
    });
    const ready = JSON.parse(line);
    assert.equal(ready.ready.ok, true);
    assert.equal(ready.ready.store, "sqlite");
    const url: string = ready.url;

    const body = { v: 0, service: "billing-api", events: [{ v: 0, id: "c1", sessionId: "req-1", ts: Date.now() - 1000, kind: "llm.call", model: "gpt-4o-mini", usage: { inputTokens: 100, outputTokens: 20 }, payload: {} }] };
    const res = await fetch(`${url}/v1/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await res.json(), { accepted: 1, inserted: 1, rejected: [] });

    const hc = run(["serve", "healthcheck", "--url", `${url}/readyz`], env);
    assert.equal(hc.status, 0, hc.stderr);
    child.kill("SIGTERM");
    assert.equal(await exited, 0, stderr);
    assert.match(stderr, /"msg":"stopped","drained":true/);
    assert.equal(run(["serve", "healthcheck", "--url", `${url}/healthz`, "--timeout", "500"], env).status, 1);

    // Another HOME reads the server's database through --store (and ingests nothing of its own).
    const db = join(env.CODING_SH_HOME!, "index.db");
    const other = tmpEnv();
    const s = run(["sessions", "--json", "--store", `sqlite://${db}`], other);
    assert.equal(s.status, 0, s.stderr);
    const sessions = JSON.parse(s.stdout).sessions;
    assert.deepEqual(
      sessions.map((x: { id: string }) => x.id),
      ["req-1"],
    );
    assert.equal(sessions[0].agent, "billing-api");
    assert.equal(run(["sessions", "--store"], other).status, 2);
    const eq = run(["sessions", "--json", `--store=sqlite://${db}`], other);
    assert.equal(JSON.parse(eq.stdout).sessions.length, 1);
  });
});
