// Wires the coding.sh MCP server: one lazily opened store per process, the
// spool ingested before reads (throttled) so answers include what was just
// captured, and the stdio loop. stdout carries protocol frames only.
//
// The ingest before a read has the CLI reads' budget (1.5 s, CODING_SH_READ_BUDGET_MS):
// past it the tool answers from what is indexed, a background `coding.sh ingest`
// finishes the rest, and the answer carries `pending: { files, indexing }`, so a
// big backlog never stalls the agent that called the tool.
import { openContext, storeOpenNext, type Context } from "../core/context.ts";
import { autoIngest, pendingField, readBudgetMs, type IngestBacklog } from "../cli/common.ts";
import { version } from "../cli/meta.ts";
import { paths } from "../core/paths.ts";
import { schemaViolations } from "../toolevals/jsonschema.ts";
import { McpServer, serveStdio, ToolError, type StdioStreams } from "./protocol.ts";
import { buildPrompts } from "./prompts.ts";
import { buildResources } from "./resources.ts";
import { buildTools, updateInfo, type ToolCtx } from "./tools.ts";

export const SERVER_NAME = "coding.sh";

export interface CodingShMcpOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Minimum gap between spool ingests (default 2000 ms). */
  ingestIntervalMs?: number;
  /** How long a tool call waits on ingest before answering from what is indexed (default: the CLI reads' budget). */
  ingestBudgetMs?: number;
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
  "To improve the user's setup, start with improve: what goes wrong most in this repo's sessions and the AGENTS.md or CLAUDE.md line that fixes it. For \"did my AGENTS.md change help?\" call harness_changes, not git.",
  "To audit the setup and trim what goes unused (memory files, skills, AGENTS.md, CLAUDE.md, rules), call harness_audit; ask the user before deleting anything, then call it with check: true. Its next is the refine run command: give it to the user, it runs for minutes.",
  "For trends use failures (raw tool errors and flags), latency, usage (tokens/cost) and subagents. experiments_list and experiment_compare read eval results.",
  "In an experiment session, call exp_session_note with the hypothesis before each run and the reading after it; exp_session_summary returns the timeline.",
  "To build evals for the user, call eval_init (a suite in evals/<name>/ from failed sessions, a skill's trigger prompts, or cases you write), then tell them its run command.",
  "eval_from_session, eval_init and exp_session_note write; ask the user before calling eval_from_session or eval_init with confirm: true.",
  'A result with pending: {files, indexing} was answered before every capture was indexed: it covers what is indexed so far; call again shortly for the rest.',
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
  // What the last ingest left for the background; reported on every answer until an ingest finds none.
  let backlog: IngestBacklog = { pendingFiles: 0, indexing: false };

  const open = (): Promise<Context> => {
    opened ??= openContext({ env, cwd }).catch((e: unknown) => {
      opened = undefined;
      // The next step follows what named the store (core/context.ts storeOpenNext).
      const next = (e as { reason?: unknown }).reason === "no_fts5" ? "Install Node 22.16 or newer" : storeOpenNext(env).join(" ");
      throw new ToolError(`Couldn't open the coding.sh store: ${e instanceof Error ? e.message : String(e)}. ${next}.`);
    });
    return opened;
  };

  // The spool, then store-based agents (T3 Code) and agents whose hooks are not firing
  // yet (untrusted Codex hooks): the same budgeted import CLI reads do. Another ingest
  // holding the lock is ingesting for us; an unreadable spool still serves what is indexed.
  const ingest = async (ctx: Context): Promise<void> => {
    try {
      backlog = await autoIngest(ctx, {
        budgetMs: o.ingestBudgetMs ?? readBudgetMs(env),
        env,
        onErrors: (errors) => log(`ingest: ${errors.length} error(s), first: ${JSON.stringify(errors[0]).slice(0, 300)}`),
      });
    } catch (e) {
      log(`ingest failed: ${(e as Error).message}`);
    }
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
  // Not in each outputSchema (every tool definition costs context on every turn): the instructions say it once.
  const tools = buildTools().map((t) => ({
    ...t,
    run: async (args: Record<string, unknown>, c: ToolCtx) => ({ ...(await t.run(args, c)), ...pendingField(backlog) }),
  }));
  const server = new McpServer<ToolCtx>({
    serverInfo: { name: SERVER_NAME, title: "coding.sh", version: version() },
    instructions: () => instructions(env),
    tools,
    resources: buildResources(store),
    prompts: buildPrompts(),
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
