// Re-exports only; the finding lands on the first statement.
export * from "./a.ts"; // slop:expect
export { b, type B } from "./b.ts";
export type { C } from "./c.ts";
