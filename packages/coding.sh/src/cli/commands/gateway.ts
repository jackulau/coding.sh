// coding.sh gateway status|enrich: LLM gateway setup and cost enrichment
// (src/integrations/gateway). Keys are read from each gateway's standard env
// var (or [gateway] / [gateway.<name>] in config.toml) and never printed.
import { createRedactor } from "../../core/redact.ts";
import { cliProxyBaseUrl, drainUsageQueue, enrichFromCliProxyApi, managementOrigin, type CliProxyEnrichReport } from "../../integrations/gateway/cliproxyapi.ts";
import type { Credits, GatewayClient } from "../../integrations/gateway/client.ts";
import { allGatewayConfigs, detectGatewaySetups, type GatewayConfig } from "../../integrations/gateway/config.ts";
import { enrichSessions } from "../../integrations/gateway/enrich.ts";
import { GATEWAY_AGENT } from "../../integrations/gateway/ids.ts";
import { lookupClient } from "../../integrations/gateway/lookups.ts";
import { gatewayFlag, GATEWAYS, isGatewayId, type GatewayId } from "../../integrations/gateway/providers.ts";
import type { Session } from "../../core/types.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { autoIngest, list, resolveSession, str, withContext, readIngest } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;

/** Row label: the name without "AI Gateway" / "proxy" / "(router.com)", so it fits the label column. */
const label = (id: GatewayId) => GATEWAYS[id].name.replace(/ (AI Gateway|proxy|\(router\.com\))$/, "");

const keyOf = (g: GatewayConfig) => (g.apiKey ? { set: true, source: g.keySource } : { set: false, env: g.apiKeyEnv });

