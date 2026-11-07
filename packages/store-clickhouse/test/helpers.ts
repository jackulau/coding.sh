// Test helpers: every store gets a fresh database t_<rand> on CODING_SH_TEST_CH_URL,
// dropped when the store closes. Tests skip when the variable is unset.
import { randomBytes } from "node:crypto";

export const CH_URL = process.env.CODING_SH_TEST_CH_URL;
export const SKIP = CH_URL ? false : "CODING_SH_TEST_CH_URL is unset (see packages/store-clickhouse/README.md)";

export function dbUrl(database = `t_${randomBytes(6).toString("hex")}`): string {
  const u = new URL(CH_URL!);
  u.pathname = `/${database}`;
  return u.toString();
}
