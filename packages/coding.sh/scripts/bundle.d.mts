// Types for bundle.mjs, so TypeScript tests can import it without allowJs.
export interface BundleResult {
  cli: string;
  /** Source files (package-relative, e.g. "src/cli/main.ts") esbuild put in cli.mjs itself, not in a chunk. */
  cliInputs: string[];
  hook: string;
  /** Source files (package-relative) esbuild put in hook.mjs. */
  hookInputs: string[];
  /** The redaction rules hook.mjs imports for a payload that may hold a secret. */
  hookRedact: string;
  hookSh: string;
  schema: string;
  store: string;
}
/** The first lines of hook.mjs: the shebang, and process.getBuiltinModule for a node without it. */
export const HOOK_BANNER: string;
/** Bundle cli, hook and schema into `outdir` (absolute or package-relative). */
export function bundle(outdir?: string): Promise<BundleResult>;
