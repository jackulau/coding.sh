// Agent and tool logos (src/assets/logos, sources in SOURCES.md), keyed by the
// adapter id used across the site. Read as raw SVG at build time and inlined, so
// they cost no request and take the surrounding text colour.
const files = import.meta.glob<string>("../assets/logos/*.svg", { query: "?raw", import: "default", eager: true });

const byFile = new Map(Object.entries(files).map(([p, s]) => [p.split("/").pop()!.replace(/\.svg$/, ""), s]));

/** Adapter id -> logo file, where the two differ. */
const ALIAS: Record<string, string> = { "copilot-cli": "github-copilot", otel: "opentelemetry", eve: "vercel", droid: "factory" };

/** Inner markup and viewBox of a logo, or undefined when there is none (show the name only). */
export function logo(id: string): { viewBox: string; body: string; evenodd: boolean } | undefined {
  const raw = byFile.get(ALIAS[id] ?? id);
  if (!raw) return undefined;
  const open = raw.match(/<svg[^>]*>/)?.[0] ?? "";
  return {
    viewBox: open.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 24 24",
    evenodd: /fill-rule="evenodd"/.test(open),
    body: raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[\s\S]*?<\/title>/, ""),
  };
}
