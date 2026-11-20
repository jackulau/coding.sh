// Shared helpers for the dogfood scorer. Zero dependencies, Node >= 22.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PKG = join(REPO, "packages", "coding.sh");
export const DIST = join(PKG, "dist");
export const CLI = join(DIST, "cli.mjs");
export const HOOK = join(DIST, "hook.mjs");
export const SITE = join(REPO, "apps", "site");
export const DOGFOOD_TASKS = join(REPO, "tasks", "dogfood");
export const EVALS_CLI = join(REPO, "evals", "cli");

/** Fresh temp dir with symlinks resolved (macOS /var → /private/var), so paths match what tools print. */
export function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Env for anything that might touch agent or coding.sh state: HOME and CODING_SH_HOME in a temp dir. */
export function isolatedEnv(root, extra = {}) {
  const home = join(root, "home");
  const env = { ...process.env };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "FORCE_COLOR", "NO_COLOR", "CODING_SH_RUN_ID", "CODING_SH_SESSION_ID", "CI"]) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), ...extra };
}

/**
 * On Windows npm and npx are .cmd shims, which spawn runs only through a shell. The line is passed
 * whole (the scripts' npm arguments have no spaces or quotes), as Node deprecates args with shell.
 */
function spawnArgs(cmd, args, opts) {
  if (process.platform !== "win32" || (cmd !== "npm" && cmd !== "npx") || opts.shell !== undefined) return [cmd, args, opts];
  return [[cmd, ...args].join(" "), [], { ...opts, shell: true }];
}

/** Run a command synchronously and return { code, stdout, stderr, ms }. Never throws on non-zero exit. */
export function sh(cmd, args, opts = {}) {
  const t0 = performance.now();
  const r = spawnSync(...spawnArgs(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20, ...opts }));
  return { code: r.status ?? (r.signal ? 128 : 1), signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: performance.now() - t0, error: r.error };
}

/** Async spawn with timeout; resolves { code, stdout, stderr, ms, timedOut }. */
export function shAsync(cmd, args, opts = {}) {
  const { timeoutMs = 600_000, input, onStdout, ...rest } = opts;
  return new Promise((resolveP) => {
    const t0 = performance.now();
    const p = spawn(...spawnArgs(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...rest }));
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    p.stdout.on("data", (d) => {
      stdout += d;
      onStdout?.(String(d));
    });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: 127, stdout, stderr: stderr + String(e), ms: performance.now() - t0, timedOut });
    });
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveP({ code: code ?? (signal ? 128 : 1), stdout, stderr, ms: performance.now() - t0, timedOut });
    });
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

/** The stderr line that names the error: the first that reads like one, else the first non-empty line. */
export function firstErrorLine(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /\b(error|fatal|cannot|can't|couldn't|not found|no such|denied|ENOENT|EACCES|EPERM)\b|✗/i.test(l)) ?? lines[0] ?? "").slice(0, 300);
}

/** The PATH value of `env`, whatever the key's case (Windows spells it "Path"). */
export function pathOf(env) {
  return Object.entries(env).find(([k, v]) => k.toUpperCase() === "PATH" && v)?.[1];
}

/**
 * Env for Chrome and lighthouse. On Windows, Chrome refuses remote debugging ("requires a
 * non-default data directory", even with --user-data-dir) when USERPROFILE has no AppData\Local,
 * as in the temp homes the benches use. Make that folder when it is missing and point LOCALAPPDATA at it.
 */
export function browserEnv(env = process.env, platform = process.platform) {
  const profile = platform === "win32" ? env.USERPROFILE : undefined;
  if (!profile) return env;
  const local = join(profile, "AppData", "Local");
  if (!existsSync(local)) mkdirSync(local, { recursive: true });
  return { ...env, LOCALAPPDATA: local };
}

export const LIGHTHOUSE_HINT = "run npm ci at the repo root (apps/site has lighthouse as a devDependency), or put a lighthouse CLI on PATH";

/**
 * The lighthouse CLI as { cmd, args, shell, source }, or undefined. First the copy npm installed for
 * the site, run as `node <its cli/index.js>` so no shim is involved; then one on PATH. On Windows an
 * npm-installed CLI on PATH is a .cmd shim, which spawn starts only through a shell (`shell: true`),
 * and the extensionless sh shim next to it is not a program Windows can start at all.
 */
