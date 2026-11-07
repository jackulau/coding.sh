// Import eve's local traces (.eve/traces/v1, written by `eve dev`) into coding.sh.
// Read-only on the eve side; never calls Vercel.
//
//   node scripts/import-traces.ts                 # summary of what would be imported
//   node scripts/import-traces.ts --write         # write into your coding.sh store
//   node scripts/import-traces.ts path/to/traces.json   # `eve traces show <id> --json` output or an OTLP/JSON file
import { createRedactor } from "../../../packages/coding.sh/src/core/redact.ts";
import { loadConfig } from "../../../packages/coding.sh/src/core/config.ts";
import { buildSession } from "../../../packages/coding.sh/src/core/sessions.ts";
import { openStores } from "../../../packages/coding.sh/src/store/factory.ts";
import type { AgentEvent } from "../../../packages/coding.sh/src/schema/index.ts";
import { importEveRuns } from "../../../packages/coding.sh/src/integrations/eve/index.ts";

const write = process.argv.includes("--write");
const source = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".";

const stores = write ? await openStores(loadConfig()) : undefined;
const redactor = createRedactor();
const events: AgentEvent[] = [];
for await (const e of importEveRuns(source, {
  ...(stores ? { blob: (d: string | Uint8Array) => stores.blobs.put(typeof d === "string" ? redactor.string(d) : d) } : {}),
  onError: (path, err) => console.error(`skipped ${path}: ${err.message}`),
})) {
  events.push(redactor.event(e));
}

const ids = [...new Set(events.map((e) => e.sessionId))];
if (stores) await stores.index.putEvents(events);
for (const id of ids) {
  const own = events.filter((e) => e.sessionId === id);
  const session = stores ? buildSession(await stores.index.listEvents(id), await stores.index.getSession(id)) : buildSession(own);
  if (stores) await stores.index.upsertSession(session);
  const parent = session.parent ? `  parent=${session.parent.sessionId} (${session.parent.type})` : "";
  console.log(`${id}  turns=${session.stats.turns} tools=${session.stats.toolCalls} errors=${session.stats.toolErrors}  ${JSON.stringify(session.title ?? "")}${parent}`);
}
console.log(`${events.length} events in ${ids.length} sessions${stores ? " written" : " (dry run; pass --write to store)"}`);
await stores?.index.close();
