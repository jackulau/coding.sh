// Every line with the expect marker must produce a finding.
interface Job { id: string }
export function jobId(job: unknown): string { // slop:expect
  return (job as Job).id;
}
export const idOf = (v: unknown) => (v as Job).id; // slop:expect
export class Queue {
  take(item: unknown, n: number) { // slop:expect
    return (item as Job[]).slice(0, n);
  }
}
export const report = async (err: unknown) => { // slop:expect
  console.error((err as Error).message);
};
export function many(a: string, b?: unknown) { // slop:expect
  return a + (b as string);
}