export function findLighthouse({ env = process.env, platform = process.platform, from = [SITE, REPO] } = {}) {
  for (const start of from) {
    for (let d = resolve(start); ; d = dirname(d)) {
      const pkgPath = join(d, "node_modules", "lighthouse", "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.lighthouse;
          if (bin && existsSync(join(dirname(pkgPath), bin))) return { cmd: process.execPath, args: [join(dirname(pkgPath), bin)], shell: false, source: `node_modules (lighthouse ${pkg.version})` };
        } catch {}
      }
      if (dirname(d) === d) break;
    }
  }
  const names = platform === "win32" ? ["lighthouse.cmd", "lighthouse.exe"] : ["lighthouse"];
  for (const dir of (pathOf(env) ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return { cmd: p, args: [], shell: n.endsWith(".cmd"), source: p };
    }
  }
  return undefined;
}

/** Runs lighthouse with `args` (URLs and flags, no quotes): { code, stdout, stderr, error }. */
export function runLighthouse(lh, args, opts = {}) {
  if (!lh.shell) return sh(lh.cmd, [...lh.args, ...args], opts);
  const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a);
  return sh([lh.cmd, ...lh.args, ...args].map(q).join(" "), [], { ...opts, shell: true });
}

/**
 * The report from a lighthouse run. Its stdout counts even on a non-zero exit (on Windows lighthouse
 * can print the report, then fail to delete Chrome's temp profile and exit 1). A run that printed no
 * report throws with the exit code and the error line, and names Chrome when Chrome was not found.
 */
export function lighthouseReport(r) {
  try {
    const rep = JSON.parse(r.stdout);
    if (rep && typeof rep === "object" && rep.audits) return rep;
  } catch {}
  const line = firstErrorLine(r.stderr) || r.error?.code || "no report on stdout";
  const e = new Error(`lighthouse exited ${r.code}: ${line}`);
  if (/no chrome installations found|CHROME_PATH/i.test(r.stderr ?? "")) e.missing = "Chrome (install Google Chrome or set CHROME_PATH)";
  throw e;
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // a torn last line is skipped
    }
  }
  return out;
}

/** sha256 over every path + file content under root (symlinks hashed by target). Order-independent of readdir. */
export function treeHash(root) {
  const h = createHash("sha256");
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isDirectory()) {
        h.update(`d:${rel}\n`);
        walk(p);
      } else if (st.isSymbolicLink()) h.update(`l:${rel}\n`);
      else {
        h.update(`f:${rel}:${st.size}\n`);
        h.update(readFileSync(p));
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

export function git(args, cwd = REPO) {
  const r = sh("git", args, { cwd });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

// ---------------------------------------------------------------- stats

export function median(xs) {
  return quantile(xs, 0.5);
}

/** Linear-interpolated quantile (for benchmark timings). */
export function quantile(xs, q) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Nearest-rank percentile (the definition coding.sh uses for latency stats). */
export function nearestRank(xs, p) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

/** Wilson score interval, 95%. */
export function wilson(successes, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const w = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - w), Math.min(1, c + w)];
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap 95% CI of median(b) − median(a) over paired samples (a[i], b[i] measured back to back). */
export function bootstrapMedianDiff(a, b, iters = 2000, seed = 1) {
  const n = Math.min(a.length, b.length);
  if (!n) return undefined;
  const rnd = prng(seed);
  const diffs = [];
  for (let k = 0; k < iters; k++) {
    const sa = [];
    const sb = [];
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rnd() * n);
      sa.push(a[idx]);
      sb.push(b[idx]);
    }
    diffs.push(median(sb) - median(sa));
  }
  return { diff: median(b.slice(0, n)) - median(a.slice(0, n)), ci: [quantile(diffs, 0.025), quantile(diffs, 0.975)] };
}

export function round(x, digits = 2) {
  if (x === undefined || x === null || !Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Parse `--flag value` / `--flag=value` / `--bool` argv into an object; repeated flags become arrays. */
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v === undefined) {
      if (booleans.includes(k)) v = true;
      else v = argv[++i];
    }
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function log(...a) {
  process.stderr.write(a.join(" ") + "\n");
}
