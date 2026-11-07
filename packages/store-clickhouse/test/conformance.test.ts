// The shared store contract (src/store/conformance.ts in coding.sh), run against
// a real ClickHouse. Each test uses its own database, dropped afterwards.
// (No blob suite: this plugin has no blob store.)
import { describe, it } from "node:test";
import { runIndexStoreConformance } from "coding.sh/store/conformance";
import { ChIndexStore } from "../src/index.ts";
import { CH_URL, SKIP, dbUrl } from "./helpers.ts";

if (!CH_URL) {
  describe("clickhouse conformance", () => {
    it("runs against CODING_SH_TEST_CH_URL", { skip: SKIP }, () => {});
  });
} else {
  runIndexStoreConformance("clickhouse", () => ChIndexStore.open(dbUrl(), { dropDatabaseOnClose: true }));
}