/** What `gateway enrich` can do for a gateway, in a few words. */
function lookupLabel(g: GatewayConfig): string {
  const def = GATEWAYS[g.id];
  if (def.drain) return g.apiKey ? `usage queue drain with --gateway ${g.id}` : `usage drain needs ${g.apiKeyEnv}`;
  if (!def.lookup) return "detect only (no lookup API)";
  const r = lookupClient(g);
  return "client" in r ? "lookups on" : r.missing === "key" ? `lookups need ${g.apiKeyEnv}` : `lookups need config: ${r.detail}`;
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const only = str(c.flags.gateway);
  if (only !== undefined && !isGatewayId(only)) throw new UsageError(`Unknown gateway ${JSON.stringify(only)}`);
  const configs = allGatewayConfigs(env).filter((g) => !only || g.id === only);
  const main = configs.find((g) => g.id === (only ?? "vercel"))!;

  switch (c.action) {
    case "status": {
      const configured = detectGatewaySetups(env, c.cwd).filter((f) => !only || f.gateway === only);
      const counts = await withContext(c, async (ctx) => {
        const per: Partial<Record<GatewayId, number>> = {};
        for (const g of configs) per[g.id] = (await ctx.index.listSessions({ flag: gatewayFlag(g.id), limit: 1000 })).filter((s) => s.agent !== GATEWAY_AGENT).length;
        const drained = !only || only === "vercel" ? (await ctx.index.listSessions({ agent: GATEWAY_AGENT, limit: 1000 })).length : 0;
        return { per, drained };
      });
      // Credits: the named gateway, else every gateway with a credits API and a key.
      const credits: Partial<Record<GatewayId, Credits>> = {};
      if (c.flags.credits === true) {
        const targets = configs.filter((g) => GATEWAYS[g.id].credits && (only || g.apiKey));
        if (!targets.length || targets.some((g) => !g.apiKey)) {
          const need = (targets.length ? targets : configs.filter((g) => GATEWAYS[g.id].credits)).map((g) => `$${g.apiKeyEnv}`);
          throw new CliError(`--credits needs a key in ${need.join(" or ")}`, { reason: "missing_key" });
        }
        for (const g of targets) {
          const r = lookupClient(g);
          if ("client" in r && r.client.credits) credits[g.id] = await r.client.credits(c.signal);
        }
      }
      // Show a gateway when it is the one asked for, Vercel, or has a key, a config table, routing or sessions.
      const shown = configs.filter((g) => only || g.id === "vercel" || g.apiKey || g.configured || configured.some((f) => f.gateway === g.id) || counts.per[g.id]);
      const gateways = shown.map((g) => ({
        id: g.id,
        name: GATEWAYS[g.id].name,
        ...(g.baseUrl ? { baseUrl: g.baseUrl } : {}),
        key: keyOf(g),
        lookup: GATEWAYS[g.id].lookup ?? null,
        sessions: counts.per[g.id] ?? 0,
        ...(credits[g.id] ? { credits: credits[g.id] } : {}),
      }));
      if (out.json) {
        const mainCredits = credits[main.id];
        out.data({ baseUrl: main.baseUrl ?? null, key: keyOf(main), configured, sessions: { tagged: counts.per[main.id] ?? 0, drained: counts.drained }, ...(mainCredits ? { credits: mainCredits } : {}), gateways });
        return 0;
      }
      for (const g of shown) {
        const n = counts.per[g.id] ?? 0;
        const key = g.apiKey ? `key set (${g.keySource})` : `key not set (${g.apiKeyEnv})`;
        out.row(label(g.id), `${key}; ${lookupLabel(g)}; ${plural(n, "session")} tagged ${gatewayFlag(g.id)}`, g.apiKey ? "ok" : "none");
        const cr = credits[g.id];
        if (cr) out.row("Credits", `balance ${usd(cr.balanceUsd ?? 0)}, used ${usd(cr.totalUsedUsd ?? 0)}`, "ok");
      }
      if (!configured.length) out.row("Agents", only ? `no agent config routes through ${GATEWAYS[only as GatewayId].name}` : "no agent config routes through a known gateway", "none");
      for (const f of configured) out.row(f.agent, `${GATEWAYS[f.gateway].name}: ${f.detail}${f.active ? "" : " (configured, not selected)"}`, f.active ? "ok" : "warn");
      for (const f of configured) out.note(f.where);
      if (counts.drained) out.row("Drains", `${plural(counts.drained, "day")} of drained Vercel AI Gateway traces`, "ok");
      if (!only) {
        const rest = configs.filter((g) => !shown.includes(g)).map((g) => g.id);
        if (rest.length) out.note(`Also supported: ${rest.join(", ")}. Set its key or a [gateway.<name>] table to see it here.`);
      }
      if (Object.values(counts.per).some(Boolean)) out.next("Attach billed cost and serving provider to those sessions", "coding.sh gateway enrich");
      return 0;
    }
    case "enrich": {
      const ids = list(c.flags.session);
      const since = str(c.flags.since);
      const limit = positiveInt(c.flags.limit, "limit") ?? 500;
      const offline = c.flags.offline === true;
      if (ids.length && since) throw new UsageError("Use --session or --since, not both");
      if (only && GATEWAYS[only as GatewayId].drain) return drainEnrich(c, main, ids, since, limit, offline);
      return withContext(c, async (ctx) => {
        await autoIngest(ctx, readIngest(c));
        let sessions: Session[];
        if (ids.length) sessions = await Promise.all(ids.map((id) => resolveSession(ctx, id)));
        else sessions = await ctx.index.listSessions({ since: parseSince(since ?? "30d"), limit });
        const clients: Partial<Record<GatewayId, GatewayClient>> = {};
        const missingConfig: Partial<Record<GatewayId, string>> = {};
        if (!offline) {
          for (const g of configs) {
            const r = lookupClient(g);
            if ("client" in r) clients[g.id] = r.client;
            else if (r.missing === "config") missingConfig[g.id] = r.detail;
          }
        }
        const spin = out.spin(`Linking ${plural(sessions.length, "session")}…`);
        let r;
        try {
          r = await enrichSessions({ index: ctx.index, sessions, clients, ...(only ? { only: only as GatewayId } : {}), dryRun: c.flags["dry-run"] === true, signal: c.signal });
        } finally {
          spin.stop();
        }
        const online = Object.keys(clients);
        if (out.json) {
          out.data({ dryRun: c.flags["dry-run"] === true, online: online.length > 0, lookups: online, report: r });
          return r.errors.length && !r.enriched ? 1 : 0;
        }
        const verb = c.flags["dry-run"] === true ? "would enrich" : "enriched";
        out.row("Calls", `${plural(r.calls, "llm call")} in ${plural(r.sessions, "session")}, ${r.linkable} linked to a gateway request`, r.linkable ? "ok" : "none");
        out.row("Enriched", `${verb} ${plural(r.enriched, "call")} (${r.fromCache} cached, ${r.fromDrain} from drained traces, ${r.fetched} fetched), billed ${usd(r.billedUsd)}`, r.enriched ? "ok" : "none");
        const by = Object.entries(r.byGateway);
        if (by.length > 1 || (by.length === 1 && by[0]![0] !== "vercel")) out.row("Gateways", by.map(([g, n]) => `${g} ${n}`).join(", "), "ok");
        const providers = Object.entries(r.providers).sort((a, b) => b[1] - a[1]);
        if (providers.length) out.row("Served by", providers.map(([p, n]) => `${p} ${n}`).join(", "), "ok");
        if (r.alreadyEnriched) out.note(`${plural(r.alreadyEnriched, "call")} already enriched`);
        if (r.pending) out.row("Pending", `${plural(r.pending, "request")} not in the gateway's logs yet; run again in a minute`, "warn");
        for (const [g, n] of Object.entries(r.needKeyBy)) {
          const cfg = configs.find((x) => x.id === g);
          const why = missingConfig[g as GatewayId];
          out.row("Key", `${plural(n, "request")} via ${g} need a lookup; ${why ?? `export ${cfg?.apiKeyEnv ?? "the key"}=…`} and run again`, "warn");
        }
        if (r.noLookup) out.note(`${plural(r.noLookup, "call")} went through a gateway with no lookup API and carried no cost`);
        for (const e of r.errors) out.row("Error", e, "fail");
        if (!r.linkable && r.calls) out.note("No call carried a gateway request id. Claude Code calls link through drained Vercel traces; see docs/integrations/ai-gateway.md.");
        if (!only && sessions.some((s) => s.flags?.includes(gatewayFlag("cliproxyapi")))) out.note("CLIProxyAPI usage is read only with --gateway cliproxyapi, because reading it empties its usage queue.");
        return r.errors.length && !r.enriched ? 1 : 0;
      });
    }
  }
  throw new UsageError(`Unknown gateway command ${c.action}`);
}

