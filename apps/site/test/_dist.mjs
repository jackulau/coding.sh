// Tests that read the built site (apps/site/dist) skip when there is no build,
// so `npm test` works before `npm run build`. A gate or CI run that must not
// skip sets CODING_SH_REQUIRE_DIST=1: then a missing build fails the test
// with "no build" instead of passing as a skip.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

export const REQUIRE_DIST = ["1", "true", "yes"].includes(String(process.env.CODING_SH_REQUIRE_DIST ?? "").toLowerCase());

/** test() options: skip when dir does not exist, unless CODING_SH_REQUIRE_DIST is set. */
export const distOpts = (dir) => ({ skip: !existsSync(dir) && !REQUIRE_DIST && `no build in ${dir}` });

/** First line of a dist test: fails with "no build" when dir is missing (reached only when a build is required). */
export const needDist = (dir) => assert.ok(existsSync(dir), `no build in ${dir}: run npm run build in apps/site (CODING_SH_REQUIRE_DIST=1 does not skip)`);
