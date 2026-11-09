// Re-exports next to its own code: a module, not a barrel.
export * from "./a.ts";
export function own(): number {
  return 1;
}
