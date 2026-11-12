// Runs the CLI from source (no build) with a throwaway home, for the serve, proxy and collector CLI tests.
import { type ChildProcess, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const roots: string[] = [];
const children: ChildProcess[] = [];

/** Kills every child and removes every home; call from `after`. */
export function cleanup(): void {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

export interface TmpHome {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function tmpHome(extra: NodeJS.ProcessEnv = {}): TmpHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-src-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: dirname(process.execPath), NO_COLOR: "1", CODING_SH_LOG: "json", ...extra };
  return { root, home, env };
}

export const runSync = (args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { env, encoding: "utf8", timeout });

/** Like runSync, for tests that serve something in this same process (spawnSync would block it). */
export function runAsync(args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL" });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

export interface Live {
  child: ChildProcess;
  out: string[];
  err: string[];
  /** Resolves once stdout or stderr matches. */
  waitFor(re: RegExp, ms?: number): Promise<string>;
}

export function runLive(args: string[], env: NodeJS.ProcessEnv): Live {
  const child = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out: string[] = [];
  const err: string[] = [];
  child.stdout!.setEncoding("utf8").on("data", (d: string) => out.push(d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => err.push(d));
  return {
    child,
    out,
    err,
    waitFor: (re, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = setInterval(() => {
          const all = out.join("") + err.join("");
          const m = re.exec(all);
          if (m) {
            clearInterval(tick);
            resolve(m[0]);
          } else if (Date.now() - t0 > ms || child.exitCode !== null) {
            clearInterval(tick);
            reject(new Error(`no ${re} in output (exit ${child.exitCode}): ${all.slice(-600)}`));
          }
        }, 25);
      }),
  };
}
