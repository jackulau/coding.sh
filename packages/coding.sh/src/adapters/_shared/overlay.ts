// Isolated config homes for eval runs. The runner (src/runner/run.ts) lays a
// run out as runs/<id>/{work,home} and writes the bundle's "~/" files into
// home/; adapters point the agent's config-dir env var at a dir inside it, so
// the user's global config is never read or modified during a run.
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HarnessBundle } from "../../core/types.ts";

/** The run's isolated HOME (sibling of the work dir, matching runner/run.ts runLayout). */
export function isolatedHome(runDir: string): string {
  // Never inside runDir: anything written there would show up in the agent's diff.
  return basename(runDir) === "work" ? join(dirname(runDir), "home") : join(dirname(runDir), `${basename(runDir)}-home`);
}

/** Copy a credential/state file into the isolated dir if the source exists. Returns true if copied. */
export async function copyIfExists(src: string, dest: string, mode = 0o600): Promise<boolean> {
  try {
    if (!(await stat(src)).isFile()) return false;
  } catch {
    return false;
  }
  try {
    await stat(dest);
    return false; // bundle (or an earlier step) already provided it
  } catch {
    // absent: copy
  }
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await copyFile(src, dest);
  await chmod(dest, mode);
  return true;
}

/** Bundle paths under a user-level prefix such as "~/.claude/" (relative to it). */
export function bundleUserFiles(bundle: HarnessBundle, prefix: string): string[] {
  return Object.keys(bundle.files)
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}
