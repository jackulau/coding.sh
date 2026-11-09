// Types for bundle.mjs, so TypeScript tests can import it without allowJs.
export interface BundleResult {
  cli: string;
  /** Source files (package-relative, e.g. "src/cli/main.ts") esbuild put in cli.mjs itself, not in a chunk. */
  cliInputs: string[];
  hook: string;
  hookSh: string;
  schema: string;
  store: string;
}
/** Bundle cli, hook and schema into `outdir` (absolute or package-relative). */
export function bundle(outdir?: string): Promise<BundleResult>;
