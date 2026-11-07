// CLI tap (§5.3): `bin/<bin>` in the sandbox is a standalone Node shim that
// execs the real command, passes stdin/stdout/stderr through unchanged, and
// appends one TapRecord per call to tap.jsonl. durationMs covers the real
// binary only (spawn → exit), so shim startup is excluded.
//
// The shim is generated source with no imports beyond node builtins, so it
// starts fast and works the same from src/ and from the dist bundle. The
// classifier is embedded via Function.prototype.toString, so it must stay
// self-contained (no references outside its own body).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TapClass } from "../types.ts";

export interface CliClassifyConfig {
  usageExitCodes: number[];
  usagePatterns: string[];
}

export const DEFAULT_USAGE_PATTERNS = ["unknown (option|flag|command|subcommand|argument)", "unrecognized", "did you mean", "^usage:"];

/** Class and reason for one CLI call. Self-contained: embedded in the shim as source. */
export function classifyCli(argv: string[], exitCode: number | null, stderr: string, cfg: CliClassifyConfig): { class: TapClass; reason?: string } {
  const positionals = argv.filter((a) => !a.startsWith("-"));
  if (argv.includes("--help") || argv.includes("-h") || positionals[0] === "help") return { class: "help" };
  if (argv.includes("--version") && positionals.length === 0) return { class: exitCode === 0 ? "meta" : "invalid", reason: exitCode === 0 ? undefined : "unknown-flag" };
  if (exitCode === 127 || exitCode === 126) return { class: "invalid", reason: "not-found" };
  const reasonOf = (text: string): string => {
    if (/unknown (option|flag)|unrecognized (option|flag|argument)|invalid option|no such option/i.test(text)) return "unknown-flag";
    if (/unknown (sub)?command|did you mean|no such command|is not a .*command|unknown argument/i.test(text)) return "unknown-command";
    if (/missing|required|needs a value|expects? (an? )?(argument|value)|not enough arguments/i.test(text)) return "missing-arg";
    if (/not found|no such file/i.test(text)) return "not-found";
    return "usage";
  };
  const matches = (cfg.usagePatterns || []).some((p) => {
    try {
      return new RegExp(p, "im").test(stderr);
    } catch {
      return false;
    }
  });
  if ((exitCode !== null && (cfg.usageExitCodes || []).includes(exitCode)) || (exitCode !== 0 && matches)) return { class: "invalid", reason: reasonOf(stderr) };
  if (exitCode === 0 && matches && /unknown (option|flag|command)|unrecognized/i.test(stderr)) return { class: "invalid", reason: reasonOf(stderr) };
  if (exitCode === null) return { class: "failed", reason: "signal" };
  if (exitCode !== 0) return { class: "failed", reason: `exit-${exitCode}` };
  return { class: "ok" };
}

export interface CliShimOpts extends CliClassifyConfig {
  /** Real binary plus prefix args. */
  command: string[];
  /** Extra env for the real binary. */
  env: Record<string, string>;
  /** tap.jsonl; omitted for the check-time passthrough (no record). */
  tapLog?: string;
  /** Node binary for the shebang (default: this process's). */
  node?: string;
}

/** Source of the shim script. */
export function cliShimSource(o: CliShimOpts): string {
  const node = o.node ?? process.execPath;
  const cfg = { command: o.command, env: o.env, tapLog: o.tapLog ?? null, usageExitCodes: o.usageExitCodes, usagePatterns: o.usagePatterns };
  return `#!${node}
// coding.sh tool-eval tap (generated). Execs the real command and records one line per call.
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants } from "node:fs";
import { performance } from "node:perf_hooks";
const CFG = ${JSON.stringify(cfg)};
const classify = ${classifyCli.toString()};
const argv = process.argv.slice(2);
const env = { ...process.env, ...CFG.env };
// A bare command name resolves on PATH without this shim's own directory, so
// a target whose command equals its bin never re-enters the shim.
const resolveBin = (f) => {
  if (f.includes("/")) return f;
  const me = process.argv[1] || "";
  const self = me.slice(0, me.lastIndexOf("/"));
  for (const d of (env.PATH || "").split(":")) {
    if (!d || d === self) continue;
    try { accessSync(d + "/" + f, constants.X_OK); return d + "/" + f; } catch {}
  }
  return f;
};
const file = resolveBin(CFG.command[0]);
const pre = CFG.command.slice(1);
let outBytes = 0, errBytes = 0, errHead = "";
const ts = Date.now();
const t0 = performance.now();
let t1 = 0;
const child = spawn(file, [...pre, ...argv], { stdio: ["inherit", CFG.tapLog ? "pipe" : "inherit", CFG.tapLog ? "pipe" : "inherit"], env });
const sigs = ["SIGINT", "SIGTERM", "SIGHUP"];
const fwd = (s) => { try { child.kill(s); } catch {} };
for (const s of sigs) process.on(s, fwd);
if (CFG.tapLog) {
  child.stdout.on("data", (b) => { outBytes += b.length; process.stdout.write(b); });
  child.stderr.on("data", (b) => { errBytes += b.length; if (errHead.length < 2048) errHead = (errHead + b.toString("utf8")).slice(0, 2048); process.stderr.write(b); });
}
child.on("exit", () => { t1 = performance.now(); });
let done = false;
const finish = (code, signal) => {
  if (done) return;
  done = true;
  for (const s of sigs) process.off(s, fwd);
  if (!t1) t1 = performance.now();
  const exitCode = signal ? null : code;
  if (CFG.tapLog) {
    const c = classify(argv, exitCode, errHead, CFG);
    const rec = { ts, durationMs: Math.round((t1 - t0) * 1000) / 1000, target: "cli", class: c.class, argv, cwd: process.cwd(), exitCode, stdoutBytes: outBytes, stderrBytes: errBytes, stderrHead: errHead };
    if (c.reason) rec.reason = c.reason;
    try { appendFileSync(CFG.tapLog, JSON.stringify(rec) + "\\n"); } catch {}
  }
  if (signal) { try { process.kill(process.pid, signal); } catch {} process.exitCode = 128 + 15; }
  else process.exitCode = code ?? 1;
};
child.on("error", (e) => { errHead = String(e && e.message || e); process.stderr.write(errHead + "\\n"); finish(127, null); });
child.on("close", (code, signal) => finish(code, signal));
`;
}

/** Writes `<dir>/<bin>` (mode 755) and returns its path. */
export async function writeCliShim(dir: string, bin: string, o: CliShimOpts): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, bin);
  await writeFile(p, cliShimSource(o), "utf8");
  await chmod(p, 0o755);
  return p;
}
