import assert from "node:assert/strict";
import { slugify } from "./slug.mjs";
assert.equal(slugify(" Hello World "), "hello-world");
