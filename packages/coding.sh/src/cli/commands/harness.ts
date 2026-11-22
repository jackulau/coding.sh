// coding.sh harness snapshot|list|audit|tools
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { agentFileProblems } from "../../core/agent-files.ts";
import { IMPORT_HOPS, IMPORTING, importPaths } from "../../core/memory-audit.ts";
import { userHome } from "../../core/paths.ts";
import { bundleFromDir, bundleFromToml, bundleId, DEFAULT_INCLUDE } from "../../runner/bundle.ts";
import { claudeDirOf, isPluginPath } from "../../runner/plugins.ts";
import type { BlobRef, BlobStore, HarnessBundle } from "../../core/types.ts";
import { parseSince, positiveInt, suggest, UsageError } from "../args.ts";
import { autoIngest, list, str, withContext, pendingField, readIngest } from "../common.ts";
import { ago, bytes, CliError, plural, tokens } from "../output.ts";
import type { CommandContext } from "../types.ts";

export { importPaths };

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

/** A bundle path under a dot dir of Claude Code's skills dir (its `.trash` of deleted skills), which Claude Code does not load. */
const HIDDEN_SKILL = /^(?:~\/)?\.claude\/skills\/\.[^/]+\//;

/**
 * The bundle with what Claude Code loads that the include globs miss or wrongly take: the files
 * CLAUDE.md and rules pull in with `@path` imports (followed up to 5 hops, relative to the
 * importing file, `~/` from the home), and without dot dirs under skills/. An import inside
 * `dir` is stored repo-relative, one in the home as `~/…`; one elsewhere is left out.
 */
