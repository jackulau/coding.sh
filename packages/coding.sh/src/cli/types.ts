import type { FlagValue } from "./args.ts";
import type { Output } from "./output.ts";

export interface CommandContext {
  /** Subcommand name for commands with actions (`eval new` → "new"). */
  action?: string;
  flags: Record<string, FlagValue>;
  positionals: string[];
  /** Arguments after `--`. */
  rest: string[];
  out: Output;
  env: NodeJS.ProcessEnv;
  cwd: string;
  debug: boolean;
  /** Aborted on the first Ctrl-C. */
  signal: AbortSignal;
}

/** Return the exit code (default 0). Throw UsageError (2) or CliError (1) on failure. */
export interface CommandModule {
  run(c: CommandContext): Promise<number | void>;
}
