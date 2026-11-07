// coding.sh harness snapshot|list
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { bundleFromDir, bundleFromToml, DEFAULT_INCLUDE } from "../../runner/bundle.ts";
import type { HarnessBundle } from "../../core/types.ts";
import { suggest, UsageError } from "../args.ts";
import { str, withContext } from "../common.ts";
import { ago, CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

export function bundleJson(b: HarnessBundle): Record<string, unknown> {
  return { id: b.id, name: b.name, agent: b.agent, model: b.model ?? null, flags: b.flags, files: Object.keys(b.files).sort(), remove: b.remove, createdAt: new Date(b.createdAt).toISOString(), note: b.note ?? null };
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
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
    if (file) {
      try {
        bundle = await bundleFromToml(resolve(c.cwd, file), { blobs: ctx.blobs });
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
      const hf = adapter.harnessFiles?.();
      const include = hf ? [...hf.project, ...hf.user] : [...DEFAULT_INCLUDE];
      const model = str(c.flags.model);
      bundle = await bundleFromDir({
        name: str(c.flags.name) ?? `${agent}-${new Date().toISOString().slice(0, 10)}`,
        agent,
        dir,
        include,
        blobs: ctx.blobs,
        ...(model ? { model } : {}),
      });
    }
    await ctx.index.putBundle(bundle);
    if (out.json) out.data({ outcome: "created", bundle: bundleJson(bundle) });
    else {
      out.ok(`${bundle.name}: ${plural(Object.keys(bundle.files).length, "file")}`);
      out.print(bundle.id);
    }
    return 0;
  });
}
