// CLI side of the protected-line check (src/refine/protect.ts), shared by
// `refine check` and `exp ab`: the flag, the config, the JSON and the lines.
import { ConfigError } from "../core/config.ts";
import { refineProtectConfig } from "../refine/config.ts";
import { parseOverride, type ProtectCheck, type ProtectRejection } from "../refine/protect.ts";
import { UsageError, type FlagValue } from "./args.ts";
import { list } from "./common.ts";
import { CliError } from "./output.ts";
import type { CommandContext } from "./types.ts";

/** The effective `[refine]` protect settings; a bad config is a CLI error naming the file. */
export function protectOptions(c: Pick<CommandContext, "env" | "cwd">): { protect: string[]; autoProtect: boolean; files: string[] } {
  try {
    const cfg = refineProtectConfig(c.env, c.cwd);
    return { protect: [...(cfg.protect ?? [])], autoProtect: cfg.autoProtect !== false, files: cfg.files };
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(e.message, { reason: "invalid_config" });
    throw e;
  }
}

/** Overrides from the flag, each checked for PATH:LINE before anything runs. */
export function protectOverrides(v: FlagValue): string[] {
  const out = list(v);
  for (const x of out) {
    try {
      parseOverride(x);
    } catch (e) {
      throw new UsageError(`--allow-protected-edit: ${(e as Error).message}`, { reason: "invalid_argument", suggestion: "--allow-protected-edit AGENTS.md:12" });
    }
  }
  return out;
}

/** JSON for a protect check (exp ab and refine check share it). */
export function protectJson(r: ProtectCheck): Record<string, unknown> {
  return {
    ok: r.ok,
    count: r.protected.length,
    lines: r.protected,
    rejections: r.rejections,
    overridden: r.overridden,
    ...(r.unusedOverrides.length ? { unusedOverrides: r.unusedOverrides } : {}),
  };
}

/** One line per rejection; the added line's location for a relaxing one. */
export function rejectionLines(rs: readonly ProtectRejection[]): string[] {
  return rs.map((r) => (r.added ? `${r.reason} (added at ${r.added.path}:${r.added.line})` : r.reason));
}
