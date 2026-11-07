// Tool surface (§2, §6 surfaceBytes/descriptionBytes/surfaceTokens): what an
// agent has to read to use the target, per variant.
//   MCP:  JSON.stringify(tools) as delivered after overrides; description bytes
//         are every `description` string in the tools and their inputSchema.
//   CLI:  `<bin> --help` crawled to depth 3 (`--help --json` preferred when it parses).
//   HTTP: the OpenAPI document's bytes when one is given to the agent.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { execFileTail } from "../runner/exec.ts";
import { connectMcp } from "./mcp/client.ts";
import { applyToolOverrides } from "./tap/mcp-proxy.ts";
import type { CliTarget, McpTool, SurfaceReport, Target, Variant } from "./types.ts";

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/** Bytes of every `description` (and `summary`/`title` in OpenAPI) string anywhere in v. */
export function descriptionBytesOf(v: unknown, keys: readonly string[] = ["description"]): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) for (const y of x) walk(y);
    else if (x && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        if (keys.includes(k) && typeof y === "string") n += utf8(y);
        else walk(y);
      }
    }
  };
  walk(v);
  return n;
}

export function toolsSurface(tools: readonly McpTool[], target: string, variant: string, tokens?: number): SurfaceReport {
  const surfaceBytes = utf8(JSON.stringify(tools));
  const items = tools.map((t) => ({ name: t.name, bytes: utf8(JSON.stringify(t)), descriptionBytes: descriptionBytesOf(t) }));
  const descriptionBytes = items.reduce((a, b) => a + b.descriptionBytes, 0);
  return { target, variant, surfaceBytes, descriptionBytes, surfaceTokens: tokens ?? Math.ceil(surfaceBytes / 4), tokensEstimated: tokens === undefined, items };
}

/** Subcommand names from a help page: the rows of a "Commands" section. */
export function parseSubcommands(help: string): string[] {
  const names: string[] = [];
  let inSection = false;
  for (const raw of help.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\s*$/.test(line)) {
      continue;
    }
    if (/^\S/.test(line) || /^\s{0,1}[A-Z][\w ]*:?\s*$/.test(line)) {
      inSection = /commands?|subcommands?|actions?|capture|explore|evaluate|harness|maintain/i.test(line) && !/options|flags|arguments|examples|usage/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^\s{2,}([a-z][\w:-]*)(?:,\s*[\w-]+)*\s{2,}\S/.exec(line) ?? /^\s{2,}([a-z][\w:-]*)\s*$/.exec(line);
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

interface HelpJson {
  commands?: { name: string; commands?: { name: string }[] }[];
  command?: { commands?: { name: string }[] };
}

async function crawlCli(t: CliTarget, v: Variant, env: Record<string, string>, cwd: string): Promise<{ items: SurfaceReport["items"]; text: string }> {
  const command = v.command ?? t.command;
  const [file, ...pre] = command;
  if (!file) throw new Error(`target ${t.name}: command is empty`);
  const runHelp = async (path: string[], json: boolean) => {
    const r = await execFileTail(file, [...pre, ...path, "--help", ...(json ? ["--json"] : [])], { cwd, env: { ...process.env, ...env, NO_COLOR: "1" }, timeoutMs: 15_000, tailBytes: 1 << 20 });
    return r.exitCode === 0 ? r.stdoutTail || r.stderrTail : "";
  };
  const items: SurfaceReport["items"] = [];
  const pages: string[] = [];
  const add = (name: string, page: string) => {
    items.push({ name, bytes: utf8(page), descriptionBytes: utf8(page) });
    pages.push(page);
  };
  // Prefer a machine-readable schema (`--help --json`, Vercel guideline).
  const root = await runHelp([], true);
  let tree: HelpJson | undefined;
  try {
    tree = JSON.parse(root) as HelpJson;
  } catch {
    tree = undefined;
  }
  if (tree && (Array.isArray(tree.commands) || tree.command)) {
    add(t.bin, root);
    if (t.helpCrawl) {
      for (const c of tree.commands ?? []) {
        const page = await runHelp([c.name], true);
        if (page) add(`${t.bin} ${c.name}`, page);
      }
    }
    return { items, text: pages.join("\n") };
  }
  const seen = new Set<string>();
  const visit = async (path: string[], depth: number) => {
    const key = path.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    const page = await runHelp(path, false);
    if (!page) return;
    add([t.bin, ...path].join(" "), page);
    if (!t.helpCrawl || depth >= 3) return;
    for (const sub of parseSubcommands(page)) if (sub !== "help") await visit([...path, sub], depth + 1);
  };
  await visit([], 1);
  return { items, text: pages.join("\n") };
}

export async function measureSurface(
  t: Target,
  v: Variant,
  opts: { countTokens?: (s: string) => Promise<number>; cwd?: string; env?: Record<string, string>; suiteDir?: string; fetch?: typeof fetch } = {},
): Promise<SurfaceReport> {
  const env = { ...(t.env ?? {}), ...(v.env ?? {}), ...(opts.env ?? {}) };
  const tokens = async (s: string) => {
    if (!opts.countTokens) return undefined;
    try {
      return await opts.countTokens(s);
    } catch {
      return undefined;
    }
  };
  if (t.kind === "mcp") {
    const client = await connectMcp(
      t.transport === "stdio" ? { stdio: v.command ?? t.command, env, cwd: opts.cwd } : { url: v.url ?? t.url, headers: t.headers, fetch: opts.fetch },
    );
    try {
      const tools = applyToolOverrides(await client.listTools(), v);
      return toolsSurface(tools, t.name, v.name, await tokens(JSON.stringify(tools)));
    } finally {
      await client.close();
    }
  }
  if (t.kind === "cli") {
    const { items, text } = await crawlCli(t, v, env, opts.cwd ?? process.cwd());
    const surfaceBytes = items.reduce((a, b) => a + b.bytes, 0);
    const n = text ? await tokens(text) : undefined;
    return { target: t.name, variant: v.name, surfaceBytes, descriptionBytes: surfaceBytes, surfaceTokens: n ?? Math.ceil(surfaceBytes / 4), tokensEstimated: n === undefined, items };
  }
  if (!t.openapi) return { target: t.name, variant: v.name, surfaceBytes: 0, descriptionBytes: 0, surfaceTokens: 0, tokensEstimated: true, items: [] };
  const file = isAbsolute(t.openapi) ? t.openapi : resolve(opts.suiteDir ?? opts.cwd ?? process.cwd(), t.openapi);
  const text = await readFile(file, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  const items: SurfaceReport["items"] = [];
  const paths = doc && typeof doc === "object" ? ((doc as { paths?: Record<string, unknown> }).paths ?? {}) : {};
  for (const [p, def] of Object.entries(paths)) items.push({ name: p, bytes: utf8(JSON.stringify(def)), descriptionBytes: descriptionBytesOf(def, ["description", "summary"]) });
  const surfaceBytes = utf8(text);
  const n = await tokens(text);
  return { target: t.name, variant: v.name, surfaceBytes, descriptionBytes: descriptionBytesOf(doc, ["description", "summary"]), surfaceTokens: n ?? Math.ceil(surfaceBytes / 4), tokensEstimated: n === undefined, items };
}
