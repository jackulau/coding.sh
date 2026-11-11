// Run a command module in this process against a throwaway store: seed sessions,
// call run(), read what it printed. No real agent home or store is opened.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlagValue } from "../../src/cli/args.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext, CommandModule } from "../../src/cli/types.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

export interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  /** Seed sessions into the store the commands open. */
  seed(sessions: Session[], events?: AgentEvent[]): Promise<void>;
  cleanup(): void;
}

export function sandbox(extra: NodeJS.ProcessEnv = {}): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cmd-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const data = join(home, ".coding.sh");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: data,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    PATH: process.env.PATH,
    ...extra,
  };
  return {
    root,
    env,
    async seed(sessions, events = []) {
      mkdirSync(data, { recursive: true });
      const index = await SqliteIndexStore.open(join(data, "index.db"));
      await index.migrate();
      for (const s of sessions) await index.upsertSession(s);
      if (events.length) await index.putEvents(events);
      await index.close();
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The variables agents and the store resolve their homes from (the list tmpEnv() in test/adapters/_helpers.ts clears). */
const AGENT_HOME_KEYS = ["HOME", "USERPROFILE", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CURSOR_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "CODING_SH_NO_AUTO_INGEST"];

export interface Ran {
  code: number | void;
  stdout: string;
  stderr: string;
  json?: any;
  error?: any;
}

export async function runCmd(mod: CommandModule, sb: Sandbox, opts: { action?: string; flags?: Record<string, FlagValue>; positionals?: string[]; rest?: string[]; json?: boolean; cwd?: string; argv?: string[] } = {}): Promise<Ran> {
  const res: Ran = { code: undefined, stdout: "", stderr: "" };
  const out = new Output({
    json: opts.json === true,
    env: sb.env,
    stdout: { write: (s: string) => ((res.stdout += s), true), isTTY: false },
    stderr: { write: (s: string) => ((res.stderr += s), true), isTTY: false },
    stdin: { isTTY: false },
  });
  const c: CommandContext = { action: opts.action, flags: opts.flags ?? {}, positionals: opts.positionals ?? [], rest: opts.rest ?? [], out, env: sb.env, cwd: opts.cwd ?? sb.env.HOME!, debug: false, signal: new AbortController().signal, argv: opts.argv };
  // Some paths (the inline transcript ingest a read runs, os.homedir()) resolve agent homes from
  // process.env, not c.env. Point those at the sandbox while the command runs, or a read would
  // ingest the real ~/.claude and ~/.codex into the sandbox store.
  const saved = Object.fromEntries(AGENT_HOME_KEYS.map((k) => [k, process.env[k]]));
  for (const k of AGENT_HOME_KEYS) {
    if (sb.env[k] === undefined) delete process.env[k];
    else process.env[k] = sb.env[k];
  }
  try {
    res.code = await mod.run(c);
  } catch (e) {
    res.error = e;
  } finally {
    for (const k of AGENT_HOME_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  if (opts.json && res.stdout.trim()) {
    try {
      res.json = JSON.parse(res.stdout);
    } catch {
      // not a single JSON document
    }
  }
  return res;
}

/** A session row with the stats most tests do not care about filled in. */
export function mkSession(id: string, startedAt: number, extra: Omit<Partial<Session>, "stats"> & { stats?: Partial<Session["stats"]> } = {}): Session {
  const { stats, ...rest } = extra;
  return { id, agent: "claude-code", title: id, startedAt, endedAt: startedAt + 1000, flags: [], stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, subagents: 0, ...stats }, ...rest } as unknown as Session; // slop-allow chained-as: a session row with only the fields these tests read
}
