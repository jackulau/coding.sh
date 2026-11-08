// `replay --fork --run`: the fork as a real agent run. Claude Code starts in a
// copy of the session's directory, rolled back to before step N, with the
// changed harness files written in, and talks to the model through a splice
// in front of coding.sh proxy: every request of its main loop gets the stored
// conversation up to step N put between its first message (the prompt with
// the harness as it is now) and the rest. So the model sees the session's
// history up to the fork, and the agent's tools act on the copy. The calls are
// recorded like any proxied call, in the fork's own session.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claudeCode } from "../adapters/claude-code.ts";
import type { Replay } from "../core/replay.ts";
import type { BlobStore, Config, HarnessBundle, IndexStore } from "../core/types.ts";
import { startLocalProxy } from "../proxy/index.ts";
import type { Api } from "../proxy/wire.ts";
import type { Session } from "../schema/index.ts";
import { actionLabel, ForkError, type HarnessChange } from "./fork.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- the splice

/** The prompt of the first user message: its text blocks without <system-reminder> blocks. */
export function firstPrompt(api: Api, body: Record<string, unknown>): string | undefined {
  const list = body[api === "responses" ? "input" : "messages"];
  const first = Array.isArray(list) ? list.find((m) => isObj(m) && m.role === "user") : undefined;
  if (!isObj(first)) return typeof list === "string" ? list : undefined;
  const texts = typeof first.content === "string" ? [first.content] : Array.isArray(first.content) ? first.content.filter((b) => isObj(b) && typeof b.text === "string").map((b) => (b as { text: string }).text) : [];
  const text = texts
    .map((t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim())
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}

function stripCache(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCache);
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== "cache_control") out[k] = stripCache(x);
  return out;
}

/**
 * The live messages with the stored history put after the first one: the
 * stored messages after their first, cache markers dropped (the live request
 * sets its own) and the session's directory replaced by the fork's.
 */
export function spliceMessages(live: readonly unknown[], stored: readonly unknown[], from?: string, to?: string): unknown[] {
  if (stored.length < 2 || !live.length) return [...live];
  let history = JSON.stringify(stripCache(stored.slice(1)));
  if (from && to && from !== to) history = history.replaceAll(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1));
  return [live[0], ...(JSON.parse(history) as unknown[]), ...live.slice(1)];
}

export interface Splice {
  url: string;
  /** Requests that got the history. */
  spliced(): number;
  close(): Promise<void>;
}

/** An HTTP front for `target` that splices the stored history into each main-loop Messages request for `prompt`. */
export async function startSplice(o: { target: string; stored: readonly unknown[]; prompt: string; from?: string; to?: string }): Promise<Splice> {
  let count = 0;
  const target = new URL(o.target);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const path = req.url ?? "/";
      // Claude Code's subagents and side calls (titles, quota) keep their own context.
      if (req.method === "POST" && /\/v1\/messages(?:\?|$)/.test(path) && !req.headers["x-claude-code-agent-id"] && !req.headers["content-encoding"]) {
        try {
          const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          if (Array.isArray(json.messages) && Array.isArray(json.tools) && json.tools.length && firstPrompt("messages", json) === o.prompt.trim()) {
            json.messages = spliceMessages(json.messages, o.stored, o.from, o.to);
            body = Buffer.from(JSON.stringify(json));
            count++;
          }
        } catch {
          // not JSON: forward as is
        }
      }
      const headers: IncomingHttpHeaders = { ...req.headers, host: target.host, "content-length": String(body.length) };
      delete headers.connection;
      const up = request({ hostname: target.hostname, port: target.port, path, method: req.method, headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `coding.sh fork: ${e.message}` } }));
      });
      up.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    spliced: () => count,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------- the workspace

export interface ForkWorkspace {
  /** The copy of the session's root. */
  root: string;
  /** Where the agent starts (the session's directory inside the copy). */
  cwd: string;
  /** Per-run home for the agent's config, outside the copy. */
  home: string;
  /** Files put back as they were before step N. */
  restored: string[];
  /** Files changed at or after step N whose earlier content the replay doesn't know: left as they are now. */
  unknown: string[];
  /** Harness files written or removed. */
  harness: string[];
}

