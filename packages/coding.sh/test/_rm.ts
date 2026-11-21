// Remove a test's temp dir. On Windows a child the test killed (a read's tail worker at its
// deadline, a stopped proxy) can hold a handle in the dir for a while after it exits, longer on a
// loaded machine. Retry for up to 5.5 s, then leave the dir behind with a warning: a leftover temp
// dir is not a test failure. Anywhere else a failure still throws. removeSync waits between tries;
// on Node 24 on Windows, rmSync's own retries did not.
import { removeSync } from "../src/core/remove.ts";

export function removeTestDir(dir: string): void {
  try {
    removeSync(dir, { maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw e;
    process.emitWarning(`left ${dir} behind: ${code} (a child still held it)`);
  }
}
