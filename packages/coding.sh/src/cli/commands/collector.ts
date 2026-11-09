// coding.sh collector (alias: otel): local OTLP/HTTP receiver. stdout gets the
// environment that points an agent's OpenTelemetry exporter here.
import { pricesFor } from "../../core/pricing.ts";
import { createRedactor } from "../../core/redact.ts";
import { FileEvalStore } from "../../datasets/store.ts";
import { createEveEvalsHandler, EVE_EVALS_PATH } from "../../integrations/eve/evals.ts";
import { ClickHouseError, importClickHouse } from "../../otel/clickhouse.ts";
import { startReceiver } from "../../otel/receiver.ts";
import { SinkMirror } from "../../server/mirror.ts";
import { parseSince } from "../args.ts";
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
  if (c.action === "import") return importRun(c);
  const { out } = c;
  const port = portFlag(c.flags.port, 4318);
  const host = str(c.flags.host) ?? "127.0.0.1";
  return withContext(c, async (ctx) => {
    let receiver;
    // [[sinks]] get what the receiver commits, as ingest sends them hook events.
    const mirror = new SinkMirror({ sinks: ctx.sinks, blobs: ctx.blobs, config: ctx.config, log: { warn: (m, f) => out.warn(`${m}${f?.error ? `: ${String(f.error)}` : ""}`) } });
    try {
      receiver = await startReceiver({
        host,
        port,
        store: ctx.index,
        blobs: ctx.blobs,
        maxInlineBytes: ctx.config.capture.maxInlineBytes,
        prices: pricesFor(ctx.config.pricing),
        keepRaw: c.flags["keep-raw"] === true,
        onBatch: (b) => {
          mirror.add(b.events, b.sessions);
          if (b.events.length) out.note(`${b.signal}: ${plural(b.events.length, "event")}, ${plural(b.sessions.length, "session")}${b.rejected ? `, ${b.rejected} rejected` : ""}`);
        },
        onError: (e) => out.warn(e.message),
        // eve's codingShReporter posts eval runs here: a dataset version and an experiment.
        routes: {
          [EVE_EVALS_PATH]: createEveEvalsHandler({
            store: new FileEvalStore({ env: c.env, index: ctx.index }),
            redactor: createRedactor({ redact: ctx.config.capture.redact, patterns: ctx.config.capture.redactPatterns, env: ctx.env }),
            onStored: (r) => out.note(`eve evals: ${r.experiment.created ? "stored" : "already had"} experiment ${r.experiment.id} (${r.experiment.passed}/${r.experiment.n} passed) on dataset ${r.dataset.id}@${r.dataset.version}`),
            onError: (e) => out.warn(e.message),
          }),
        },
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
    await mirror.close(5000);
    return 130;
  });
}

/** coding.sh collector import --clickhouse <url>: agent traces from an otel_traces table into the store. */
async function importRun(c: CommandContext): Promise<number> {
  const { out } = c;
  const url = str(c.flags.clickhouse);
  if (!url) {
    throw new CliError("Say where to import from: --clickhouse <url>", {
      reason: "missing_argument",
      exitCode: 2,
      next: ["coding.sh collector import --clickhouse http://127.0.0.1:8123/?database=otel"],
    });
  }
  const since = parseSince(str(c.flags.since) ?? "7d");
  const table = str(c.flags.table) ?? "otel_traces";
  const where = str(c.flags.where);
  const dryRun = c.flags["dry-run"] === true;
  return withContext(c, async (ctx) => {
    const spin = out.spin(`Reading ${table}…`);
    let r;
    try {
      r = await importClickHouse({
        url,
        table,
        since,
        ...(where ? { where } : {}),
        genAiOnly: c.flags.all !== true,
        env: c.env,
        store: ctx.index,
        blobs: ctx.blobs,
        maxInlineBytes: ctx.config.capture.maxInlineBytes,
        prices: pricesFor(ctx.config.pricing),
        dryRun,
        onPage: (p) => spin.update?.(`Read ${plural(p.spans, "span")}…`),
      });
    } catch (e) {
      throw clickhouseCliError(e, url);
    } finally {
      spin.stop();
    }
    if (out.json) {
      out.data({ outcome: dryRun ? "planned" : "imported", mode: r.mode, spans: r.spans, events: r.events, inserted: r.inserted, sessions: r.sessions.length, rejected: r.rejected, errors: r.errors, cursor: r.cursor ?? null });
      return r.errors.length ? 1 : 0;
    }
    const verb = dryRun ? "would map" : "mapped";
    out.row("Spans", `read ${plural(r.spans, "span")} (${r.mode === "json" ? "JSON" : "Map"} attributes)`, "ok");
    out.row("Events", dryRun ? `${verb} ${plural(r.events, "event")}` : `${verb} ${plural(r.events, "event")}, stored ${r.inserted} new`, "ok");
    out.row("Sessions", `${dryRun ? "would write" : "wrote"} ${plural(r.sessions.length, "session")}`, "ok");
    if (r.rejected) out.row("Rejected", `${plural(r.rejected, "span")}: ${r.errors.slice(0, 3).join("; ")}`, "warn");
    if (r.cursor && !dryRun) out.note(`Next run starts after ${new Date(Number(BigInt(r.cursor.ts) / 1_000_000n)).toISOString()}`);
    if (!r.spans) out.note(c.flags.all === true ? "No spans in that range" : "No agent traces in that range (--all reads every span)");
    return r.errors.length ? 1 : 0;
  });
}

function clickhouseCliError(e: unknown, url: string): unknown {
  if (!(e instanceof ClickHouseError)) return e;
  const safe = url.replace(/\/\/[^@/]*@/, "//");
  if (e.status === 401 || e.status === 403 || /AUTHENTICATION_FAILED|Authentication failed|REQUIRED_PASSWORD/i.test(e.message)) {
    return new CliError(`ClickHouse refused the credentials: ${e.message}`, {
      reason: "clickhouse_unauthorized",
      next: ["Pass the user and password in the URL or the environment:", `CLICKHOUSE_USER=… CLICKHOUSE_PASSWORD=… coding.sh collector import --clickhouse ${safe}`],
    });
  }
  if (e.status === 0) {
    return new CliError(`Can't import from ClickHouse: ${e.message}`, {
      reason: "clickhouse_unreachable",
      next: ["Check the URL (ClickHouse's HTTP port is 8123, or 8443 with TLS):", "curl http://127.0.0.1:8123/ping"],
    });
  }
  if (e.status === 404 || /UNKNOWN_TABLE|UNKNOWN_DATABASE|doesn't exist|no SpanAttributes/i.test(e.message)) {
    return new CliError(`ClickHouse has no such traces table: ${e.message}`, {
      reason: "not_found",
      next: ["Name the database and table the collector writes to:", `coding.sh collector import --clickhouse ${safe} --table otel.otel_traces`],
    });
  }
  return new CliError(`ClickHouse error: ${e.message}`, {
    reason: "clickhouse_error",
    next: ["Check the --where condition, or run the import with --dry-run first:", `coding.sh collector import --clickhouse ${safe} --dry-run`],
  });
}
