// A forwarded attribute whose key names a secret (db.password, http.request.header.authorization)
// is replaced whatever its value looks like, as the store does for a secret-named field.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/core/redact.ts";
import { scrubAttrs, type KeyValue } from "../../src/server/forward.ts";

const r = createRedactor({ redact: ["secrets"] });
const str = (key: string, v: string): KeyValue => ({ key, value: { stringValue: v } });
const MARK = { stringValue: "[redacted:secret-field]" };

describe("scrubAttrs and secret-named keys", () => {
  for (const key of ["db.password", "http.request.header.authorization", "http.request.header.cookie", "http.request.header.x-api-key", "app.api.key", "service.client_secret", "password", "openai_api_key", "auth.token"]) {
    it(`${key} is replaced`, () => {
      const [kv] = scrubAttrs([str(key, "plainwords")], "full", r);
      assert.deepEqual(kv, { key, value: MARK });
    });
  }
  it("a secret-named key inside a kvlist or with a non-string value is replaced", () => {
    const [kv] = scrubAttrs([{ key: "config", value: { kvlistValue: { values: [str("db.password", "plainwords"), { key: "auth.token", value: { intValue: "123456" } }, str("db.name", "orders")] } } }], "full", r);
    assert.deepEqual(kv!.value, { kvlistValue: { values: [{ key: "db.password", value: MARK }, { key: "auth.token", value: MARK }, str("db.name", "orders")] } });
  });
  for (const key of ["gen_ai.usage.input_tokens", "gen_ai.request.max_tokens", "llm.token_count.prompt", "db.name", "session.id", "http.request.header.content-type"]) {
    it(`${key} is kept`, () => {
      assert.deepEqual(scrubAttrs([str(key, "plainwords")], "full", r), [str(key, "plainwords")]);
    });
  }
  it("the store redacts the same keys in an event's attributes", () => {
    const attrs = { "db.password": "plainwords", "http.request.header.authorization": "plainwords", "app.api.key": "plainwords", "db.name": "orders", "gen_ai.usage.input_tokens": "12" };
    assert.deepEqual(r.value({ attributes: attrs }), {
      attributes: { "db.password": MARK.stringValue, "http.request.header.authorization": MARK.stringValue, "app.api.key": MARK.stringValue, "db.name": "orders", "gen_ai.usage.input_tokens": "12" },
    });
  });
});
