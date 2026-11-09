// No line here may produce an unknown-param finding: each `unknown` sits at a trust boundary.
interface Job { id: string }
declare function valid(v: unknown): boolean;
export function isJob(v: unknown): v is Job {
  return typeof v === "object" && v !== null && "id" in v;
}
export function assertJob(v: unknown): asserts v is Job {
  if (!isJob(v)) throw new Error("not a job");
}
export function parseJob(raw: unknown): Job {
  const o = raw as Partial<Job>;
  return o as Job;
}
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
export function size(v: unknown): number {
  if (Array.isArray(v)) return (v as unknown[]).length;
  return 0;
}
export function firstId(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  return (v as { id?: string }).id;
}
export function viaHelper(v: unknown): Job | undefined {
  if (!valid(v)) return undefined;
  return v as Job;
}
export function tryIt(): string {
  try {
    return "ok";
  } catch (e: unknown) {
    return (e as Error).message;
  }
}
export type Fn = (x: unknown) => void;
export interface Api {
  send(body: unknown): void;
}
export const log = (x: unknown) => console.log(x);
export const store = new Map<string, unknown>();
export function withThis(this: unknown) {
  return this as Job;
}
export const fromJson = (text: string): unknown => JSON.parse(text);
export function handler(err: unknown) {
  if (err == null) return;
  return (err as Error).message;
}
