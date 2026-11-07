// Writes the SDKs' gateway detection tables from the one registry,
// src/integrations/gateway/providers.ts, so the TypeScript and Python SDKs spot
// the same gateways as the server (base URL host, self-hosted URL env var,
// request id header, marker header, request id shape):
//   - packages/sdk/src/gateway-table.ts
//   - packages/sdk-python/src/coding_sh/_gateway_table.py
//
//   node packages/coding.sh/scripts/sdk-gateways.ts          # rewrite both files
//   node packages/coding.sh/scripts/sdk-gateways.ts --check  # exit 1 when one is stale
//
// test/integrations/gateway/sdk-tables.test.ts runs the same check in `npm test`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GATEWAY_IDS, GATEWAYS } from "../src/integrations/gateway/providers.ts";

export const TS_TABLE_PATH = fileURLToPath(new URL("../../sdk/src/gateway-table.ts", import.meta.url));
export const PY_TABLE_PATH = fileURLToPath(new URL("../../sdk-python/src/coding_sh/_gateway_table.py", import.meta.url));

const REGEN = "node packages/coding.sh/scripts/sdk-gateways.ts";

interface Row {
  id: string;
  hosts: readonly string[];
  urlEnv: readonly string[];
  idPattern?: RegExp;
  idHeaders: readonly string[];
  markHeaders: readonly string[];
}

function rows(): Row[] {
  return GATEWAY_IDS.map((id) => {
    const g = GATEWAYS[id];
    const p = g.idPattern;
    // Both languages must read the pattern the same way: plain classes, anchors and quantifiers, `i` at most.
    if (p && (p.flags.replace("i", "") !== "" || /[(?<\\]/.test(p.source))) throw new Error(`${id}: idPattern ${p} uses syntax the Python table can't mirror`);
    for (const h of [...(g.idHeaders ?? []), ...(g.markHeaders ?? [])]) if (h !== h.toLowerCase()) throw new Error(`${id}: header ${h} must be lowercase`);
    return { id, hosts: g.hosts, urlEnv: g.urlEnv, idPattern: p, idHeaders: g.idHeaders ?? [], markHeaders: g.markHeaders ?? [] };
  });
}

const list = (xs: readonly string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
const tuple = (xs: readonly string[]) => (xs.length === 1 ? `(${JSON.stringify(xs[0])},)` : `(${xs.map((x) => JSON.stringify(x)).join(", ")})`);

export function renderTsTable(): string {
  const out = [
    `// Generated from packages/coding.sh/src/integrations/gateway/providers.ts. Do not edit:`,
    `// change the registry, then run \`${REGEN}\`.`,
    ``,
    `export interface GatewayRow {`,
    `  /** Gateway name, as payload.gateway and the \`gateway:<name>\` session flag use it. */`,
    `  id: string;`,
    `  /** Inference hostnames (exact, or a parent domain when it starts with "."). */`,
    `  hosts: readonly string[];`,
    `  /** Env vars naming a self-hosted gateway's URL: a base URL on that host is routed through it. */`,
    `  urlEnv: readonly string[];`,
    `  /** Shape of the gateway's request id. */`,
    `  idPattern?: RegExp;`,
    `  /** Response headers carrying the request id \`gateway enrich\` looks up. */`,
    `  idHeaders: readonly string[];`,
    `  /** Other response headers only this gateway sets. */`,
    `  markHeaders: readonly string[];`,
    `}`,
    ``,
    `export const GATEWAY_TABLE: readonly GatewayRow[] = [`,
  ];
  for (const r of rows()) {
    const fields = [`id: ${JSON.stringify(r.id)}`, `hosts: ${list(r.hosts)}`, `urlEnv: ${list(r.urlEnv)}`];
    if (r.idPattern) fields.push(`idPattern: ${String(r.idPattern)}`);
    fields.push(`idHeaders: ${list(r.idHeaders)}`, `markHeaders: ${list(r.markHeaders)}`);
    out.push(`  { ${fields.join(", ")} },`);
  }
  out.push(`];`, ``);
  return out.join("\n");
}

export function renderPyTable(): string {
  const out = [
    `# Generated from packages/coding.sh/src/integrations/gateway/providers.ts. Do not edit:`,
    `# change the registry, then run \`${REGEN}\`.`,
    `#`,
    `# One dict per gateway: id, hosts (exact, or a parent domain when it starts with "."), url_env`,
    `# (env vars naming a self-hosted gateway's URL), id_pattern (request id shape), id_headers`,
    `# (response headers carrying the request id \`gateway enrich\` looks up), mark_headers (other`,
    `# response headers only this gateway sets).`,
    ``,
    `import re`,
    `from typing import Any, Dict, Tuple`,
    ``,
    `GATEWAY_TABLE: Tuple[Dict[str, Any], ...] = (`,
  ];
  for (const r of rows()) {
    const pattern = r.idPattern ? `re.compile(${JSON.stringify(r.idPattern.source)}${r.idPattern.flags.includes("i") ? ", re.IGNORECASE" : ""})` : "None";
    out.push(
      `    {`,
      `        "id": ${JSON.stringify(r.id)},`,
      `        "hosts": ${tuple(r.hosts)},`,
      `        "url_env": ${tuple(r.urlEnv)},`,
      `        "id_pattern": ${pattern},`,
      `        "id_headers": ${tuple(r.idHeaders)},`,
      `        "mark_headers": ${tuple(r.markHeaders)},`,
      `    },`,
    );
  }
  out.push(`)`, ``);
  return out.join("\n");
}

export const TABLES: { path: string; render: () => string }[] = [
  { path: TS_TABLE_PATH, render: renderTsTable },
  { path: PY_TABLE_PATH, render: renderPyTable },
];

function isMain(): boolean {
  return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const t of TABLES) {
    const want = t.render();
    let have = "";
    try {
      have = readFileSync(t.path, "utf8");
    } catch {}
    if (have === want) continue;
    if (check) {
      process.stderr.write(`${t.path} is stale. Regenerate it: ${REGEN}\n`);
      stale = true;
    } else {
      writeFileSync(t.path, want);
      process.stdout.write(`wrote ${t.path}\n`);
    }
  }
  if (stale) process.exit(1);
  if (check) process.stdout.write("SDK gateway tables are up to date\n");
}
