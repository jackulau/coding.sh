// coding.sh gateway status|enrich: Vercel AI Gateway setup and cost enrichment
// (src/integrations/gateway). The key is read from AI_GATEWAY_API_KEY (or
// [gateway] in config.toml) and never printed.
import { createGatewayClient } from "../../integrations/gateway/client.ts";
import { detectGatewaySetups, gatewaySettings } from "../../integrations/gateway/config.ts";
import { enrichSessions } from "../../integrations/gateway/enrich.ts";
import { GATEWAY_AGENT, GATEWAY_FLAG } from "../../integrations/gateway/ids.ts";
import type { Session } from "../../core/types.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { autoIngest, list, resolveSession, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const settings = gatewaySettings(env);
  const key = settings.apiKey ? { set: true, source: settings.keySource } : { set: false, env: settings.apiKeyEnv };

  switch (c.action) {
    case "status": {
      const configured = detectGatewaySetups(env, c.cwd);
      const counts = await withContext(c, async (ctx) => ({
        tagged: (await ctx.index.listSessions({ flag: GATEWAY_FLAG, limit: 1000 })).filter((s) => s.agent !== GATEWAY_AGENT).length,
        drained: (await ctx.index.listSessions({ agent: GATEWAY_AGENT, limit: 1000 })).length,
      }));
      let credits: { balanceUsd?: number; totalUsedUsd?: number } | undefined;
      if (c.flags.credits === true) {
        if (!settings.apiKey) throw new CliError(`--credits needs a key in $${settings.apiKeyEnv}`, { reason: "missing_key" });
        credits = await createGatewayClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey }).credits(c.signal);
      }
      if (out.json) {
        out.data({ baseUrl: settings.baseUrl, key, configured, sessions: counts, ...(credits ? { credits } : {}) });
        return 0;
      }
      out.row("Key", key.set ? `set (${key.source})` : `not set; export ${settings.apiKeyEnv}=… to enrich costs`, key.set ? "ok" : "none");
      if (!configured.length) out.row("Agents", "no agent config routes through ai-gateway.vercel.sh", "none");
      for (const f of configured) out.row(f.agent, `${f.detail}${f.active ? "" : " (configured, not selected)"}`, f.active ? "ok" : "warn");
      for (const f of configured) out.note(f.where);
      out.row("Sessions", `${plural(counts.tagged, "session")} tagged ${GATEWAY_FLAG}, ${plural(counts.drained, "day")} of drained gateway traces`, counts.tagged || counts.drained ? "ok" : "none");
      if (credits) out.row("Credits", `balance ${usd(credits.balanceUsd ?? 0)}, used ${usd(credits.totalUsedUsd ?? 0)}`, "ok");
      if (counts.tagged) out.next("Attach billed cost and serving provider to those sessions", "coding.sh gateway enrich");
      return 0;
    }
    case "enrich": {
      const ids = list(c.flags.session);
      const since = str(c.flags.since);
      const limit = positiveInt(c.flags.limit, "limit") ?? 500;
      const offline = c.flags.offline === true;
      if (ids.length && since) throw new UsageError("Use --session or --since, not both");
      return withContext(c, async (ctx) => {
        await autoIngest(ctx);
        let sessions: Session[];
        if (ids.length) sessions = await Promise.all(ids.map((id) => resolveSession(ctx, id)));
        else sessions = await ctx.index.listSessions({ since: parseSince(since ?? "30d"), limit });
        const client = settings.apiKey && !offline ? createGatewayClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey }) : undefined;
        const spin = out.spin(`Linking ${plural(sessions.length, "session")}…`);
        let r;
        try {
          r = await enrichSessions({ index: ctx.index, sessions, ...(client ? { client } : {}), dryRun: c.flags["dry-run"] === true, signal: c.signal });
        } finally {
          spin.stop();
        }
        if (out.json) {
          out.data({ dryRun: c.flags["dry-run"] === true, online: !!client, report: r });
          return r.errors.length && !r.enriched ? 1 : 0;
        }
        const verb = c.flags["dry-run"] === true ? "would enrich" : "enriched";
        out.row("Calls", `${plural(r.calls, "llm call")} in ${plural(r.sessions, "session")}, ${r.linkable} linked to a gateway generation`, r.linkable ? "ok" : "none");
        out.row("Enriched", `${verb} ${plural(r.enriched, "call")} (${r.fromCache} cached, ${r.fromDrain} from drained traces, ${r.fetched} fetched), billed ${usd(r.billedUsd)}`, r.enriched ? "ok" : "none");
        const providers = Object.entries(r.providers).sort((a, b) => b[1] - a[1]);
        if (providers.length) out.row("Served by", providers.map(([p, n]) => `${p} ${n}`).join(", "), "ok");
        if (r.alreadyEnriched) out.note(`${plural(r.alreadyEnriched, "call")} already enriched`);
        if (r.pending) out.row("Pending", `${plural(r.pending, "generation")} not in the gateway's usage log yet; run again in a minute`, "warn");
        if (r.needKey) out.row("Key", `${plural(r.needKey, "generation")} need a lookup; export ${settings.apiKeyEnv}=… and run again`, "warn");
        for (const e of r.errors) out.row("Error", e, "fail");
        if (!r.linkable && r.calls) out.note("No call carried a gateway generation id. Claude Code calls link through drained gateway traces; see docs/integrations/ai-gateway.md.");
        return r.errors.length && !r.enriched ? 1 : 0;
      });
    }
  }
  throw new UsageError(`Unknown gateway command ${c.action}`);
}
