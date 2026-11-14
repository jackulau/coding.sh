// A node:test reporter that writes each test file's run time as JSON: { "test/a.test.ts": ms },
// the sum of the file's top-level tests, with paths relative to the working directory. CI uploads
// it so scripts/test-shards.ts can split the files into shards of equal time.
import { relative } from "node:path";

export default async function* testDurations(source) {
  const times = {};
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { file, nesting, details } = event.data ?? {};
    if (!file || nesting !== 0 || typeof details?.duration_ms !== "number") continue;
    const key = relative(process.cwd(), file).replaceAll("\\", "/");
    times[key] = (times[key] ?? 0) + details.duration_ms;
  }
  for (const k of Object.keys(times)) times[k] = Math.round(times[k]);
  yield `${JSON.stringify(times)}\n`;
}
