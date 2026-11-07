import { readFileSync } from "node:fs";

declare const __CODING_SH_VERSION__: string | undefined;

/** Package version: inlined by the bundle, read from package.json when running from source. */
export function version(): string {
  if (typeof __CODING_SH_VERSION__ === "string") return __CODING_SH_VERSION__;
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}
