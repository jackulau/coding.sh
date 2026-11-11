// A server URL that is not http(s) turns the SDK off with one warning, instead of failing on every send.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { flush, init, stats, trace } from "../src/index.ts";
import { _reset, isEnabled } from "../src/client.ts";
import { resolveConfig } from "../src/config.ts";

let warnings: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  _reset();
  warnings = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
});
afterEach(() => {
  console.warn = realWarn;
});

test("a URL with no scheme is a config problem, and the SDK is off", async () => {
  init({ url: "localhost:4318", flushIntervalMs: 10 });
  assert.equal(isEnabled(), false);
  trace("t", () => 1);
  assert.equal(await flush(200), true);
  assert.equal(stats().failed, 0, "nothing was tried");
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /localhost:4318/);
  assert.match(warnings[0]!, /http:\/\/ or https:\/\//);
});

test("the warning is given once, however often init runs", () => {
  init({ url: "not a url" });
  init({ url: "not a url" });
  trace("t", () => 1);
  assert.equal(warnings.length, 1);
});

test("a bad URL from the environment is caught too, and never echoes credentials", () => {
  const c = resolveConfig({}, { CODING_SH_URL: "ftp://user:secret@host/x" });
  assert.equal(c.url, undefined);
  assert.ok(c.urlProblem);
  assert.ok(!c.urlProblem!.includes("secret"));
  assert.equal(resolveConfig({}, { CODING_SH_URL: "https://obs.example.com/" }).urlProblem, undefined);
});

test("no URL at all is not a problem: the SDK is quietly off", () => {
  init({});
  assert.equal(isEnabled(), false);
  assert.deepEqual(warnings, []);
});
