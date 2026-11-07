// Concurrency limiting without dependencies.

/** Returns a function that runs at most `n` tasks at once, FIFO. */
export function createLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!(Number.isInteger(n) && n >= 1)) throw new RangeError(`concurrency must be a positive integer (got ${n})`);
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        let p: Promise<T>;
        try {
          p = fn();
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

/** Map with bounded concurrency; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = createLimiter(n);
  return Promise.all(items.map((x, i) => limit(() => fn(x, i))));
}
