#!/usr/bin/env node
// The repo gate: every check a change must pass before it is committed, in one
// command. Zero dependencies.
//
//   npm run gate                       # every step, stops at the first FAIL
//   npm run gate -- --static           # the steps that need no build or Docker (CI's gate-static job)
//   npm run gate -- --only lint        # one step
//   npm run gate -- --from build       # a step and the ones after it
//   npm run gate -- --list [--json]    # the steps
//   npm run gate -- --strict           # a SKIP or a WARN fails too
//
// Every child process gets a fresh temp HOME, CODING_SH_HOME and agent homes, so
// the gate never reads or writes the real ones. It refuses to start when
// CODING_SH_DEV_REAL_STORE is set. See CONTRIBUTING.md "Lint and git hooks".
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterVersions, branchFresh, repoHygiene, secretScan } from "./gate/checks.mjs";
import { needsShell } from "./hooks/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- environment

/** The variables each child gets its own temp directory for. */
export const ISOLATED = {
  HOME: "home",
  USERPROFILE: "home",
  CODING_SH_HOME: "coding.sh",
  CLAUDE_CONFIG_DIR: "claude",
  CODEX_HOME: "codex",
  GEMINI_HOME: "gemini",
  COPILOT_HOME: "copilot",
  PI_CODING_AGENT_DIR: "pi",
  npm_config_prefix: "npm-prefix",
};

/** Variables that point a child at settings or a store of the person running the gate. */
const SCRUBBED = ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_URL", "CODING_SH_FORWARD_URL", "CODING_SH_DEV_REAL_STORE"];

/** A child environment with every home variable pointing into a new temp directory. Returns it with the directory to remove. */
export function isolatedEnv(base = process.env, make = () => mkdtempSync(join(tmpdir(), "coding-sh-gate-"))) {
  const dir = make();
  const env = { ...base };
  for (const k of SCRUBBED) delete env[k];
  for (const [k, sub] of Object.entries(ISOLATED)) {
    env[k] = join(dir, sub);
    mkdirSync(env[k], { recursive: true });
  }
  return { env, dir };
}

/** The reason the gate must not start, or undefined. */
export const refusal = (env = process.env) =>
  env.CODING_SH_DEV_REAL_STORE ? "CODING_SH_DEV_REAL_STORE is set: a dev build would open and migrate your real coding.sh store. Unset it and rerun." : undefined;

// ---------------------------------------------------------------- the runner

const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Runs steps in order and stops at the first FAIL. A step is
 * `{ name, rerun?, run(ctx) }` and returns `{ status: "pass"|"fail"|"skip"|"warn", detail?: string[], exit?: number }`.
 * `io`: `out(text)`, `strict` (a SKIP or WARN fails), `ctx` (handed to every step), `now()`.
 * Returns `{ code, results }`.
 */
export async function runPlan(steps, io = {}) {
  const { out = (s) => process.stdout.write(s), strict = false, ctx = {}, now = () => performance.now() } = io;
  const results = [];
  let failed;
  for (const [i, step] of steps.entries()) {
    out(`gate [${i + 1}/${steps.length}] ${step.name}\n`);
    const t0 = now();
    let r;
    try {
      r = await step.run(ctx);
    } catch (e) {
      r = { status: "fail", detail: [e instanceof Error ? e.message : String(e)] };
    }
    let status = r.status;
    const detail = [...(r.detail ?? [])];
    if (strict && (status === "skip" || status === "warn")) {
      detail.push(`--strict: a ${status.toUpperCase()} fails the gate`);
      status = "fail";
    }
    const ms = now() - t0;
    results.push({ name: step.name, status, ms, detail });
    out(`  ${status.toUpperCase()} (${fmtMs(ms)})\n`);
    for (const d of detail) out(`  ${d}\n`);
    if (status === "fail") {
      failed = { step, exit: r.exit ?? 1 };
      break;
    }
  }

  const rows = [...results];
  for (const s of steps.slice(results.length)) rows.push({ name: s.name, status: "not run", ms: 0, detail: [] });
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  out(`\ngate summary\n`);
  for (const r of rows) out(`  ${r.name.padEnd(width)}  ${r.status.toUpperCase().padEnd(7)}  ${r.status === "not run" ? "" : fmtMs(r.ms)}\n`);
  const skipped = results.filter((r) => r.status === "skip");
  if (skipped.length) {
    out(`\nSKIPPED, so these were not checked here:\n`);
    for (const r of skipped) out(`  ${r.name}: ${r.detail[0] ?? "no reason given"}\n`);
  }
  const warned = results.filter((r) => r.status === "warn");
  if (warned.length) {
    out(`\nWARNINGS:\n`);
    for (const r of warned) out(`  ${r.name}: ${r.detail[0] ?? ""}\n`);
  }
  if (failed) {
    out(`\ngate: FAILED at ${failed.step.name} (exit ${failed.exit}); rerun: ${failed.step.rerun ?? `npm run gate -- --only ${failed.step.name}`}\n`);
    return { code: 1, results };
  }
  out(`\ngate: ok (${results.length} step${results.length === 1 ? "" : "s"})${skipped.length || warned.length ? `, ${skipped.length} skipped, ${warned.length} warned` : ""}\n`);
  return { code: 0, results };
}

