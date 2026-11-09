// The hook entry agents run: dist/hook.mjs copied to ~/.coding.sh/bin/hook.mjs,
// and its POSIX sh fast path dist/hook.sh to bin/hook.sh (what agents run
// outside Windows), so agent configs point at a stable path that survives
// package upgrades and `npx` cache eviction. Next to it, bin/cli-path names the installed
// dist/cli.mjs so the hook can start a background ingest when a session ends,
// and bin/mcp.mjs launches that CLI's MCP server for agents. `coding.sh
// update` refreshes all three from the new install (refreshHookBin).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../core/paths.ts";
import { mcpLauncherSource, runningCli } from "../mcp/launch.ts";
import type { FileChange } from "../core/types.ts";
import { CliError } from "./output.ts";

/** dist/hook.mjs next to the running bundle, or the package's dist/ when running from source. */
export function hookSource(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.CODING_SH_HOOK_SOURCE, fileURLToPath(new URL("./hook.mjs", import.meta.url)), fileURLToPath(new URL("../../dist/hook.mjs", import.meta.url))];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new CliError("Can't find hook.mjs to install", { reason: "hook_missing", next: ["Build the package first:", "npm run build"] });
}

/**
 * The sh fast path shipped with that hook.mjs: hook.sh beside it, else beside
 * the running bundle, else src/spool/hook.sh when running from source.
 */
export function hookShSource(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [join(dirname(hookSource(env)), "hook.sh"), fileURLToPath(new URL("./hook.sh", import.meta.url)), fileURLToPath(new URL("../spool/hook.sh", import.meta.url))];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new CliError("Can't find hook.sh to install", { reason: "hook_missing", next: ["Build the package first:", "npm run build"] });
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Planned write of the hook bin, MCP launcher and CLI pointer (undefined when all are current). */
export function planHookBin(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): FileChange | undefined {
  const p = paths(env);
  const dest = p.hook;
  const after = readFileSync(hookSource(env), "utf8");
  const before = readOr(dest);
  if (before === after && readOr(p.hookSh) === readFileSync(hookShSource(env), "utf8") && readOr(p.mcpLauncher) === mcpLauncherSource() && (cli === undefined || readOr(p.cliPointer) === cli + "\n")) return undefined;
  // Text is omitted from the plan (a minified bundle is not a useful diff).
  return { path: dest, action: before === undefined ? "create" : "modify", summary: before === undefined ? "install the coding.sh hook" : "update the coding.sh hook" };
}

export async function writeHookBin(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): Promise<string> {
  const { atomicWrite } = await import("../adapters/_shared/files.ts");
  const p = paths(env);
  await atomicWrite(p.hook, readFileSync(hookSource(env), "utf8"), 0o755);
  await atomicWrite(p.hookSh, readFileSync(hookShSource(env), "utf8"), 0o755);
  await atomicWrite(p.mcpLauncher, mcpLauncherSource(), 0o755);
  if (cli !== undefined) await atomicWrite(p.cliPointer, cli + "\n", 0o644);
  return p.hook;
}

/**
 * Isolated runs (`compare`) point the agent's hooks at the hook bin, so a run is
 * captured only when the bin exists. Writes it when missing; agent configs are
 * not touched, so this does not install capture for the user's own sessions.
 */
export async function ensureHookBin(env: NodeJS.ProcessEnv = process.env): Promise<"present" | "written" | "unavailable"> {
  const p = paths(env);
  const hasHook = existsSync(p.hook);
  if (hasHook && existsSync(p.hookSh)) return "present";
  try {
    if (hasHook) {
      // A bin from before the sh fast path: add hook.sh, leave the installed hook.mjs as it is.
      const { atomicWrite } = await import("../adapters/_shared/files.ts");
      await atomicWrite(p.hookSh, readFileSync(hookShSource(env), "utf8"), 0o755);
    } else await writeHookBin(env);
    return "written";
  } catch {
    return "unavailable";
  }
}

/**
 * Rewrites the hook, launcher and CLI pointer from this install, but only
 * where `coding.sh init` set them up before (an update must not install
 * capture for someone who never ran init).
 */
export async function refreshHookBin(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): Promise<"refreshed" | "current" | "not_installed"> {
  if (!existsSync(paths(env).hook)) return "not_installed";
  if (!planHookBin(env, cli)) return "current";
  await writeHookBin(env, cli);
  return "refreshed";
}

/**
 * Self-heal after `npm i -g` of a newer coding.sh, run by `ingest` (the hook
 * starts `ingest --background` through cli-path at every session end, so the
 * new CLI's first background ingest brings the bin up to date). Refreshes only
 * when cli-path names this CLI or a CLI that is gone, so an older install run
 * by hand never downgrades the bin, and never where init did not install it.
 * Never throws: an ingest must not fail over the bin.
 */
export async function healHookBin(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): Promise<"refreshed" | "current" | "skipped"> {
  if (cli === undefined) return "skipped"; // running from source: no shipped hook to install
  try {
    const p = paths(env);
    if (!existsSync(p.hook)) return "skipped";
    const pointer = readOr(p.cliPointer)?.trim();
    if (pointer && pointer !== cli && existsSync(pointer)) return "skipped";
    return (await refreshHookBin(env, cli)) === "refreshed" ? "refreshed" : "current";
  } catch {
    return "skipped";
  }
}

export interface HookBinHealth {
  /** hook.mjs and hook.sh match the hook this CLI ships (null: no bundled hook to compare with). */
  hookCurrent: boolean | null;
  /** What bin/cli-path names, if anything. */
  cliPath: string | null;
  /** cli-path names the running CLI (null: not running from a bundle, so nothing to compare). */
  cliPathCurrent: boolean | null;
  /** The CLI cli-path names exists. */
  cliPathExists: boolean;
  launcherInstalled: boolean;
}

/** How the installed bin compares with this CLI (for doctor). */
export function hookBinHealth(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): HookBinHealth {
  const p = paths(env);
  let hookCurrent: boolean | null = null;
  try {
    const installed = readOr(p.hook);
    hookCurrent = installed === undefined ? false : installed === readFileSync(hookSource(env), "utf8") && readOr(p.hookSh) === readFileSync(hookShSource(env), "utf8");
  } catch {
    hookCurrent = null; // running from source without a build: nothing to compare against
  }
  const pointer = readOr(p.cliPointer)?.trim() || null;
  return {
    hookCurrent,
    cliPath: pointer,
    cliPathCurrent: cli === undefined ? null : pointer === cli,
    cliPathExists: pointer !== null && existsSync(pointer),
    launcherInstalled: existsSync(p.mcpLauncher),
  };
}
