// Wires the coding.sh MCP server: one lazily opened store per process, the
// spool ingested before reads (throttled) so answers include what was just
// captured, and the stdio loop. stdout carries protocol frames only.
import { existsSync } from "node:fs";
import { openContext, type Context } from "../core/context.ts";
import { tailIngest } from "../cli/common.ts";
import { version } from "../cli/meta.ts";
import { paths } from "../core/paths.ts";
import { schemaViolations } from "../toolevals/jsonschema.ts";
import { McpServer, serveStdio, ToolError, type StdioStreams } from "./protocol.ts";
import { buildResources } from "./resources.ts";
import { buildTools, updateInfo, type ToolCtx } from "./tools.ts";

export const SERVER_NAME = "coding.sh";

export interface CodingShMcpOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Minimum gap between spool ingests (default 2000 ms). */
  ingestIntervalMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface CodingShMcp {
  server: McpServer<ToolCtx>;
  close(): Promise<void>;
}

const BASE_INSTRUCTIONS = [
  "coding.sh records every coding-agent session on this machine (prompts, tool calls, model calls, tokens, latency, subagents) in a local store.",
  "Start with session_current for the session you are in, sessions_list or search to find others, then session_get for a digest.",
  "For trends use failures (what went wrong lately), latency, usage (tokens/cost) and subagents. experiments_list and experiment_compare read eval results.",
  "eval_from_session is the only tool that writes; ask the user before calling it with confirm: true.",
].join(" ");

/** Server instructions, with a one-line notice when the update checker found a newer release. */
export function instructions(env: NodeJS.ProcessEnv = process.env): string {
  let note = "";
  try {
    const u = updateInfo(paths(env).root);
    if (u.available) note = ` Update available: coding.sh ${String(u.latest)} (running ${String(u.current)}). Mention it to the user once; the status tool has details.`;
  } catch {
    // no cache yet
  }
  return BASE_INSTRUCTIONS + note;
}

export function createCodingShMcp(o: CodingShMcpOptions = {}): CodingShMcp {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const log = o.log ?? ((m: string) => process.stderr.write(`coding.sh mcp: ${m}\n`));
  const now = o.now ?? Date.now;
  const interval = o.ingestIntervalMs ?? 2000;
  let opened: Promise<Context> | undefined;
  let lastIngest = -Infinity;
  let ingesting: Promise<void> | undefined;

  const open = (): Promise<Context> => {
    opened ??= openContext({ env, cwd }).catch((e: unknown) => {
      opened = undefined;
      throw new ToolError(`Couldn't open the coding.sh store: ${e instanceof Error ? e.message : String(e)}. Check the [store] section of \`coding.sh config path\`.`);
    });
    return opened;
  };

  const ingest = async (ctx: Context): Promise<void> => {
    if (ctx.storeOverridden) return;
    if (existsSync(ctx.paths.spool)) {
      try {
        const r = await ctx.ingest({ lock: { waitMs: 1000 } });
        if (r.errors.length) log(`ingest: ${r.errors.length} error(s), first: ${JSON.stringify(r.errors[0]).slice(0, 300)}`);
      } catch (e) {
        // Another process holds the ingest lock (it is ingesting for us) or the spool is unreadable: serve what is indexed.
        if ((e as Error).name !== "LockBusyError") log(`ingest failed: ${(e as Error).message}`);
      }
    }
    // Store-based agents (T3 Code) and agents whose hooks are not firing yet
    // (untrusted Codex hooks): the same import CLI reads do.
    await tailIngest(ctx);
  };

  const store = async (): Promise<Context> => {
    const ctx = await open();
    if (now() - lastIngest >= interval) {
      ingesting ??= ingest(ctx).finally(() => {
        lastIngest = now();
        ingesting = undefined;
      });
      await ingesting;
    }
    return ctx;
  };

  const ctx: ToolCtx = { env, cwd, now, store };
  const server = new McpServer<ToolCtx>({
    serverInfo: { name: SERVER_NAME, title: "coding.sh", version: version() },
    instructions: () => instructions(env),
    tools: buildTools(),
    resources: buildResources(store),
    context: () => ctx,
    validate: (args, schema) => schemaViolations(args, schema, 10),
    log,
  });
  return {
    server,
    async close() {
      const p = opened;
      opened = undefined;
      if (!p) return;
      try {
        await (await p).close();
      } catch (e) {
        log(`close: ${(e as Error).message}`);
      }
    },
  };
}

/**
 * Runs the server on stdio until stdin closes or `signal` aborts (Ctrl-C). console.log/info/debug are sent
 * to stderr for the duration so no library output can corrupt the protocol stream.
 */
export async function runStdioServer(o: CodingShMcpOptions & { io?: StdioStreams; signal?: AbortSignal } = {}): Promise<void> {
  const log = o.log ?? ((m: string) => process.stderr.write(`coding.sh mcp: ${m}\n`));
  const restore = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  const mcp = createCodingShMcp({ ...o, log });
  try {
    await serveStdio(mcp.server, o.io ?? { input: process.stdin, output: process.stdout }, log, o.signal);
  } finally {
    await mcp.close();
    Object.assign(console, restore);
  }
}
