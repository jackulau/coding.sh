// Binary discovery and version probing. PATH is scanned directly (no shell),
// so shell functions/aliases named like the agent never confuse detection.
import { execFile, resolveWindowsCommand } from "../../core/spawn.ts";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DetectResult } from "../../core/types.ts";

/** Absolute path of the first executable `bin` on PATH, else undefined. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Windows runs only PATHEXT files (an extensionless script is not a command there).
  if (process.platform === "win32") return resolveWindowsCommand(bin, env);
  for (const d of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = join(d, bin);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** First version-looking token in a `--version` output (e.g. "2.1.3", "2025.09.18-7ae6800"). */
export function parseVersion(text: string): string | undefined {
  const m = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  return m?.[1];
}

/** Runs `<binary> --version` (no shell) with a short timeout. Never throws. */
export function probeVersion(binary: string, args: string[] = ["--version"], timeoutMs = 5000, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(binary, args, { timeout: timeoutMs, env, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const text = `${stdout ?? ""}\n${stderr ?? ""}`;
        if (err && !text.trim()) return resolve(undefined);
        resolve(parseVersion(text));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * `--version` budget during detect. Probes run in parallel for every adapter,
 * so on a loaded machine a node-based CLI (cursor-agent: ~3 s under load) can
 * take far longer than its idle time; a short budget made installed agents
 * vanish from init.
 */
export const PROBE_TIMEOUT_MS = 15_000;

export interface DetectSpec {
  /** Candidate binary names, first found wins (e.g. ["cursor-agent", "agent"]). */
  bins: string[];
  configDir: string;
  hooked: () => boolean | Promise<boolean>;
  versionArgs?: string[];
  /**
   * Accept a binary only when its version output matches (guards generic names
   * like "agent"). Gets the bin name too: a specific name should survive a
   * version probe that timed out on a busy machine.
   */
  versionCheck?: (versionOutput: string | undefined, bin: string) => boolean;
  env?: NodeJS.ProcessEnv;
  notes?: () => string[] | Promise<string[]>;
}

/** Standard detect(): binary on PATH, version, config dir, hook marker. */
export async function detectAgent(spec: DetectSpec): Promise<DetectResult> {
  const env = spec.env ?? process.env;
  let binary: string | undefined;
  let version: string | undefined;
  for (const b of spec.bins) {
    const p = which(b, env);
    if (!p) continue;
    const v = await probeVersion(p, spec.versionArgs, PROBE_TIMEOUT_MS, env);
    if (spec.versionCheck && !spec.versionCheck(v, b)) continue;
    binary = p;
    version = v;
    break;
  }
  let hooked = false;
  try {
    hooked = await spec.hooked();
  } catch {
    hooked = false;
  }
  const r: DetectResult = { installed: binary !== undefined, hooked };
  if (binary) r.binary = binary;
  if (version) r.version = version;
  if (existsSync(spec.configDir)) r.configDir = spec.configDir;
  const notes = spec.notes ? await spec.notes() : [];
  if (notes.length) r.notes = notes;
  return r;
}
