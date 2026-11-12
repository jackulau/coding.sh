// What the SDK docs say userId and metadata do: they are on the turn's session.start event, not "on the session".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("the SDK reference says where userId and metadata are recorded", () => {
  const ref = read("docs/reference/sdk.md");
  assert.doesNotMatch(ref, /stored on the session/i);
  assert.match(ref, /\| `userId` \|[^|]*\|[^|]*session\.start/);
  assert.match(ref, /\| `metadata` \|[^|]*\|[^|]*session\.start/);
  assert.match(ref, /user_id and metadata are recorded on the trace's session\.start event/);
});

test("the TypeScript doc comments say it too", () => {
  const src = read("packages/sdk/src/context.ts");
  assert.doesNotMatch(src, /stored on the session/i);
  assert.match(src, /userId\?: string/);
});
