// A date that does not exist is a usage error, not the first of the next month.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSince, parseSinceWhen, UsageError } from "../../src/cli/args.ts";

test("2026-11-31 and 2026-02-29 throw", () => {
  assert.throws(() => parseSince("2026-11-31"), (e: Error) => e instanceof UsageError && /not a real date/.test(e.message));
  assert.throws(() => parseSince("2026-02-29"), UsageError);
  assert.throws(() => parseSince("2026-04-31T10:00"), UsageError);
});
test("a leap day and ordinary dates pass", () => {
  assert.equal(new Date(parseSince("2028-02-29")).getDate(), 29);
  assert.equal(new Date(parseSince("2026-11-30")).getMonth(), 10);
});
test("the flag name is in the message", () => {
  assert.throws(() => parseSinceWhen("2026-02-30", Date.now(), "until"), /--until/);
});
