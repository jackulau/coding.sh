// A setup that can break the prompt cache before it ever runs. The prompt cache
// belongs to one model, so a fallback model (Claude Code's `fallbackModel`,
// which it switches to on error) rewrites the whole cached prefix at full price
// every time it kicks in. This reads the settings files read-only — it never
// edits them — so `harness audit` can warn before it costs anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FallbackRisk {
  /** The settings file that set it. */
  path: string;
  /** The model it falls back to. */
  fallbackModel: string;
}

/** Claude Code settings files, user and project, in read order. */
const SETTINGS_FILES = ["settings.json", "settings.local.json"];

/** Fallback-model settings across these dirs (duplicates by path removed). Missing or unparseable files are skipped. */
export function fallbackModelRisks(dirs: readonly string[]): FallbackRisk[] {
  const out: FallbackRisk[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of SETTINGS_FILES) {
      const path = join(dir, name);
      if (seen.has(path)) continue;
      seen.add(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      const fb = (parsed as { fallbackModel?: unknown } | null)?.fallbackModel;
      if (typeof fb === "string" && fb.trim()) out.push({ path, fallbackModel: fb.trim() });
    }
  }
  return out;
}
