// Copy an agent's whole stdout to a file while the headless driver keeps only
// a bounded tail in memory. The runner hands the file to the verifier
// (CODING_SH_AGENT_STDOUT), so a grader can read every tool call, not just
// the last 16 KB. A write error never breaks the run: the file just stops.
import { createWriteStream } from "node:fs";

export interface Tee {
  write(chunk: string): void;
  /** Flushes and closes the file; resolves even when writing failed. */
  close(): Promise<void>;
}

const NOOP: Tee = { write() {}, close: () => Promise.resolve() };

export function teeFile(path: string | undefined): Tee {
  if (!path) return NOOP;
  let failed = false;
  const ws = createWriteStream(path, { flags: "a" });
  ws.on("error", () => {
    failed = true;
  });
  return {
    write(chunk) {
      if (!failed) ws.write(chunk);
    },
    close() {
      return new Promise((resolve) => {
        if (ws.closed) return resolve();
        // "close" follows both a clean finish and an error (autoDestroy).
        ws.once("close", () => resolve());
        ws.end();
      });
    },
  };
}
