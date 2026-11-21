// Removes a file or folder, waiting and trying again while another process still holds it.
//
// On Windows, Node 24's rmSync did not wait between its maxRetries tries (seen on 24.20): when
// another process held a file in the folder open (a Chrome helper still exiting, a killed child
// that has not let go yet), it gave up at once with EPERM and left the folder. fs.promises.rm with
// the same options waited and tried again, so code that can await uses it. This is the form for
// code that cannot: exit handlers, and code that must finish before it returns.
import { rmSync, type RmOptions } from "node:fs";

/** The codes rmSync documents for maxRetries: something still holds the path, or too many files are open. */
const RETRY = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

export interface RemoveOptions {
  /** Tries after the first. Default 3. */
  maxRetries?: number;
  /** The wait before the first retry in ms, and how much longer each later wait is. Default 100. */
  retryDelay?: number;
}

/**
 * `rmSync(path, { recursive: true, force: true })` that, on EBUSY, EMFILE, ENFILE, ENOTEMPTY or
 * EPERM, tries again up to maxRetries times: it waits retryDelay ms before the first retry, twice
 * that before the second, three times that before the third, and so on. Throws the last error.
 * `rm` is for tests.
 */
export function removeSync(path: string, o: RemoveOptions = {}, rm: (path: string, options: RmOptions) => void = rmSync): void {
  const retries = o.maxRetries ?? 3;
  const delay = o.retryDelay ?? 100;
  for (let i = 0; ; i++) {
    try {
      rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= retries || !RETRY.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (i + 1) * delay);
    }
  }
}
