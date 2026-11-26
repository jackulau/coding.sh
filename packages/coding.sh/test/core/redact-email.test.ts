import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/core/redact.ts";

describe("redact: email domains", () => {
  const er = createRedactor({ redact: ["email"] });

  it("ends an address at its last label of two or more letters", () => {
    assert.equal(er.string("a@b.example.1"), "[redacted:email].1");
    assert.equal(er.string("a@b.test.u"), "[redacted:email].u");
    assert.equal(er.string("see a@b.example.c0m now"), "see [redacted:email].c0m now");
    assert.equal(er.string("x@my-host.x1.test"), "[redacted:email]");
    assert.equal(er.string("a@b.cc1.io-x.test"), "[redacted:email]");
  });

  it("keeps text whose domain has no later label of two or more letters", () => {
    for (const keep of ["a@b.c", "a@b.test-", "a@b.test1", "a@b.1.c", "a@b-c", "a@b.c-c"]) assert.equal(er.string(keep), keep, keep);
  });
});
