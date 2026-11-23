// Commands that take no sink or URL make no request to another host. Each one runs as the tests
// launch the CLI, under a preload that records every outbound connection, DNS query, fetch and
// child process, refuses any that would leave the machine, and follows each node child, even one
// whose env drops it. Sessions come from a recorded Claude Code run. The update check is the one request
// coding.sh makes by default, and it runs only for a person at a terminal, so none of these
// makes it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_HOME_KEYS } from "../_agent-env.ts";
import { CLI } from "../_cli.ts";

const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/real/config", import.meta.url));
const SID = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";

/** The preload. Each record is a JSON line in EGRESS_LOG; EGRESS_GUARD is the flag that loads it. */
const GUARD = String.raw`
import cp from "node:child_process";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const LOG = process.env.EGRESS_LOG;
const SELF = process.env.EGRESS_GUARD;
const rec = (o) => {
  try {
    appendFileSync(LOG, JSON.stringify(Object.assign({ pid: process.pid }, o)) + "\n");
  } catch {}
};
const local = (h) => h === undefined || h === null || h === "" || h === "localhost" || h === "::1" || h === "[::1]" || h === "::" || h === "0.0.0.0" || /^127\./.test(String(h));
const refusal = (what, code) => Object.assign(new Error("egress refused: " + what), { code });
rec({ type: "start", argv: process.argv.slice(2).join(" ").slice(0, 200) });

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let path;
  if (o && typeof o === "object") ({ host, path } = o);
  else if (typeof o === "number" || /^\d+$/.test(String(o))) host = typeof args[1] === "string" ? args[1] : "localhost";
  else path = o;
  const refused = !path && !local(host);
  rec({ type: "connect", host, path: path || undefined, refused });
  if (refused) {
    process.nextTick(() => this.destroy(refusal(String(host), "ECONNREFUSED")));
    return this;
  }
  return connect.apply(this, args);
};

const DNS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
for (const [target, promises] of [[dns, false], [dns.promises, true], [dns.Resolver.prototype, false], [dns.promises.Resolver.prototype, true]]) {
  for (const fn of DNS) {
    const orig = target[fn];
    if (typeof orig !== "function") continue;
    target[fn] = function (name, ...rest) {
      const refused = !local(name);
      rec({ type: "dns", name, refused });
      if (!refused) return orig.call(this, name, ...rest);
      const err = refusal("dns " + name, "ENOTFOUND");
      if (promises) return Promise.reject(err);
      const cb = rest.find((r) => typeof r === "function");
      if (cb) process.nextTick(() => cb(err));
      return undefined;
    };
  }
}

const fetch0 = globalThis.fetch;
globalThis.fetch = function (input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  } catch {}
  const refused = !url || !local(url.hostname);
  rec({ type: "fetch", url: url ? url.origin : String(input), refused });
  if (refused) return Promise.reject(new TypeError("fetch failed", { cause: refusal("fetch", "ECONNREFUSED") }));
  return fetch0.call(this, input, init);
};

// Every child is recorded. A node child keeps this preload even when its env drops it (the read's
// tail child, a detached background command), and a child that names a remote URL is refused.
const REMOTE = /\b(?:https?|wss?|git|ssh):\/\/(?!(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?:[:/]|$))/i;
const fake = () => {
  const on = {};
  const child = { pid: undefined, exitCode: 1, stdout: null, stderr: null, stdin: null, unref() {}, ref() {}, kill: () => false, on: (ev, f) => ((on[ev] ??= []).push(f), child), once: (ev, f) => child.on(ev, f), removeListener: () => child };
  process.nextTick(() => {
    for (const f of on.error ?? []) f(refusal("child process", "EACCES"));
    for (const f of on.exit ?? []) f(1, null);
    for (const f of on.close ?? []) f(1, null);
  });
  return child;
};
for (const fn of ["spawn", "execFile", "exec", "fork", "spawnSync", "execFileSync", "execSync"]) {
  const orig = cp[fn];
  cp[fn] = function (file, args, opts, ...rest) {
    const list = Array.isArray(args);
    let options = list ? opts : args;
    const line = [file, ...(list ? args : [])].map(String).join(" ");
    const base = options && typeof options === "object" && options.env ? options.env : process.env;
    const kept = (fn === "fork" || file === process.execPath) && !String(base.NODE_OPTIONS ?? "").includes(SELF);
    if (kept) options = Object.assign({}, options, { env: Object.assign({}, base, { NODE_OPTIONS: [base.NODE_OPTIONS, SELF].filter(Boolean).join(" "), EGRESS_LOG: LOG, EGRESS_GUARD: SELF }) });
    const refused = REMOTE.test(line);
    rec({ type: "spawn", cmd: line.slice(0, 200), kept, refused });
    if (refused) {
      if (fn.endsWith("Sync")) throw refusal("child " + String(file), "EACCES");
      return fake();
    }
    return list ? orig.call(this, file, args, options, ...rest) : orig.call(this, file, options, opts, ...rest);
  };
}
syncBuiltinESMExports();
`;