export async function claudeCodeBundle(bundle: HarnessBundle, o: { dir: string; home: string; blobs: BlobStore }): Promise<HarnessBundle> {
  const files: Record<string, BlobRef> = {};
  for (const [k, v] of Object.entries(bundle.files)) if (!HIDDEN_SKILL.test(k)) files[k] = v;
  const local = (key: string) => (key.startsWith("~/") ? join(o.home, key.slice(2)) : join(o.dir, key));
  const keyOf = (abs: string): string | undefined => {
    for (const [base, prefix] of [[o.dir, ""], [o.home, "~/"]] as const) {
      const rel = relative(base, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return prefix + rel.split(sep).join("/");
    }
    return undefined;
  };
  let frontier = Object.keys(files).filter((k) => IMPORTING.test(k));
  const read = new Set<string>();
  for (let hop = 0; hop < IMPORT_HOPS && frontier.length; hop++) {
    const next: string[] = [];
    for (const from of frontier) {
      if (read.has(from)) continue;
      read.add(from);
      const abs = local(from);
      const text = await readFile(abs, "utf8").catch(() => "");
      for (const p of importPaths(text)) {
        const target = p.startsWith("~/") || p.startsWith("~\\") ? join(o.home, p.slice(2)) : resolve(dirname(abs), p);
        const key = keyOf(target);
        if (!key || HIDDEN_SKILL.test(key)) continue;
        // Already in the bundle (an include took it): its own imports still count.
        if (key in files) {
          if (!read.has(key)) next.push(key);
          continue;
        }
        if (!statSync(target, { throwIfNoEntry: false })?.isFile()) continue;
        files[key] = await o.blobs.put(await readFile(target));
        next.push(key);
      }
    }
    frontier = next;
  }
  const keys = Object.keys(files).sort();
  const same = keys.length === Object.keys(bundle.files).length && keys.every((k) => bundle.files[k] === files[k]);
  if (same) return bundle;
  const sorted: Record<string, BlobRef> = {};
  for (const k of keys) sorted[k] = files[k]!;
  const out = { ...bundle, files: sorted };
  return { ...out, id: bundleId(out) };
}

/** Under the audit's session count when subagents ran: what the count and the rows count them as. */
export const AUDIT_ROLLUP_NOTE = "A subagent's or delegate's loads, reads and writes count on the top-level session that started it, which the count above includes.";

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
  const { memoryAudit, memoryDirs } = await import("../../core/memory-files.ts");
  const { fallbackModelRisks } = await import("../../core/cache-setup.ts");
  // Subagent files Claude Code misreads, and a fallback model that drops the cache: the user's and this project's.
  const claudeOnly = !agent || agent === "claude-code";
  const agentFiles = claudeOnly ? agentFileProblems([join(memoryDirs(c.env).claudeDir, "agents"), join(c.cwd, ".claude", "agents")]) : [];
  const fallback = claudeOnly ? fallbackModelRisks([memoryDirs(c.env).claudeDir, join(c.cwd, ".claude")]) : [];
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const a = await memoryAudit(ctx.index, { since, env: c.env, signal: c.signal, ...(agent ? { agent } : {}) });
    if (out.json) {
      out.data({ ...a, ...(agentFiles.length ? { agentFiles } : {}), ...(fallback.length ? { fallbackModels: fallback } : {}), ...pendingField(backlog) });
      return 0;
    }
    if (fallback.length) {
      out.row("Cache", `a fallback model is set, so Claude Code rewrites the whole prompt cache at full price whenever it falls back (the cache belongs to one model)`, "warn");
      for (const f of fallback) out.note(`${f.path}: falls back to ${f.fallbackModel}. Remove \`fallbackModel\`, or pin one model, to keep the cache warm.`);
    }
    const t = a.totals;
    out.note(`${plural(a.sessions, "session")} since ${sinceFlag}${agent ? ` (${agent})` : ""} · ${plural(t.files, "memory or instruction file")}${t.bytes ? ` · ${bytes(t.bytes)}` : ""}`);
    // The rows count a subagent's or delegate's loads, reads and writes, and the count above its top-level session.
    if (a.sessions && (await (await import("./stats.ts")).hasSubagents(ctx.index, since, Date.now(), undefined))) out.note(AUDIT_ROLLUP_NOTE);
    if (agentFiles.length) {
      out.row("Agents", `${plural(agentFiles.length, "subagent file")} ${agentFiles.length === 1 ? "gives" : "give"} \`tools:\` as a map; Claude Code reads a list of tool names, so ${agentFiles.length === 1 ? "that subagent gets" : "those subagents get"} no tools`, "warn");
      for (const f of agentFiles) out.note(`${f.path}: ${f.fix ? `use \`${f.fix}\`` : "drop the `tools:` map"}`);
    }
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

/** coding.sh harness tools [pin]: each tool's description and schema hashes across proxy calls; --changed exits 1 on drift. */
async function tools(c: CommandContext): Promise<number> {
  const { out } = c;
  const sub = c.positionals[0];
  if (sub !== undefined && sub !== "pin") throw new UsageError(`Unknown harness tools command ${JSON.stringify(sub)}`, { suggestion: "harness tools pin", reason: "invalid_argument" });
  const sinceFlag = str(c.flags.since) ?? "30d";
  const since = parseSince(sinceFlag);
  const changedOnly = c.flags.changed === true;
  const { readToolPins, toolDrift, toolKey, writeToolPins, MAX_TOOL_BLOBS } = await import("../../proxy/tool-drift.ts");
  let pins;
  try {
    pins = readToolPins(c.env);
  } catch (e) {
    throw new CliError(`Couldn't read the tool pins: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file", next: ["Pin the tools again:", "coding.sh harness tools pin"] });
  }
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const d = await toolDrift(ctx.index, ctx.blobs, { since, pins, signal: c.signal });
    const notes: string[] = [];
    if (d.capped) notes.push(`Read the ${MAX_TOOL_BLOBS} most recently used of ${d.blobs} tools arrays; older ones were left out`);
    if (d.blobsMissing) notes.push(`${plural(d.blobsMissing, "tools array")} no longer stored (removed by gc)`);
    if (d.callsWithoutTools) notes.push(`${plural(d.callsWithoutTools, "proxy call")} sent tools without storing them (capture mode metadata), so ${d.callsWithoutTools === 1 ? "it is" : "they are"} not counted`);
    if (sub === "pin") {
      const now = Date.now();
      const written = d.tools.length ? writeToolPins(d.tools, c.env, now) : pins;
      // writeToolPins drops the pin of a removed tool, and skips a tool with no
      // pin that no call offered since the last pin: neither counts as pinned.
      const dropped = d.tools.filter((t) => t.changed === "removed").length;
      const pinned = d.tools.filter((t) => written[toolKey(t)]?.at === now).length;
      if (out.json) {
        const doc: Record<string, unknown> = { outcome: d.tools.length ? "pinned" : "unchanged", pinned, pins: Object.keys(written).length, since: new Date(since).toISOString() };
        if (dropped) doc.dropped = dropped;
        if (notes.length) doc.notes = notes;
        out.data({ ...doc, ...pendingField(backlog) });
        return 0;
      }
      for (const n of notes) out.note(n);
      if (!d.tools.length) {
        out.note(`No tools in proxy calls since ${sinceFlag}; nothing pinned`);
        return 0;
      }
      out.ok(`Pinned ${plural(pinned, "tool")}${dropped ? `; dropped the pins of ${plural(dropped, "removed tool")}` : ""}`);
      return 0;
    }
    const rows = changedOnly ? d.tools.filter((t) => t.changed) : d.tools;
    const code = changedOnly && rows.length ? 1 : 0;
    if (out.json) {
      const iso = (ms: number) => new Date(ms).toISOString();
      const toolRows = rows.map((t) => {
        const row: Record<string, unknown> = { ...t, firstSeen: iso(t.firstSeen), lastSeen: iso(t.lastSeen) };
        if (t.pinned) row.pinned = { ...t.pinned, at: iso(t.pinned.at) };
        return row;
      });
      const doc: Record<string, unknown> = { since: iso(since), calls: d.calls, callsWithoutTools: d.callsWithoutTools, blobs: d.blobs, capped: d.capped, tools: toolRows };
      if (notes.length) doc.notes = notes;
      out.data({ ...doc, ...pendingField(backlog) });
      return code;
    }
    out.note(`${plural(d.calls, "proxy call")} with stored tools since ${sinceFlag} · ${plural(d.tools.length, "tool")}`);
    for (const n of notes) out.note(n);
    if (!d.calls) {
      out.note("harness tools reads the tools the proxy stores with each call");
      if (!d.callsWithoutTools) out.next("Log model calls with their requests", "coding.sh proxy");
      return 0;
    }
    if (!rows.length) {
      out.ok(changedOnly ? "No tool changed" : "No tools");
      return 0;
    }
    const why = (t: (typeof rows)[number]) => (t.changed === "pin" ? "differs from pin" : t.changed === "new" ? "new since pin" : t.changed === "removed" ? "removed since pin" : t.changed === "variants" ? "changed" : t.pinned ? "pinned" : "");
    out.table(
      ["SERVER", "TOOL", "DESC", "SCHEMA", "VARIANTS", "SESSIONS", "LAST SEEN", "STATUS"],
      rows.map((t) => [t.server, t.tool, t.descSha, t.schemaSha, String(t.variants), String(t.sessions), ago(t.lastSeen), why(t)]),
    );
    if (!changedOnly && rows.some((t) => t.changed)) out.next("List only the changed tools", "coding.sh harness tools --changed");
    if (rows.some((t) => t.changed)) out.next("Accept the current definitions", "coding.sh harness tools pin");
    return code;
  });
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  if (c.action === "audit") return audit(c);
  if (c.action === "tools") return tools(c);
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
      if (agent === "claude-code") bundle = await claudeCodeBundle(bundle, { dir, home: userHome(), blobs: ctx.blobs });
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
