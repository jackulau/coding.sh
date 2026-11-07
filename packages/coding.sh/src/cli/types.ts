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
  /** Aborted on the first Ctrl-C (on the second for a graceful command, or on SIGTERM/SIGHUP): stop now. */
  signal: AbortSignal;
  /**
   * Graceful commands (long eval runs): aborted on the first Ctrl-C, meaning
   * "start nothing new, let what is in flight finish". The same as `signal` for
   * every other command (absent: use `signal`).
   */
  drain?: AbortSignal;
  /**
   * The exit code main() returns after an interrupt, instead of 130/143/129.
   * For commands that run until stopped (`exp ab --watch`): Ctrl-C is how they end.
   */
  interruptExit?: (code: number) => void;
  /** The command line as given (after the binary), when run from main(). */
  argv?: readonly string[];
}

/** Return the exit code (default 0). Throw UsageError (2) or CliError (1) on failure. */
export interface CommandModule {
  run(c: CommandContext): Promise<number | void>;
}
