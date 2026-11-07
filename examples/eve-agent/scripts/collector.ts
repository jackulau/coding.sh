// Local OTLP collector with eve enrichment, for this example.
//
// Starts coding.sh's OTLP/HTTP receiver on 127.0.0.1:4318 with
// enrichSpan: enrichFromEve, writing to your coding.sh store (same config as
// the coding.sh CLI: ~/.coding.sh or $CODING_SH_HOME). Once the coding.sh CLI
// ships `coding.sh collector`, use that instead; this script is the same
// wiring in 20 lines.
//
//   node scripts/collector.ts            # Node >= 22.15, no eve needed
//   PORT=4318 STORE=memory node scripts/collector.ts   # print only, store nothing
import { loadConfig } from "../../../packages/coding.sh/src/core/config.ts";
import { openStores } from "../../../packages/coding.sh/src/store/factory.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../packages/coding.sh/src/store/memory.ts";
import { startReceiver } from "../../../packages/coding.sh/src/otel/receiver.ts";
import { enrichFromEve } from "../../../packages/coding.sh/src/integrations/eve/index.ts";

const memory = process.env.STORE === "memory";
const stores = memory ? { index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), sinks: [] } : await openStores(loadConfig());
const receiver = await startReceiver({
  port: Number(process.env.PORT ?? 4318),
  store: stores.index,
  blobs: stores.blobs,
  enrichSpan: enrichFromEve,
  onBatch: ({ events, sessions }) => {
    for (const s of sessions) {
      const parent = s.parent ? ` parent=${s.parent.sessionId}` : "";
      console.log(`${s.id} ${s.agent} turns=${s.stats.turns} tools=${s.stats.toolCalls} errors=${s.stats.toolErrors}${parent} (+${events.filter((e) => e.sessionId === s.id).length} events)`);
    }
  },
  onError: (err) => console.error("collector:", err.message),
});
console.log(`coding.sh OTLP collector (eve enrichment) on ${receiver.url}${memory ? " [memory store]" : ""}`);
process.on("SIGINT", () => void receiver.close().then(() => stores.index.close()).then(() => process.exit(0)));
