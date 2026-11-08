// `coding.sh serve` through the bundled CLI: the --help --json contract, the
// refusal rule (exit 2), first-start keys, keygen, healthcheck, SIGTERM → exit 0, and the global
// --store flag that points read commands at another store.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createInterface } from "node:readline";
import { bundle } from "../../scripts/bundle.mjs";

let distDir = "";
let CLI = "";
const roots: string[] = [];
const children: ChildProcess[] = [];
before(async () => {
  distDir = realpathSync(mkdtempSync(join(tmpdir(), "csh-serve-dist-")));
  CLI = (await bundle(distDir)).cli;
});
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); // a failed assertion must not leave a server running
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

  it("refuses a public bind with half the credentials (exit 2) and names the fix", () => {
    const ingestOnly = { CODING_SH_INGEST_KEYS: "demo:csh_ik_0123456789abcdef0123456789" };
    const r = run(["serve", "--host", "0.0.0.0", "--port", "0"], tmpEnv(ingestOnly));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CODING_SH_READ_KEYS/);
    assert.match(r.stderr, /--insecure/);
    assert.equal(r.stdout, "");
    const j = run(["serve", "--host", "0.0.0.0", "--port", "0", "--json"], tmpEnv(ingestOnly));
    assert.equal(j.status, 2);
    assert.equal(JSON.parse(j.stderr.trim()).reason, "insecure_bind");
    // A viewer replica never makes its own keys: it has to share the writer's.
    const v = run(["serve", "--host", "0.0.0.0", "--port", "0", "--role", "viewer"], tmpEnv());
    assert.equal(v.status, 2);
    assert.match(v.stderr, /CODING_SH_READ_KEYS/);
    assert.equal(run(["serve", "--config", "/nonexistent/serve.toml"], tmpEnv()).status, 2);
    assert.equal(run(["serve", "--role", "nope"], tmpEnv()).status, 2);
  });

  it("a public bind with no keys makes a key pair on first start, prints it, and reuses it", async () => {
    const env = tmpEnv({ CODING_SH_HOST: "0.0.0.0" });
    const file = join(env.CODING_SH_HOME!, "serve-keys.json");
    const start = async () => {
      const child = spawn(process.execPath, [CLI, "serve", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      const lines: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (l) => {
          lines.push(l);
          if (l.startsWith("Use the server's public URL")) resolve();
        });
        child.once("exit", () => reject(new Error(`serve exited early: ${stderr}`)));
      });
      return {
        lines,
        stop: async () => {
          child.kill("SIGTERM");
          await exited;
        },
      };
    };
    const first = await start();
    const url = first.lines[0]!;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const text = first.lines.join("\n");
    assert.ok(text.includes(file), "names the keys file");
    assert.match(text, /\(made now\)/);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.match(doc.ingest, /^csh_ik_[A-Za-z0-9_-]{43}$/);
    assert.match(doc.read, /^csh_rk_[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(text.includes(`${url}/?t=${doc.read}`));
    assert.ok(text.includes(`coding.sh init --remote ${url} --key ${doc.ingest}`));

    // The keys work, and nothing else does.
    const event = { v: 0, id: "c1", sessionId: "first-start", ts: Date.now() - 1000, kind: "llm.call", model: "gpt-4o-mini", payload: {} };
    const post = (key?: string) =>
      fetch(`${url}/v1/ingest`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ v: 0, events: [event] }) });
    assert.equal((await post()).status, 401);
    assert.equal((await post(doc.read)).status, 401, "a read key cannot ingest");
    assert.deepEqual(await (await post(doc.ingest)).json(), { accepted: 1, inserted: 1, rejected: [] });
    assert.equal((await fetch(`${url}/api/sessions`)).status, 401);
    const listed = await (await fetch(`${url}/api/sessions`, { headers: { authorization: `Bearer ${doc.read}` } })).json();
    assert.deepEqual(
      listed.items.map((x: { id: string }) => x.id),
      ["first-start"],
    );
    const page = await fetch(`${url}/`, { headers: { accept: "text/html" } });
    assert.equal(page.status, 401);
    assert.match(await page.text(), /<form method=get action="\/"><input name=t /);
    await first.stop();

    const second = await start();
    const again = second.lines.join("\n");
    assert.ok(again.includes(doc.read) && again.includes(doc.ingest), "the same keys on the next start");
    assert.doesNotMatch(again, /made now/);
    await second.stop();

    // A damaged file is an error, never silently replaced (clients hold the old keys).
    writeFileSync(file, "{not json");
    const bad = run(["serve", "--port", "0"], env);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /serve-keys\.json is not valid JSON/);
    assert.equal(readFileSync(file, "utf8"), "{not json");
    // Any configured key turns first-start keys off.
    const own = run(["serve", "--port", "0"], { ...env, CODING_SH_INGEST_KEYS: "demo:csh_ik_0123456789abcdef0123456789" });
    assert.equal(own.status, 2, "half the credentials still refuse, the keys file is not used");
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
    const code = await exited;
    // On Windows SIGTERM terminates the server outright: no handler runs, so no drain to check.
    if (process.platform !== "win32") {
      assert.equal(code, 0, stderr);
      assert.match(stderr, /"msg":"stopped","drained":true/);
    }
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
