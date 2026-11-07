// coding.sh collector (alias: otel): local OTLP/HTTP receiver. stdout gets the
// environment that points an agent's OpenTelemetry exporter here.
import { startReceiver } from "../../otel/receiver.ts";
import { port as portFlag, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

export function otelEnv(url: string): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: url,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    // Claude Code exports only when this is set.
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  };
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const port = portFlag(c.flags.port, 4318);
  const host = str(c.flags.host) ?? "127.0.0.1";
  return withContext(c, async (ctx) => {
    let receiver;
    try {
      receiver = await startReceiver({
        host,
        port,
        store: ctx.index,
        blobs: ctx.blobs,
        maxInlineBytes: ctx.config.capture.maxInlineBytes,
        onBatch: (b) => {
          if (b.events.length) out.note(`${b.signal}: ${plural(b.events.length, "event")}, ${plural(b.sessions.length, "session")}${b.rejected ? `, ${b.rejected} rejected` : ""}`);
        },
        onError: (e) => out.warn(e.message),
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") throw new CliError(`Can't start the collector: port ${port} is in use`, { reason: "port_in_use", next: ["Pick another port:", "coding.sh collector --port 0"] });
      throw e;
    }
    const env = otelEnv(receiver.url);
    if (out.json) out.data({ url: receiver.url, host: receiver.host, port: receiver.port, env });
    else for (const [k, v] of Object.entries(env)) out.print(`export ${k}=${v}`);
    out.note(`Ready on ${receiver.url}`);
    out.note("Press Ctrl-C to stop");
    await new Promise<void>((resolve) => c.signal.addEventListener("abort", () => resolve(), { once: true }));
    await receiver.close();
    return 130;
  });
}
