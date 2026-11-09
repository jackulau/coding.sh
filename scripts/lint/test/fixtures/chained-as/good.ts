// No line here may produce a chained-as finding.
import { readFileSync as read } from "node:fs";
import * as path from "node:path";
export { read as readFile };
export type { User as Person } from "./bad.ts";
interface User { id: string }
declare const raw: unknown;
declare function cast(v: string): unknown;
export const s = raw as string;
export const t = String(raw as number);
export const u = [raw as string, raw as number];
export const v = { a: raw as string, b: raw as number };
export const w = cast(raw as string) as number;
export const label = "x as unknown as y";
// a comment: value as unknown as Foo
export const re = /as unknown as/;
export const k = ["a"] as const;
export const obj = { as: 1 };
export const prop = obj.as;
export const pick = (flag: boolean) => (flag ? (raw as string) : (raw as number));
export const tpl = `${raw as string} as unknown as ${path.sep}`;
export const user = raw as User;