interface Rec {
  pid: number;
  type: "start" | "connect" | "dns" | "fetch" | "spawn";
  refused?: boolean;
  argv?: string;
  [k: string]: unknown;
}

/** Commands that read the store, each with nothing that names a sink, a URL or a model. */
const READS = [
  ["sessions"],
  ["show", SID],
  ["replay", SID],
  ["tree", SID],
  ["search", "sed"],
  ["stats"],
  ["usage"],
  ["export", "events"],
  ["sql", "select count(*) as n from sessions"],
  ["status"],
  ["doctor"],
];

describe("commands that take no sink or URL", () => {
  const root = mkdtempSync(join(tmpdir(), "csh-sec-egress-"));
  const log = join(root, "egress.jsonl");
  let env: NodeJS.ProcessEnv;

  const records = (): Rec[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Rec);

  /** Runs one command under the preload; resolves its exit code and output. */
  const run = (args: string[]): Promise<{ args: string[]; code: number | null; out: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: join(root, "work"), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c));
      child.stderr.on("data", (c: Buffer) => (out += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ args, code, out }));
    });

  before(() => {
    const home = join(root, "home");
    const empty = join(root, "bin");
    for (const d of [home, empty, join(root, "work")]) mkdirSync(d, { recursive: true });
    const guard = join(root, "guard.mjs");
    writeFileSync(guard, GUARD);
    writeFileSync(log, "");
    const flag = `--import=${pathToFileURL(guard).href}`;
    env = { ...process.env };
    // Neither an agent home nor an opt-out from the machine running the test: the defaults, here.
    for (const k of [...AGENT_HOME_KEYS, "CI", "GITHUB_ACTIONS", "NO_UPDATE_NOTIFIER", "CODING_SH_NO_UPDATE_CHECK"]) delete env[k];
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
    Object.assign(env, {
      ["HO" + "ME"]: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      CODING_SH_HOME: join(home, ".coding.sh"),
      CLAUDE_CONFIG_DIR: CONFIG,
      CODEX_HOME: join(root, "codex"),
      T3CODE_HOME: join(root, "t3"),
      // An empty PATH: no agent binary on the machine is found or launched.
      PATH: empty,
      NO_COLOR: "1",
      TZ: "UTC",
      EGRESS_LOG: log,
      EGRESS_GUARD: flag,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, flag].filter(Boolean).join(" "),
    });
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "ingest", "--backfill", "--agent", "claude-code"], { env, cwd: join(root, "work"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("ingest, reads, doctor and status reach nothing but loopback", async () => {
    // The reads find the store already indexed: no background ingest outlives them.
    env.CODING_SH_NO_AUTO_INGEST = "1";
    const results = await Promise.all(READS.map(run));
    for (const r of results) assert.equal(r.code, 0, `${r.args.join(" ")}: ${r.out.slice(-400)}`);
    assert.match(results[0]!.out, /cd0185b0/, "the sessions list shows the recorded session");
    const recs = records();
    const started = recs.filter((x) => x.type === "start").map((x) => x.argv ?? "");
    for (const args of [["ingest"], ...READS]) assert.ok(started.some((a) => a.includes(args.join(" "))), `the preload ran in ${args.join(" ")}`);
    assert.deepEqual(recs.filter((x) => x.refused), [], "nothing tried to leave the machine");
  });

  it("the preload refuses a request to another host, also from a node child that drops it", async () => {
    const probe = join(root, "probe.mjs");
    writeFileSync(
      probe,
      String.raw`import { spawn } from "node:child_process";
import net from "node:net";
await fetch("https://registry.example.invalid/x").catch(() => {});
await new Promise((r) => net.connect(443, "egress-probe.invalid").on("error", r).on("connect", r));
// The URL is built in the child, so its command line names none.
const code = "fetch(['https:', '', 'registry.example.invalid', 'y'].join('/')).catch(() => {})";
const env = { SYSTEMROOT: process.env.SYSTEMROOT ?? "" };
await new Promise((r) => spawn(process.execPath, ["-e", code], { env, detached: true, stdio: "ignore" }).on("error", r).on("exit", r));
`,
    );
    const from = records().length;
    const r = spawnSync(process.execPath, [probe], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const refused = records()
      .slice(from)
      .filter((x) => x.refused);
    assert.deepEqual(refused.map((x) => x.type), ["fetch", "connect", "fetch"]);
    assert.notEqual(refused[2]!.pid, refused[0]!.pid, "the child's own fetch, under the preload it dropped");
  });
});