// ---------------------------------------------------------------- running commands

/** Children still running, so an interrupted gate can stop them. */
const running = new Set();

/** Runs a command, streaming its output; resolves with its exit code and everything it printed. */
export function exec(cmd, args, { cwd, env, write = (s) => process.stdout.write(s) } = {}) {
  return new Promise((done) => {
    let out = "";
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: needsShell(cmd) });
    running.add(child);
    child.on("exit", () => running.delete(child));
    const take = (b) => {
      const s = b.toString();
      out += s;
      write(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => done({ code: 127, out: `${out}${e.message}\n` }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

const which = async (cmd, probe = ["--version"]) => (await exec(cmd, probe, { write: () => {} })).code === 0;
const quote = (a) => (/^[\w./:=@%+-]+$/.test(a) ? a : JSON.stringify(a));
const show = (cmd, args) => [cmd, ...args].map(quote).join(" ");

/** A step that runs commands in sequence in a fresh isolated environment and fails on the first non-zero exit. */
function commands(name, list, { rerun, after } = {}) {
  return {
    name,
    rerun,
    async run(ctx) {
      const { env, dir } = ctx.isolated();
      try {
        for (const c of list(ctx)) {
          ctx.say(`$ ${c.cwd && c.cwd !== "." ? `(cd ${c.cwd}) ` : ""}${show(c.cmd, c.args)}\n`);
          const r = await exec(c.cmd, c.args, { cwd: join(ctx.root, c.cwd ?? "."), env: { ...env, ...c.env }, write: ctx.say });
          if (r.code !== 0) return { status: "fail", exit: r.code, detail: [`${show(c.cmd, c.args)} exited ${r.code}`] };
          const extra = after?.(c, r);
          if (extra) return extra;
        }
        return { status: "pass" };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------- store plugins

/** A free TCP port on localhost. */
const freePort = () =>
  new Promise((ok, no) => {
    const s = net.createServer();
    s.once("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

/** Waits until `probe()` resolves true, for at most `ms`. */
async function until(probe, ms, wait = (n) => new Promise((r) => setTimeout(r, n))) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(500)) if (await probe()) return true;
  return false;
}

export const POSTGRES_IMAGE = "postgres:17";
export const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:26.3.62.3";

/** `coding.sh/store` must resolve into the tree under test, or the plugin tests prove nothing about it. */
async function resolvesHere(ctx, dir, env) {
  const probe = "console.log(import.meta.resolve('coding.sh/store'))";
  const r = await exec(process.execPath, ["--input-type=module", "-e", probe], { cwd: join(ctx.root, dir), env, write: () => {} });
  if (r.code !== 0) return `coding.sh/store does not resolve from ${dir}; run npm ci in the repo root`;
  const url = r.out.trim();
  const here = pathToFileURL(realpathSync(ctx.root)).href;
  return url.startsWith(`${here}/`) ? undefined : `coding.sh/store resolves to ${url}, outside this tree; run npm ci here and do not symlink node_modules`;
}

/**
 * Docker Postgres and ClickHouse (labeled gate=<pid>, always removed), then
 * `npm run check` in store-postgres, store-clickhouse and blob-s3. Without
 * Docker the two database plugins are skipped, loudly; blob-s3 always runs.
 * `ctx.docker(args)` and `ctx.run(...)` can be replaced in tests.
 */
export function storePlugins() {
  return {
    name: "store-plugins",
    async run(ctx) {
      const docker = ctx.docker ?? ((args) => exec("docker", args, { write: () => {} }));
      const check = ctx.check ?? (async (dir, extra) => {
        const { env, dir: tmp } = ctx.isolated();
        try {
          const problem = await resolvesHere(ctx, dir, env);
          if (problem) return { code: 1, problem };
          ctx.say(`$ (cd ${dir}) npm run check\n`);
          return await exec("npm", ["run", "check"], { cwd: join(ctx.root, dir), env: { ...env, ...extra }, write: ctx.say });
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
      const wait = ctx.wait ?? ((n) => new Promise((r) => setTimeout(r, n)));
      const label = `gate=${process.pid}`;
      const skipped = [];
      let pg;
      let ch;
      try {
        if ((await docker(["info"])).code === 0) {
          const [pgPort, chPort] = [await freePort(), await freePort()];
          const up = await Promise.all([
            docker(["run", "-d", "--label", label, "-e", "POSTGRES_PASSWORD=ci", "-e", "POSTGRES_DB=coding", "-p", `127.0.0.1:${pgPort}:5432`, POSTGRES_IMAGE]),
            docker(["run", "-d", "--label", label, "-e", "CLICKHOUSE_USER=coding", "-e", "CLICKHOUSE_PASSWORD=ci", "-p", `127.0.0.1:${chPort}:8123`, CLICKHOUSE_IMAGE]),
          ]);
          if (up[0].code !== 0 || up[1].code !== 0) return { status: "fail", detail: [`docker run failed: ${(up[0].code !== 0 ? up[0] : up[1]).out.trim().split("\n").pop()}`] };
          [pg, ch] = [up[0].out.trim().split("\n").pop(), up[1].out.trim().split("\n").pop()];
          const pgReady = await until(async () => (await docker(["exec", pg, "pg_isready", "-U", "postgres"])).code === 0, 90_000, wait);
          const chReady = await until(async () => (await docker(["exec", ch, "wget", "-qO-", "http://127.0.0.1:8123/ping"])).code === 0, 90_000, wait);
          if (!pgReady || !chReady) return { status: "fail", detail: [`${pgReady ? "ClickHouse" : "Postgres"} did not become ready in 90s`] };
          for (const [dir, extra] of [
            ["packages/store-postgres", { CODING_SH_TEST_PG_URL: `postgres://postgres:ci@127.0.0.1:${pgPort}/coding` }],
            ["packages/store-clickhouse", { CODING_SH_TEST_CH_URL: `clickhouse://coding:ci@127.0.0.1:${chPort}/coding` }],
          ]) {
            const r = await check(dir, extra);
            if (r.code !== 0) return { status: "fail", exit: r.code, detail: [r.problem ?? `npm run check in ${dir} exited ${r.code}`] };
          }
        } else skipped.push("store-postgres and store-clickhouse were not run: Docker is not reachable (start Docker; CI runs them)");
        const r = await check("packages/blob-s3", {});
        if (r.code !== 0) return { status: "fail", exit: r.code, detail: [r.problem ?? `npm run check in packages/blob-s3 exited ${r.code}`] };
        return skipped.length ? { status: "skip", detail: skipped } : { status: "pass" };
      } finally {
        const ids = [pg, ch].filter(Boolean);
        if (ids.length) await docker(["rm", "-f", "-v", ...ids]);
        // A run that died before it knew its ids still leaves nothing behind.
        const left = (await docker(["ps", "-aq", "--filter", `label=${label}`])).out.trim();
        if (left) await docker(["rm", "-f", "-v", ...left.split(/\s+/)]);
      }
    },
  };
}

/** The modules the Python SDK's optional tests import (typing, otel export, the real SDK wrappers). */
export const PYTHON_TEST_MODULES = ["mypy", "opentelemetry.sdk", "opentelemetry.exporter.otlp.proto.http", "openai", "anthropic"];

const PYTHON_PROBE = [
  "import importlib.util, sys",
  "def has(m):",
  "    try:",
  "        return importlib.util.find_spec(m) is not None",
  "    except ImportError:",
  "        return False",
  "print(' '.join(m for m in sys.argv[1:] if not has(m)))",
].join("\n");

/**
 * The Python SDK's tests. When python3 has every module in PYTHON_TEST_MODULES, they run
 * with CODING_SH_SDK_REQUIRE_ALL=1, so no test may skip. When a module is missing they run
 * without it and the step is a SKIP that names the modules and the install command, so a
 * green gate never hides tests that did not run. `ctx.exec` can be replaced in tests.
 */
export function pythonSdk() {
  return {
    name: "python-sdk",
    async run(ctx) {
      const run = ctx.exec ?? exec;
      if ((await run("python3", ["--version"], { write: () => {} })).code !== 0) return { status: "skip", detail: ["python3 is not on PATH; CI runs the Python SDK tests on 3.9 and 3.13"] };
      const probe = await run("python3", ["-c", PYTHON_PROBE, ...PYTHON_TEST_MODULES], { write: () => {} });
      const missing = probe.code === 0 ? probe.out.trim().split(/\s+/).filter(Boolean) : PYTHON_TEST_MODULES;
      const { env, dir } = ctx.isolated();
      try {
        const args = ["-m", "unittest", "discover", "-s", "tests"];
        const extra = missing.length ? {} : { CODING_SH_SDK_REQUIRE_ALL: "1" };
        ctx.say(`$ (cd packages/sdk-python) ${missing.length ? "" : "CODING_SH_SDK_REQUIRE_ALL=1 "}${show("python3", args)}\n`);
        const r = await run("python3", args, { cwd: join(ctx.root, "packages/sdk-python"), env: { ...env, ...extra }, write: ctx.say });
        if (r.code !== 0) return { status: "fail", exit: r.code, detail: [`${show("python3", args)} exited ${r.code}`] };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (!missing.length) return { status: "pass" };
      return {
        status: "skip",
        detail: [
          `tests that need ${missing.join(", ")} were skipped: python3 cannot import ${missing.length === 1 ? "it" : "them"}`,
          "install them with (cd packages/sdk-python && python3 -m pip install '.[otel,openai,anthropic]' mypy), as CI does",
        ],
      };
    },
  };
}

/**
 * What an interrupted gate (Ctrl-C, SIGTERM) cleans up before it exits: the
 * children it started, the containers labeled gate=<pid> and its temp homes.
 * Synchronous, since it runs inside a signal handler. `docker` can be replaced in tests.
 */
export function interruptCleanup({ made, label = `gate=${process.pid}`, children = running, docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 }) }) {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  const ps = docker(["ps", "-aq", "--filter", `label=${label}`]);
  const ids = (ps?.stdout ?? "").trim();
  if (ps?.status === 0 && ids) docker(["rm", "-f", "-v", ...ids.split(/\s+/)]);
  for (const d of made) rmSync(d, { recursive: true, force: true });
}

/** Installs the SIGINT and SIGTERM handlers; returns the function that removes them. */
function onInterrupt(made, stderr) {
  const handlers = {};
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    handlers[sig] = () => {
      stderr.write(`\ngate: ${sig}: removing its containers and temp homes\n`);
      interruptCleanup({ made });
      process.exit(code);
    };
    process.on(sig, handlers[sig]);
  }
  return () => {
    for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);
  };
}

// ---------------------------------------------------------------- the steps

/** The workflow files actionlint reads. */
const workflowFiles = (root) => {
  const dir = join(root, ".github", "workflows");
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => `.github/workflows/${f}`) : [];
};

const GENERATED = [
  "test/docs/cli-reference.test.ts",
  "test/docs/sdk-reference.test.ts",
  "test/integrations/gateway/sdk-tables.test.ts",
  "test/schema/json-schema.test.ts",
  "test/docs/api-reference.test.ts",
];

const SKIPPED_TESTS = /^(?:# |ℹ )skipped (\d+)/m;

/**
 * The plan, in order. `static` steps need no build and no Docker. `opts.env`
 * is the environment the in-process git checks read.
 */
export function buildSteps(root = ROOT, opts = {}) {
  const env = opts.env ?? process.env;
  const node = process.execPath;
  const inCI = Boolean(env.GITHUB_ACTIONS);
  return [
    {
      name: "repo-hygiene",
      static: true,
      description: "git identity, private agent files untracked",
      run: async () => repoHygiene(root, { env, ci: inCI, range: env.GATE_COMMIT_RANGE || undefined }),
    },
    {
      name: "branch-fresh",
      static: true,
      description: "origin/main is in this branch",
      // CI checks out a merge commit; freshness is a question for a branch on a person's machine.
      run: async () => (inCI ? { status: "pass", detail: ["CI checks out a merge commit; not checked"] } : branchFresh(root, { env })),
    },
    { ...commands("lint", () => [{ cmd: node, args: ["scripts/lint/slop.mjs", "--strict-allowlist"] }]), static: true, description: "the anti-slop lint" },
    { ...commands("lint-test", () => [{ cmd: "npm", args: ["run", "lint:test"] }]), static: true, description: "tests of the lint, the hooks and the gate" },
    {
      name: "actionlint",
      static: true,
      description: "actionlint on the workflows",
      async run(ctx) {
        if (!(await which("actionlint", ["-version"]))) return { status: "skip", detail: ["actionlint is not on PATH; CI installs it (brew install actionlint)"] };
        const args = ["-shellcheck=", ...workflowFiles(root)];
        ctx.say(`$ ${show("actionlint", args)}\n`);
        const r = await exec("actionlint", args, { cwd: root, env, write: ctx.say });
        return r.code === 0 ? { status: "pass" } : { status: "fail", exit: r.code, detail: [`actionlint exited ${r.code}`] };
      },
    },
    {
      ...commands("generated-fresh", () => {
        const list = [{ cmd: node, args: ["--no-warnings", "--test", ...GENERATED], cwd: "packages/coding.sh" }];
        if (existsSync(join(root, "apps/site/test/og-fresh.test.mjs"))) list.push({ cmd: node, args: ["--no-warnings", "--test", "apps/site/test/og-fresh.test.mjs"] });
        return list;
      }),
      static: true,
      description: "generated docs, schema and cards are fresh",
    },
    {
      ...commands("coding.sh-check", () => [
        { cmd: "npx", args: ["tsc", "--noEmit", "-p", "."], cwd: "packages/coding.sh" },
        { cmd: node, args: ["scripts/test-ci.mjs"], cwd: "packages/coding.sh" },
        { cmd: "npm", args: ["run", "check"], cwd: "packages/sdk" },
      ]),
      description: "typecheck and every test of coding.sh, then the SDK",
    },
    {
      ...commands("coding.sh-build", () => [
        { cmd: "npm", args: ["run", "build"], cwd: "packages/coding.sh" },
        { cmd: node, args: ["dist/cli.mjs", "--version"], cwd: "packages/coding.sh" },
        { cmd: node, args: ["dist/cli.mjs", "--help"], cwd: "packages/coding.sh" },
      ]),
      description: "build dist and run the bundle",
    },
    { ...storePlugins(), description: "store-postgres, store-clickhouse (Docker) and blob-s3" },
    { ...pythonSdk(), description: "the Python SDK's tests, with every optional test required to run" },
    {
      ...commands(
        "site",
        () => [
          { cmd: "npm", args: ["run", "build"], cwd: "apps/site" },
          { cmd: "npm", args: ["run", "check"], cwd: "apps/site", env: { CODING_SH_REQUIRE_DIST: "1" } },
        ],
        {
          // The dist tests skip without a build; a skip here means a check did not run.
          after: (c, r) => {
            const n = c.args[1] === "check" ? Number(SKIPPED_TESTS.exec(r.out)?.[1] ?? 0) : 0;
            return n > 0 ? { status: "fail", detail: [`${n} site test${n === 1 ? "" : "s"} skipped; with CODING_SH_REQUIRE_DIST=1 none may skip`] } : undefined;
          },
        },
      ),
      description: "site build, astro check and its tests (none may skip)",
    },
    { name: "secret-scan", static: true, description: "vendor-shaped secrets in built output", run: async (ctx) => secretScan(root, { static: ctx.static }) },
    { name: "adapter-versions", description: "parseVersion and SESSION_FOLD_VERSION bumps (warns)", run: async () => adapterVersions(root, { env }) },
  ];
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage: npm run gate -- [flags]

Runs every check a change must pass. Stops at the first FAIL. Exit 0: ok; 1: a step failed; 2: usage.

Flags:
  --static         Only the steps that need no build and no Docker (what CI's gate-static job runs)
  --only <name>    One step (repeatable)
  --from <name>    This step and the ones after it
  --list           Print the steps and exit (with --json: as data)
  --strict         A SKIP or a WARN fails the gate
  --help           Show this help
`;

export function parseArgs(argv) {
  const o = { only: [], static: false, list: false, json: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") ? a.split(/=(.*)/s, 2) : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a step name`);
      return v;
    };
    if (flag === "--static") o.static = true;
    else if (flag === "--list") o.list = true;
    else if (flag === "--json") o.json = true;
    else if (flag === "--strict") o.strict = true;
    else if (flag === "--help" || flag === "-h") o.help = true;
    else if (flag === "--only") o.only.push(value());
    else if (flag === "--from") o.from = value();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Picks the steps a run covers. Throws on a name that is not a step. */
export function selectSteps(all, o) {
  const names = all.map((s) => s.name);
  const named = o.from ? [...o.only, o.from] : o.only;
  for (const n of named) if (!names.includes(n)) throw new Error(`unknown step ${JSON.stringify(n)}; steps: ${names.join(", ")}`);
  let steps = all;
  if (o.static) {
    steps = steps.filter((s) => s.static);
    const dropped = named.filter((n) => !steps.some((s) => s.name === n));
    if (dropped.length) throw new Error(`${dropped.join(", ")} ${dropped.length === 1 ? "is not a static step" : "are not static steps"}; drop --static, or name one of: ${steps.map((s) => s.name).join(", ")}`);
  }
  if (o.from) steps = steps.slice(steps.findIndex((s) => s.name === o.from));
  if (o.only.length) steps = steps.filter((s) => o.only.includes(s.name));
  // A selection that runs nothing would print "gate: ok (0 steps)" and pass.
  if (!steps.length) throw new Error(`nothing to run: no step is in --only ${o.only.join(",")} and at or after --from ${o.from}`);
  return steps;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, root = ROOT } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    stderr.write(`error: ${e.message}\nnext: npm run gate -- --help\n`);
    return 2;
  }
  if (o.help) {
    stdout.write(USAGE);
    return 0;
  }
  const all = buildSteps(root, { env });
  if (o.list) {
    if (o.json) stdout.write(`${JSON.stringify(all.map((s) => ({ name: s.name, static: Boolean(s.static), description: s.description })))}\n`);
    else for (const s of all) stdout.write(`${s.name.padEnd(18)}${s.static ? "static  " : "        "}${s.description}\n`);
    return 0;
  }
  const refused = refusal(env);
  if (refused) {
    stderr.write(`error: ${refused}\n`);
    return 2;
  }
  let steps;
  try {
    steps = selectSteps(all, o);
  } catch (e) {
    stderr.write(`error: ${e.message}\nnext: npm run gate -- --list\n`);
    return 2;
  }
  return runSteps(steps, { out: (s) => stdout.write(s), stderr, strict: o.strict, env, root, static: o.static });
}

/**
 * Runs the steps with fresh temp homes, removed at the end and on Ctrl-C or
 * SIGTERM (exit 130 or 143), together with any labeled containers.
 */
export async function runSteps(steps, { out = (s) => process.stdout.write(s), stderr = process.stderr, strict, env = process.env, root = ROOT, static: isStatic } = {}) {
  const made = [];
  const ctx = {
    root,
    static: isStatic,
    say: out,
    isolated: () => {
      const iso = isolatedEnv(env);
      made.push(iso.dir);
      return iso;
    },
  };
  const off = onInterrupt(made, stderr);
  try {
    return (await runPlan(steps, { out, strict, ctx })).code;
  } finally {
    off();
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
