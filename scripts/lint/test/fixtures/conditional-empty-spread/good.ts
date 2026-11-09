// No line here may produce a conditional-empty-spread finding.
declare const name: string | undefined;
declare const flag: boolean;
declare const xs: string[];
declare const ys: string[];
declare const overrides: Record<string, string> | undefined;
declare function pick(o: object, k: string): object;
const defaults = { a: "1" };
export const a = { ...defaults, ...(overrides ?? {}) };
export const b = { ...(flag ? { a: 1 } : { b: 2 }) };
export const c = { ...pick(defaults, "a") };
export const d = [...(flag ? xs : ys)];
export const s = "...(x ? { a } : {})";
export const out: Record<string, string> = {};
if (name) out.name = name;
export const e = { ...(overrides?.x ? { x: overrides.x } : { x: "" }) };
export const f = flag ? {} : { b: 1 };
