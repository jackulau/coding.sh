import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { describeFailure, runProcess, type ProcResult } from "../../src/graders/proc.ts";

const failed = (stderr: string, exitCode = 1): ProcResult => ({ exitCode, signal: null, timedOut: false, stdout: "", stderr, durationMs: 1, truncated: false });

describe("describeFailure", () => {
  it("names the error and its cause for a Node crash, not the closing braces", async () => {
    const port = await new Promise<number>((done) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    const r = await runProcess({ command: process.execPath, args: ["--input-type=module", "-e", `await fetch("http://127.0.0.1:${port}/")`] });
    assert.equal(r.exitCode, 1);
    assert.equal(describeFailure(r), `exited 1: TypeError: fetch failed (cause: connect ECONNREFUSED 127.0.0.1:${port})`);
  });
  it("names a thrown error without its stack", async () => {
    const r = await runProcess({ command: process.execPath, args: ["-e", `throw new RangeError("too big")`] });
    assert.equal(describeFailure(r), "exited 1: RangeError: too big");
  });
  it("takes the last exception of a Python traceback", () => {
    const tb = ["Traceback (most recent call last):", '  File "agent.py", line 3, in <module>', "    urlopen(url)", "urllib.error.URLError: <urlopen error [Errno 111] Connection refused>"].join("\n");
    assert.equal(describeFailure(failed(tb)), "exited 1: urllib.error.URLError: <urlopen error [Errno 111] Connection refused>");
  });
  it("falls back to the last lines when there is no error line", () => {
    assert.equal(describeFailure(failed("one\ntwo\nthree\nfour", 3)), "exited 3: two | three | four");
    assert.equal(describeFailure(failed("", 2)), "exited 2");
  });
});
