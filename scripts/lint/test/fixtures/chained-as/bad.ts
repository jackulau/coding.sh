// Every line with the expect marker must produce a finding.
interface User { id: string }
declare const raw: string;
export const a = raw as unknown as User; // slop:expect
export const b = (raw as unknown) as User; // slop:expect
export const c = raw as any as number[]; // slop:expect
export const d = raw as Map<string, Array<number>> as unknown; // slop:expect
export function e(x: string) {
  return (x as unknown) as User; // slop:expect
}
export const f = [1, 2].map((n) => ({ n })) as unknown as User[]; // slop:expect
export const g = raw as // slop:expect
  unknown as
  User;
export const h = raw as { id: string } | null as User; // slop:expect
