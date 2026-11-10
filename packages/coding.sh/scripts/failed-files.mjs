// A node:test reporter that writes the file of every failing test, one per line, once each.
// Used by scripts/test-ci.mjs to rerun failed files alone.
export default async function* failedFiles(source) {
  const seen = new Set();
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const file = event.data?.file;
    if (file && !seen.has(file)) {
      seen.add(file);
      yield `${file}\n`;
    }
  }
}
