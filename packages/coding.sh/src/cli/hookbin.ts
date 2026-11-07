// The hook entry agents run: dist/hook.mjs copied to ~/.coding.sh/bin/hook.mjs,
// so agent configs point at a stable path that survives package upgrades and
// `npx` cache eviction. Next to it, bin/cli-path names the installed
// dist/cli.mjs so the hook can start a background ingest when a session ends.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paths } from "../core/paths.ts";
import { runningCli } from "../mcp/launch.ts";
import type { FileChange } from "../core/types.ts";
import { CliError } from "./output.ts";

/** dist/hook.mjs next to the running bundle, or the package's dist/ when running from source. */
export function hookSource(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.CODING_SH_HOOK_SOURCE, fileURLToPath(new URL("./hook.mjs", import.meta.url)), fileURLToPath(new URL("../../dist/hook.mjs", import.meta.url))];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new CliError("Can't find hook.mjs to install", { reason: "hook_missing", next: ["Build the package first:", "npm run build"] });
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Planned write of the hook bin and CLI pointer (undefined when both are current). */
export function planHookBin(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): FileChange | undefined {
  const p = paths(env);
  const dest = p.hook;
  const after = readFileSync(hookSource(env), "utf8");
  const before = readOr(dest);
  if (before === after && (cli === undefined || readOr(p.cliPointer) === cli + "\n")) return undefined;
  // Text is omitted from the plan (a minified bundle is not a useful diff).
  return { path: dest, action: before === undefined ? "create" : "modify", summary: before === undefined ? "install the coding.sh hook" : "update the coding.sh hook" };
}

export async function writeHookBin(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = runningCli()): Promise<string> {
  const { atomicWrite } = await import("../adapters/_shared/files.ts");
  const p = paths(env);
  await atomicWrite(p.hook, readFileSync(hookSource(env), "utf8"), 0o755);
  if (cli !== undefined) await atomicWrite(p.cliPointer, cli + "\n", 0o644);
  return p.hook;
}
