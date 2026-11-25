// How the checks in this folder gather what broke: each kind of problem once, with a count.

/** Problems by kind, each with the first input that showed it (the inputs come smallest first). */
export class Problems {
  readonly seen = new Map<string, { count: number; first: string }>();
  add(kind: string, where: string): void {
    const p = this.seen.get(kind);
    if (p) p.count++;
    else this.seen.set(kind, { count: 1, first: where });
  }
  list(): string[] {
    return [...this.seen].map(([kind, p]) => `${kind} (${p.count} inputs; first: ${p.first})`);
  }
}
