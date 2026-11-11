// `coding.sh collector` listens on loopback only: a public host is a usage error that points at serve.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanup, runSync, tmpHome } from "./_run-source.ts";

after(cleanup);

describe("coding.sh collector --host", () => {
  it("refuses a non-loopback host with exit 2 and names `coding.sh serve --host 0.0.0.0`", () => {
    const r = runSync(["collector", "--host", "0.0.0.0", "--port", "0"], tmpHome().env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /coding\.sh serve --host 0\.0\.0\.0/);
    assert.doesNotMatch(r.stderr, /allowRemote|at .*\.ts:\d+/, "no internal error text");
  });
});
