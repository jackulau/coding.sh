// Every status label in the agents matrix is explained in the legend under it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The labels of STATUS_LABEL in components/docs/agents.ts. */
export function statusLabels(ts) {
  const body = ts.match(/STATUS_LABEL[^=]*=\s*\{([^}]*)\}/)?.[1] ?? "";
  return [...body.matchAll(/^\s*"?([\w-]+)"?:\s*"([^"]+)"/gm)].map((m) => ({ status: m[1], label: m[2] }));
}

/** Labels that the legend table's first column does not name. */
export function missingFromLegend(labels, astro) {
  const legend = astro.slice(astro.indexOf("<th>Status</th><th>Means</th>"));
  return labels.filter((l) => !legend.includes(`<td>${l.label}</td>`)).map((l) => l.label);
}

test("a label with no legend row is reported", () => {
  const labels = statusLabels('export const STATUS_LABEL = {\n  verified: "Verified",\n  tested: "Tested",\n};');
  assert.deepEqual(missingFromLegend(labels, "<th>Status</th><th>Means</th><tr><td>Verified</td><td>x</td></tr>"), ["Tested"]);
});

test("every status in the matrix is in the legend", () => {
  const labels = statusLabels(readFileSync(`${SRC}components/docs/agents.ts`, "utf8"));
  assert.ok(labels.length >= 4, "STATUS_LABEL not parsed");
  assert.deepEqual(missingFromLegend(labels, readFileSync(`${SRC}pages/docs/agents.astro`, "utf8")), []);
});

test("no status label is a bare word that needs a guess", () => {
  const labels = statusLabels(readFileSync(`${SRC}components/docs/agents.ts`, "utf8"));
  assert.deepEqual(labels.filter((l) => l.label.split(/\s+/).length < 2).map((l) => l.label), []);
});