/**
 * `gateway enrich --gateway cliproxyapi`: pop CLIProxyAPI's usage queue and join
 * the records to sessions (integrations/gateway/cliproxyapi.ts). The read is
 * destructive, so it runs only when asked for by name, never with --dry-run or
 * --offline, and says so.
 */
async function drainEnrich(c: CommandContext, g: GatewayConfig, ids: string[], since: string | undefined, limit: number, offline: boolean): Promise<number> {
  const { out, env } = c;
  const dryRun = c.flags["dry-run"] === true;
  const base = cliProxyBaseUrl(g.baseUrl, env);
  const read = !dryRun && !offline;
  if (read && !g.apiKey) throw new CliError(`Reading CLIProxyAPI's usage queue needs its management key in $${g.apiKeyEnv}`, { reason: "missing_key", next: [`export ${g.apiKeyEnv}=…`, `coding.sh gateway enrich --gateway ${g.id}`] });
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const sessions = ids.length ? await Promise.all(ids.map((id) => resolveSession(ctx, id))) : await ctx.index.listSessions({ since: parseSince(since ?? "30d"), limit });
    if (read) out.warn(`Reading the usage queue at ${managementOrigin(base)} removes the records it returns: other readers (Usage Keeper, tokenlayer) will not get them. coding.sh keeps every record it reads.`);
    const spin = out.spin(read ? "Reading CLIProxyAPI's usage queue…" : `Joining kept CLIProxyAPI records to ${plural(sessions.length, "session")}…`);
    let r: CliProxyEnrichReport;
    try {
      r = await enrichFromCliProxyApi({
        index: ctx.index,
        sessions,
        redactor: createRedactor({ redact: ctx.config.capture.redact, patterns: ctx.config.capture.redactPatterns, env: ctx.env }),
        dryRun,
        ...(read ? { drain: (keep: (records: unknown[]) => Promise<void>) => drainUsageQueue({ baseUrl: base, key: g.apiKey!, onRecords: keep, ...(c.signal ? { signal: c.signal } : {}) }) } : {}),
      });
    } finally {
      spin.stop();
    }
    if (out.json) {
      out.data({ gateway: g.id, baseUrl: managementOrigin(base), drained: read, dryRun, report: r });
      return r.errors.length && !r.enriched ? 1 : 0;
    }
    const verb = dryRun ? "would enrich" : "enriched";
    out.row("Queue", read ? `read ${plural(r.drained, "record")} from ${managementOrigin(base)}` : `not read (${dryRun ? "--dry-run" : "--offline"}); ${plural(r.carried, "record")} kept from earlier runs`, read && r.drained ? "ok" : "none");
    out.row("Joined", `${plural(r.joined, "record")} to llm calls (${r.bySessionId} by session id, ${r.byTimeModel} by time and model)`, r.joined ? "ok" : "none");
    out.row("Enriched", `${verb} ${plural(r.enriched, "call")}${r.billedUsd ? `, upstream cost ${usd(r.billedUsd)}` : ""}; sessions tagged ${gatewayFlag(g.id)}`, r.enriched ? "ok" : "none");
    if (r.alreadyEnriched) out.note(`${plural(r.alreadyEnriched, "record")} already joined on an earlier run`);
    if (r.kept) out.row("Kept", `${plural(r.kept, "record")} with no captured call yet; the next run tries them again`, "warn");
    if (r.expired) out.note(`${plural(r.expired, "record")} older than a day matched no call and were dropped`);
    for (const e of r.errors) out.row("Error", e, "fail");
    return r.errors.length && !r.enriched ? 1 : 0;
  });
}
