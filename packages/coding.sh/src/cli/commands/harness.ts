// coding.sh harness snapshot|list|audit
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { bundleFromDir, bundleFromToml, DEFAULT_INCLUDE } from "../../runner/bundle.ts";
import { claudeDirOf, isPluginPath } from "../../runner/plugins.ts";
import type { HarnessBundle } from "../../core/types.ts";
import { parseSince, positiveInt, suggest, UsageError } from "../args.ts";
import { autoIngest, list, str, withContext } from "../common.ts";
import { ago, bytes, CliError, plural, tokens } from "../output.ts";
import type { CommandContext } from "../types.ts";

export function bundleJson(b: HarnessBundle): Record<string, unknown> {
  return {
    id: b.id,
    name: b.name,
    agent: b.agent,
    model: b.model ?? null,
    flags: b.flags,
    files: Object.keys(b.files).sort(),
    remove: b.remove,
    ...(b.plugins?.length ? { plugins: b.plugins.map((p) => ({ name: p.name, marketplace: p.marketplace ?? null, version: p.version ?? null })) } : {}),
    createdAt: new Date(b.createdAt).toISOString(),
    note: b.note ?? null,
  };
}

/** coding.sh harness audit: which memory and instruction files sessions loaded, read and wrote. */
async function audit(c: CommandContext): Promise<number> {
  const { out } = c;
  const agent = str(c.flags.agent);
  if (agent && !getAdapter(agent)) {
    const { ADAPTERS } = await import("../../adapters/index.ts");
    const s = suggest(agent, ADAPTERS.map((a) => a.id));
    throw new UsageError(`Unknown agent ${JSON.stringify(agent)}`, { suggestion: s ? `--agent ${s}` : undefined, reason: "unknown_agent" });
  }
  const sinceFlag = str(c.flags.since) ?? "30d";
  const since = parseSince(sinceFlag);
  const limit = positiveInt(c.flags.limit, "limit") ?? 40;
  const { memoryAudit } = await import("../../core/memory-files.ts");
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const a = await memoryAudit(ctx.index, { since, env: c.env, ...(agent ? { agent } : {}) });
    if (out.json) {
      out.data(a);
      return 0;
    }
    const t = a.totals;
    out.note(`${plural(a.sessions, "session")} since ${sinceFlag}${agent ? ` (${agent})` : ""} · ${plural(t.files, "memory or instruction file")}${t.bytes ? ` · ${bytes(t.bytes)}` : ""}`);
    if (!a.files.length) {
      out.note("No memory or instruction files found on disk or in these sessions");
      return 0;
    }
    out.note(`sessions: ${t.sessionsLoading} loaded one, ${t.sessionsReading} read one with a tool, ${t.sessionsWriting} wrote one`);
    out.note(`flags: ${t.neverRead} never read, ${t.writeOnly} write-only, ${t.loadedNotRead} ${t.loadedNotRead === 1 ? "skill" : "skills"} listed but never read`);
    if (t.loadTokens) out.note(`load cost: ${tokens(t.loadTokens)} tokens over the window${a.sessions ? `, ${tokens(Math.round(t.loadTokens / a.sessions))} per session` : ""}`);
    // Flagged files first, then the costliest to load.
    const rows = [...a.files].sort((x, y) => Number(y.flags.length > 0) - Number(x.flags.length > 0) || (y.loadTokens ?? 0) - (x.loadTokens ?? 0));
    out.table(
      ["PATH", "KIND", "SIZE", "LOADED", "READ", "WROTE", "LAST READ", "LAST WRITE", "FLAGS"],
      rows.slice(0, limit).map((r) => [r.path, r.kind, r.bytes === undefined ? "gone" : bytes(r.bytes), String(r.loaded), String(r.read), String(r.wrote), ago(r.lastRead), ago(r.lastWrite), r.flags.join(", ")]),
    );
    if (rows.length > limit) out.note(`… ${rows.length - limit} more; --limit ${rows.length} or --json lists every file`);
    return 0;
  });
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  if (c.action === "audit") return audit(c);
  return withContext(c, async (ctx) => {
    if (c.action === "list") {
      const all = await ctx.index.listBundles();
      if (out.json) {
        out.data({ bundles: all.map(bundleJson) });
        return 0;
      }
      if (!all.length) {
        out.note("No harness bundles");
        out.next("Snapshot the current harness", "coding.sh harness snapshot --agent claude-code");
        return 0;
      }
      out.table(["ID", "NAME", "AGENT", "FILES", "CREATED"], all.map((b) => [b.id.slice(0, 16), b.name, b.agent, String(Object.keys(b.files).length), ago(b.createdAt)]));
      return 0;
    }
    if (c.action !== "snapshot") throw new UsageError(`Unknown harness command ${c.action}`);
    let bundle: HarnessBundle;
    const file = str(c.flags.file);
    const plugins = list(c.flags.plugin);
    const claudeDir = claudeDirOf(c.env);
    if (file) {
      if (plugins.length) throw new UsageError("--plugin goes with --agent; in a harness TOML, list them in plugins = [...]", { reason: "invalid_argument" });
      try {
        bundle = await bundleFromToml(resolve(c.cwd, file), { blobs: ctx.blobs, claudeDir });
      } catch (e) {
        throw new CliError(`Couldn't read harness ${file}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
      }
    } else {
      const agent = str(c.flags.agent);
      if (!agent) throw new UsageError("Missing --agent <AGENT> (or --file <TOML>)", { reason: "missing_argument" });
      const adapter = getAdapter(agent);
      if (!adapter) {
        const { ADAPTERS } = await import("../../adapters/index.ts");
        const s = suggest(agent, ADAPTERS.map((a) => a.id));
        throw new UsageError(`Unknown agent ${JSON.stringify(agent)}`, { suggestion: s ? `--agent ${s}` : undefined, reason: "unknown_agent" });
      }
      const dir = resolve(c.cwd, str(c.flags.dir) ?? ".");
      const st = statSync(dir, { throwIfNoEntry: false });
      if (!st) throw new CliError(`Can't find directory ${dir}`, { reason: "not_found", next: ["Pass the project directory to snapshot:", `coding.sh harness snapshot --agent ${agent} --dir <DIR>`] });
      if (!st.isDirectory()) throw new CliError(`${dir} is not a directory`, { reason: "invalid_file", next: ["Pass the project directory to snapshot:", `coding.sh harness snapshot --agent ${agent} --dir <DIR>`] });
      if (plugins.length && agent !== "claude-code") throw new UsageError(`--plugin loads Claude Code plugins; agent ${agent} can't`, { reason: "invalid_argument" });
      const hf = adapter.harnessFiles?.();
      const include = hf ? [...hf.project, ...hf.user] : [...DEFAULT_INCLUDE];
      const model = str(c.flags.model);
      try {
        bundle = await bundleFromDir({
          name: str(c.flags.name) ?? `${agent}-${new Date().toISOString().slice(0, 10)}`,
          agent,
          dir,
          include,
          blobs: ctx.blobs,
          ...(model ? { model } : {}),
          // A plugin dir is relative to where the command runs, not --dir.
          ...(plugins.length ? { plugins: plugins.map((p) => (isPluginPath(p) && !p.startsWith("~") ? resolve(c.cwd, p) : p)), claudeDir } : {}),
        });
      } catch (e) {
        if (!plugins.length) throw e;
        throw new CliError(e instanceof Error ? e.message : String(e), { reason: "invalid_argument" });
      }
    }
    await ctx.index.putBundle(bundle);
    if (out.json) out.data({ outcome: "created", bundle: bundleJson(bundle) });
    else {
      const pl = bundle.plugins?.length ? `, ${plural(bundle.plugins.length, "plugin")} (${bundle.plugins.map((p) => p.name).join(", ")})` : "";
      out.ok(`${bundle.name}: ${plural(Object.keys(bundle.files).length, "file")}${pl}`);
      out.print(bundle.id);
    }
    return 0;
  });
}