const inside = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!!r && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
};

/**
 * Copies the session's root to `<base>/work`, puts every file the agent
 * changed from step N on back to its state before step N (as far as the
 * replay knows it), and writes the change's files in. `~/…` files go to the
 * run's own home (`<base>/home`), never the user's.
 */
export async function prepareWorkspace(o: { session: Session; replay: Replay; step: number; change: HarnessChange; base?: string }): Promise<ForkWorkspace> {
  const src = o.replay.root ?? o.session.cwd;
  if (!src || !existsSync(src) || !statSync(src).isDirectory()) {
    throw new ForkError(`The session's directory ${src ?? "(unknown)"} is not on this machine, so the fork has nothing to start from`, "no_workdir");
  }
  const base = o.base ?? mkdtempSync(join(tmpdir(), "coding-sh-fork-"));
  const root = join(base, "work");
  const home = join(base, "home");
  if (existsSync(root)) throw new ForkError(`${root} already exists`, "workdir_exists");
  cpSync(src, root, { recursive: true, verbatimSymlinks: true });
  mkdirSync(home, { recursive: true });
  const cwd = o.session.cwd && inside(src, o.session.cwd) ? join(root, relative(src, o.session.cwd)) : root;
  const restored: string[] = [];
  const unknown: string[] = [];
  const total = o.replay.steps.length;
  for (const f of o.replay.tree(total)) {
    if (f.status === "read" || isAbsolute(f.path)) continue;
    const dest = resolve(root, f.path);
    if (!inside(root, dest)) continue;
    const before = await o.replay.stateAt(f.path, o.step - 2);
    const after = await o.replay.stateAt(f.path, total - 1);
    if (before.exists === after.exists && before.content !== undefined && before.content === after.content) continue;
    if (before.exists === false) {
      rmSync(dest, { force: true });
      restored.push(f.path);
    } else if (before.content !== undefined) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, before.content);
      restored.push(f.path);
    } else unknown.push(f.path);
  }
  const harness: string[] = [];
  const place = (p: string) => {
    const dest = p.startsWith("~/") ? resolve(home, p.slice(2)) : resolve(cwd, p);
    if (!inside(p.startsWith("~/") ? home : root, dest)) throw new ForkError(`--with ${p} is outside the fork's directory`, "bad_with");
    return dest;
  };
  for (const f of o.change.files) {
    const dest = place(f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.text);
    harness.push(f.path);
  }
  for (const p of o.change.remove) {
    rmSync(place(p), { force: true, recursive: true });
    harness.push(`-${p}`);
  }
  return { root, cwd, home, restored, unknown, harness };
}

// ---------------------------------------------------------------- the run

export interface ForkRunAction {
  label: string;
  /** False when its tool result was an error. */
  ok?: boolean;
}

/** The tool calls (and closing text) in Claude Code's stream-json output, in order. */
export function streamActions(stdout: string): { actions: ForkRunAction[]; result?: string; isError?: boolean; sessionId?: string } {
  const actions: ForkRunAction[] = [];
  const byId = new Map<string, ForkRunAction>();
  let result: string | undefined;
  let isError: boolean | undefined;
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof v.session_id === "string") sessionId ??= v.session_id;
    if (v.parent_tool_use_id) continue;
    const content = isObj(v.message) && Array.isArray(v.message.content) ? v.message.content : [];
    if (v.type === "assistant") {
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === "tool_use") {
          const a: ForkRunAction = { label: actionLabel({ type: "tool", name: String(b.name ?? "tool"), input: b.input }) };
          actions.push(a);
          if (typeof b.id === "string") byId.set(b.id, a);
        } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) actions.push({ label: actionLabel({ type: "text", text: b.text }) });
      }
    } else if (v.type === "user") {
      for (const b of content) if (isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const a = byId.get(b.tool_use_id);
        if (a) a.ok = b.is_error !== true;
      }
    } else if (v.type === "result") {
      if (typeof v.result === "string") result = v.result;
      if (typeof v.is_error === "boolean") isError = v.is_error;
    }
  }
  return { actions, ...(result !== undefined ? { result } : {}), ...(isError !== undefined ? { isError } : {}), ...(sessionId ? { sessionId } : {}) };
}

