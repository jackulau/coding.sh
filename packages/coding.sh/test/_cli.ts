// Which coding.sh the tests launch: src/cli/main.ts by default, or the built
// bundle CODING_SH_TEST_CLI names (an absolute path to this checkout's
// dist/cli.mjs, after `npm run build`). A source launch strips types on every
// start; the bundle starts faster.
//
// A test that launches the CLI takes its path from CLI. A test about running
// from source (the store guard, a preload that patches a source module) takes
// SOURCE_CLI, which the variable never changes.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** The variable that names the built CLI to launch. */
export const TEST_CLI_ENV = "CODING_SH_TEST_CLI";

/** src/cli/main.ts. */
export const SOURCE_CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

/**
 * The CLI to launch under `env`: SOURCE_CLI when the variable is unset, else the
 * file it names. A value that is not an absolute path to a file throws (an empty
 * one too), so a run never falls back to source without saying so.
 */
export function resolveCli(env: NodeJS.ProcessEnv = process.env): string {
  const path = env[TEST_CLI_ENV];
  if (path === undefined) return SOURCE_CLI;
  if (!isAbsolute(path)) throw new Error(`${TEST_CLI_ENV} must be an absolute path to a built dist/cli.mjs, got ${JSON.stringify(path)}. Unset it to launch the CLI from source.`);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`${TEST_CLI_ENV} names ${path}, which is not a file. Run \`npm run build\` in packages/coding.sh, or unset it to launch the CLI from source.`);
  return path;
}

/** The CLI the tests launch: `node --no-warnings CLI <args>`. */
export const CLI = resolveCli();
