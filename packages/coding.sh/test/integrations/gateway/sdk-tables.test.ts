// The SDKs' gateway tables are generated from providers.ts. This fails when the
// registry changes and the tables were not regenerated, so the TypeScript and
// Python SDKs always detect the same gateways as the server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderPyTable, renderTsTable, TABLES } from "../../../scripts/sdk-gateways.ts";
import { GATEWAY_IDS, GATEWAYS } from "../../../src/integrations/gateway/providers.ts";

describe("SDK gateway tables", () => {
  for (const t of TABLES) {
    it(`${t.path.split(/[\\/]packages[\\/]/).pop()} matches providers.ts`, () => {
      assert.ok(readFileSync(t.path, "utf8") === t.render(), `${t.path} is stale. Regenerate it: node packages/coding.sh/scripts/sdk-gateways.ts`);
    });
  }

  it("carry every gateway, host, env var and header", () => {
    const ts = renderTsTable();
    const py = renderPyTable();
    for (const id of GATEWAY_IDS) {
      const g = GATEWAYS[id];
      for (const out of [ts, py]) {
        assert.ok(out.includes(`"${id}"`), id);
        for (const s of [...g.hosts, ...g.urlEnv, ...(g.idHeaders ?? []), ...(g.markHeaders ?? [])]) assert.ok(out.includes(`"${s}"`), `${id}: ${s}`);
      }
      if (g.idPattern) assert.ok(py.includes(JSON.stringify(g.idPattern.source)), `${id}: idPattern`);
    }
  });

  it("gives the gateways with a lookup API a request id the SDKs can read", () => {
    // `gateway enrich` needs the id: a response header or a response id of a known shape.
    for (const id of GATEWAY_IDS) {
      const g = GATEWAYS[id];
      if (g.lookup) assert.ok(g.idHeaders?.length || g.idPattern, `${id} has a lookup API but no id header or id shape`);
    }
  });
});
