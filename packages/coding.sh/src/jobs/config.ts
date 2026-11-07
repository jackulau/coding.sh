// The config hash of a job: everything that changes what a trial measures
// (dataset version, task, graders, trials, seed, timeouts), never what only
// changes how fast it runs (concurrency, retries). A resume needs the same
// hash: finished trials of one config mixed with new trials of another would
// be a result of neither.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sha256Hex } from "../core/ids.ts";
import { canonicalJson } from "../datasets/hash.ts";
import type { JobConfig } from "./store.ts";

/** Hash each part (canonical JSON; undefined parts are left out), then the whole. */
export function jobConfig(parts: Record<string, unknown>): JobConfig {
  const hashed: Record<string, string> = {};
  for (const k of Object.keys(parts).sort()) {
    const v = parts[k];
    if (v === undefined) continue;
    hashed[k] = sha256Hex(canonicalJson(v)).slice(0, 16);
  }
  return { hash: sha256Hex(canonicalJson(hashed)), parts: hashed };
}

/** Part names whose hash differs (added or removed parts included), sorted. */
export function configChanges(was: JobConfig, now: JobConfig): string[] {
  const keys = new Set([...Object.keys(was.parts), ...Object.keys(now.parts)]);
  return [...keys].filter((k) => was.parts[k] !== now.parts[k]).sort();
}

/**
 * A command task's fingerprint: the spec plus the content of the program and
 * of every argument that names a file (an agent script edited mid-run is a
 * changed config). Other specs are returned as they are.
 */
export function taskFingerprint(spec: unknown, cwd = process.cwd()): unknown {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
  const s = spec as { kind?: unknown; command?: unknown; args?: unknown; cwd?: unknown };
  if (s.kind !== "command" || typeof s.command !== "string") return spec;
  const base = typeof s.cwd === "string" ? resolve(cwd, s.cwd) : cwd;
  const files: Record<string, string> = {};
  const words = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x): x is string => typeof x === "string");
  // A one-string command line ("node agent.mjs") names its files as words.
  for (const w of words.flatMap((x) => (x.includes(" ") && !existsSync(resolve(base, x)) ? x.split(/\s+/) : [x]))) {
    const p = isAbsolute(w) ? w : resolve(base, w);
    try {
      if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 16 * 1024 * 1024) continue;
      files[w] = sha256Hex(readFileSync(p)).slice(0, 16);
    } catch {
      // unreadable: the spec alone
    }
  }
  return Object.keys(files).length ? { spec, files } : spec;
}
