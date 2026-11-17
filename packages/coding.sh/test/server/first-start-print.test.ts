// First-start keys are secrets: serve prints them once, on the start that makes them, and never in
// --json. A mistyped key entry is named by its position, never echoed.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { generateKey, KeyFormatError, parseIngestKeys, parseReadKeys } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { keysFile, loadOrCreateKeys, writeKeysOnce } from "../../src/server/first-start.ts";
import { CLI } from "../_cli.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-first-print-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  return { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: dirname(process.execPath), NO_COLOR: "1", CODING_SH_LOG: "json", ...extra };
}

/** Starts serve, collects stdout until `done` says so, then stops it. */
async function startOnce(env: NodeJS.ProcessEnv, args: string[], done: (line: string) => boolean): Promise<string> {
  const child = spawn(process.execPath, ["--no-warnings", CLI, "serve", "--port", "0", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const lines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => {
      lines.push(l);
      if (done(l)) resolve();
    });
    child.once("exit", () => reject(new Error(`serve exited early: ${stderr}`)));
  });
  child.kill("SIGTERM");
  await exited;
  return lines.join("\n");
}

describe("first-start keys are printed once", () => {
  it("prints the keys on the start that makes them, and only names the file after that", async () => {
    const env = tmpEnv({ CODING_SH_HOST: "0.0.0.0" });
    const file = join(env.CODING_SH_HOME!, "serve-keys.json");
    const last = (l: string) => l.startsWith("Use the server's public URL");
    const first = await startOnce(env, [], last);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(first.includes(doc.read) && first.includes(doc.ingest), "the start that makes the keys prints them");

    const again = await startOnce(env, [], last);
    assert.ok(again.includes(file), "a later start names the keys file");
    assert.ok(!again.includes(doc.read), "a later start does not print the read key");
    assert.ok(!again.includes(doc.ingest), "a later start does not print the ingest key");
  });

  it("never puts the keys in --json, not even on the start that makes them", async () => {
    const env = tmpEnv({ CODING_SH_HOST: "0.0.0.0" });
    const file = join(env.CODING_SH_HOME!, "serve-keys.json");
    for (const round of ["made", "reused"]) {
      const out = await startOnce(env, ["--json"], (l) => l.trim().startsWith("{"));
      const doc = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(!out.includes(doc.read), `${round}: --json does not carry the read key`);
      assert.ok(!out.includes(doc.ingest), `${round}: --json does not carry the ingest key`);
      const data = JSON.parse(out.trim().split("\n").find((l) => l.trim().startsWith("{"))!);
      assert.equal(data.keys.file, file, `${round}: --json names the keys file`);
      assert.equal(data.keys.created, round === "made");
    }
  });
});

describe("the keys file", () => {
  it("is not kept when serve fails to start, so the next start makes and prints keys", async () => {
    const env = tmpEnv({ CODING_SH_HOST: "0.0.0.0" });
    const file = join(env.CODING_SH_HOME!, "serve-keys.json");
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "0.0.0.0", resolve));
    try {
      const port = (busy.address() as AddressInfo).port;
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "serve", "--port", String(port)], { env, encoding: "utf8", timeout: 30_000 });
      assert.notEqual(r.status, 0, "the port is in use");
      assert.ok(!existsSync(file), "no keys file is left whose keys were never printed");
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  it("made by another start in the meantime is kept, never replaced", () => {
    const env = tmpEnv();
    const file = keysFile(env);
    mkdirSync(dirname(file), { recursive: true });
    const theirs = { ingest: generateKey("ingest"), read: generateKey("read") };
    writeFileSync(file, JSON.stringify(theirs));
    assert.equal(writeKeysOnce(file, "{}"), false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), theirs);
    assert.deepEqual(readdirSync(dirname(file)), ["serve-keys.json"], "no temp file is left");
    rmSync(file);
    assert.equal(writeKeysOnce(file, JSON.stringify(theirs)), true);
    assert.deepEqual(loadOrCreateKeys(env), { ...theirs, file, created: false });
  });

  it("that is not JSON is named without echoing what it holds", () => {
    const env = tmpEnv();
    const file = keysFile(env);
    mkdirSync(dirname(file), { recursive: true });
    const key = generateKey("ingest");
    writeFileSync(file, key);
    assert.throws(() => loadOrCreateKeys(env), (e: unknown) => {
      assert.match(String(e), /serve-keys\.json is not valid JSON/);
      assert.ok(!String(e).includes(key.slice(0, 9)), String(e));
      return true;
    });
  });
});

describe("a mistyped key entry is named by its position", () => {
  const key = generateKey("ingest");
  const cases: [string, () => unknown, RegExp][] = [
    ["ingest, key and project swapped", () => parseIngestKeys(`demo:${generateKey("ingest")}, ${key}:demo`), /CODING_SH_INGEST_KEYS entry 2\b/],
    ["read, bad project", () => parseReadKeys(`${key}:x`), /CODING_SH_READ_KEYS entry 1\b/],
    ["ingest, too short", () => parseIngestKeys("demo:shortsecret1"), /CODING_SH_INGEST_KEYS entry 1\b/],
  ];
  for (const [name, f, re] of cases) {
    it(name, () => {
      assert.throws(f, (e: unknown) => {
        assert.ok(e instanceof KeyFormatError, String(e));
        assert.match(e.message, re);
        assert.ok(!e.message.includes(key.slice(7, 20)), `the error does not echo the entry: ${e.message}`);
        assert.ok(!e.message.includes("shortsecret1"), `the error does not echo the entry: ${e.message}`);
        return true;
      });
    });
  }

  it("the serve config error carries the position too", () => {
    const env = tmpEnv({ CODING_SH_INGEST_KEYS: `${key}:demo` });
    assert.throws(() => resolveServeConfig({}, env), (e: unknown) => {
      assert.ok(e instanceof Error, String(e));
      assert.match(e.message, /CODING_SH_INGEST_KEYS entry 1\b/);
      assert.ok(!e.message.includes(key.slice(7, 20)));
      return true;
    });
  });
});