export interface ForkRunResult {
  workspace: ForkWorkspace;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Main-loop requests that carried the stored history. */
  spliced: number;
  actions: ForkRunAction[];
  result?: string;
  isError?: boolean;
  costUsd?: number;
  verify?: { command: string; exitCode: number | null; ok: boolean; output: string };
}

export interface RunForkOptions {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  env: NodeJS.ProcessEnv;
  session: Session;
  replay: Replay;
  step: number;
  change: HarnessChange;
  /** The stored request's messages at the fork (the history), its prompt and model. */
  stored: readonly unknown[];
  prompt: string;
  model?: string;
  upstreams: { anthropic: string; openai: string };
  base?: string;
  timeoutMs?: number;
  verify?: string;
  signal?: AbortSignal;
}

/** Runs Claude Code from step N in a prepared copy, through the splice and a recording proxy, then the verifier if any. */
export async function runFork(o: RunForkOptions): Promise<ForkRunResult> {
  if (o.session.agent !== "claude-code" || !claudeCode.run) throw new ForkError(`--run forks Claude Code sessions; this one is ${o.session.agent}`, "unsupported_agent");
  const ws = await prepareWorkspace(o);
  const proxy = await startLocalProxy({ config: o.config, index: o.index, blobs: o.blobs, env: o.env, port: 0, upstreams: o.upstreams });
  const from = o.session.cwd;
  const splice = await startSplice({ target: proxy.url, stored: o.stored, prompt: o.prompt, ...(from ? { from, to: ws.cwd } : {}) });
  const runId = `fork-${Date.now().toString(36)}`;
  const stdoutFile = join(dirname(ws.root), "stdout.jsonl");
  try {
    const bundle: HarnessBundle = { id: runId, name: "fork", agent: "claude-code", flags: [], env: {}, files: {}, remove: [], createdAt: Date.now() };
    const overlay = (await claudeCode.overlay?.(bundle, ws.root, { workDir: ws.root, runRoot: dirname(ws.root), home: ws.home })) ?? { env: {}, flags: [] };
    // The fork's ~/… files went to the run's home; the overlay's config dir is inside it.
    const env: Record<string, string> = { ...overlay.env, ANTHROPIC_BASE_URL: splice.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    const out = await claudeCode.run({ cwd: ws.cwd, instruction: o.prompt, ...(o.model ? { model: o.model } : {}), env, timeoutMs: o.timeoutMs ?? 20 * 60_000, flags: overlay.flags, runId, stdoutFile });
    const parsed = streamActions(existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : out.stdoutTail);
    const r: ForkRunResult = {
      workspace: ws,
      exitCode: out.exitCode,
      timedOut: out.timedOut,
      durationMs: out.durationMs,
      spliced: splice.spliced(),
      actions: parsed.actions,
      ...(out.sessionId ?? parsed.sessionId ? { sessionId: out.sessionId ?? parsed.sessionId } : {}),
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
      ...(out.usage?.costUsd !== undefined ? { costUsd: out.usage.costUsd } : {}),
    };
    if (o.verify) r.verify = await runVerify(o.verify, ws.cwd, o.signal);
    return r;
  } finally {
    await splice.close();
    await proxy.close();
  }
}

function runVerify(command: string, cwd: string, signal?: AbortSignal): Promise<NonNullable<ForkRunResult["verify"]>> {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    let output = "";
    const add = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-8000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (e) => done({ command, exitCode: null, ok: false, output: e.message }));
    child.on("close", (code) => done({ command, exitCode: code, ok: code === 0, output }));
  });
}
