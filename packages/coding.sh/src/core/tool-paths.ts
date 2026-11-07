// Paths a trace event names, shared by rule checks (rules.ts) and harness-item
// exposure (exposure.ts). Pure: no I/O.

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"];

/** `full` ends with `suffix` at a path boundary (`/repo/docs/A.md` ends with `docs/A.md`, not `cs/A.md`). */
export function pathEndsWith(full: string, suffix: string): boolean {
  const f = full.replaceAll("\\", "/");
  const s = suffix.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!s || !f.endsWith(s)) return false;
  return f.length === s.length || f[f.length - s.length - 1] === "/" || s.startsWith("/");
}

/** Paths a tool call's input names (Read, Edit, Write, NotebookEdit and look-alikes). */
export function inputPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const o = input as Record<string, unknown>;
  return PATH_KEYS.map((k) => o[k]).filter((x): x is string => typeof x === "string" && !!x);
}
