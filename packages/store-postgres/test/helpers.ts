// Test helpers: every store gets a fresh schema t_<rand> on CODING_SH_TEST_PG_URL,
// dropped when the store closes. Tests skip when the variable is unset.
import { randomBytes } from "node:crypto";

export const PG_URL = process.env.CODING_SH_TEST_PG_URL;
export const SKIP = PG_URL ? false : "CODING_SH_TEST_PG_URL is unset (see packages/store-postgres/README.md)";

export function schemaUrl(schema = `t_${randomBytes(6).toString("hex")}`, extra: Record<string, string> = {}): string {
  const u = new URL(PG_URL!);
  u.searchParams.set("schema", schema);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
