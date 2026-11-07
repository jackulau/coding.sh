// The shared store contract (src/store/conformance.ts in coding.sh), run against
// a real Postgres. Each test uses its own schema, dropped afterwards.
import { after, describe, it } from "node:test";
import { runBlobStoreConformance, runIndexStoreConformance } from "coding.sh/store/conformance";
import { PgBlobStore, PgIndexStore } from "../src/index.ts";
import { PG_URL, SKIP, schemaUrl } from "./helpers.ts";

if (!PG_URL) {
  describe("postgres conformance", () => {
    it("runs against CODING_SH_TEST_PG_URL", { skip: SKIP }, () => {});
  });
} else {
  runIndexStoreConformance("postgres", () => PgIndexStore.open(schemaUrl(), { dropSchemaOnClose: true }));

  // The blob suite never closes its stores, so they are closed (and their schemas dropped) here.
  const blobStores: PgBlobStore[] = [];
  runBlobStoreConformance("postgres", async () => {
    const s = await PgBlobStore.open(schemaUrl(), { dropSchemaOnClose: true });
    blobStores.push(s);
    return s;
  });
  after(async () => {
    await Promise.all(blobStores.map((s) => s.close()));
  });
}
