// Remove a test's temp dir. On Windows a child the test killed (a read's tail worker at its
// deadline, a stopped proxy) can hold a handle in the dir for a while after it exits, longer on a
// loaded machine. Retry, then leave the dir behind with a warning: a leftover temp dir is not a
// test failure. Anywhere else a failure still throws.
import { rmSync } from "node:fs";

export function removeTestDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw e;
    process.emitWarning(`left ${dir} behind: ${code} (a child still held it)`);
  }
}
