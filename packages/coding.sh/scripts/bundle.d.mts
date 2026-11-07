// Types for bundle.mjs, so TypeScript tests can import it without allowJs.
export interface BundleResult {
  cli: string;
  hook: string;
  schema: string;
  store: string;
}
/** Bundle cli, hook and schema into `outdir` (absolute or package-relative). */
export function bundle(outdir?: string): Promise<BundleResult>;
