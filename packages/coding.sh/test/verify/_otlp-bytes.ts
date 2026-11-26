// Shared by otlp-proto-bytes-traces.test.ts and otlp-proto-bytes-logs.test.ts: which fixtures each covers.
import { FIXTURES, loadFixture, type Fixture } from "./_otlp.ts";

/**
 * The fixtures posted to `route` at `bound` (the file's CODING_SH_MODEL_BOUND): every one at 2 or more, and
 * below that the one whose protobuf encoding is shortest.
 */
export function bytesFixtures(route: "/v1/traces" | "/v1/logs", bound: number): Fixture[] {
  const all = FIXTURES.map(loadFixture).filter((f) => f.route === route);
  if (bound >= 2) return all;
  return [all.reduce((a, b) => (b.pb.length < a.pb.length ? b : a))];
}
