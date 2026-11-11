// Forking a session at a step: the model call that produced step N, sent again
// with a changed harness (CLAUDE.md, AGENTS.md, a rule or skill, the system
// prompt, the model), and what the model does next compared with what the
// agent did at the time.
//
// The starting context is the request coding.sh proxy stored for that call
// (redacted, as stored). A context file is changed where the agent put it:
// Claude Code's "Contents of <path> (…):" sections and Codex's "# AGENTS.md
// instructions for <dir>" block, in every user message that carries one. A
// file the request did not carry is added the way Claude Code adds CLAUDE.md.
// The sending is exp replay's (experiments/replay.ts).
import { isAbsolute, join, posix } from "node:path";
import { commandOf, type ReplayStep } from "../core/replay.ts";
import type { BlobStore, HarnessBundle, IndexStore } from "../core/types.ts";
import type { Prices } from "../core/pricing.ts";
import type { FetchLike } from "../judge/http.ts";
import { loadCall, type LoadedCall } from "../proxy/calls.ts";
import type { Api, FirstAction } from "../proxy/wire.ts";
import type { AgentEvent } from "../schema/index.ts";
import { actionsDiffer, type ContextFile, type FirstAction as TurnAction } from "./continuation.ts";
import { hasReplayAuth, REPLAY_KEY_ENV, REPLAY_OAUTH_ENV, replayable, sendReplay, type ReplayCase, type ReplayOutput } from "./replay.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class ForkError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "ForkError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- the change

/** What the fork changes: context files (path as the agent sees it, relative to the session's directory or `~/…`), files it goes without, and request fields (model, system). */
export interface HarnessChange {
  files: ContextFile[];
  remove: string[];
  set: Record<string, unknown>;
}

export const emptyChange = (): HarnessChange => ({ files: [], remove: [], set: {} });

/**
 * `--with` values: `DEST=SRC` uses SRC's text as DEST, `PATH` uses PATH's own
 * text, `DEST=` drops DEST. Paths are as the agent sees them.
 */
export function parseWith(values: readonly string[], readFile: (path: string) => string, into: HarnessChange = emptyChange()): HarnessChange {
  for (const v of values) {
    const eq = v.indexOf("=");
    const dest = (eq < 0 ? v : v.slice(0, eq)).trim();
    const src = eq < 0 ? dest : v.slice(eq + 1).trim();
    if (!dest) throw new ForkError(`--with ${JSON.stringify(v)}: expected DEST=SRC or a path`, "bad_with");
    if (eq >= 0 && !src) into.remove.push(dest);
    else into.files.push({ path: dest, text: readFile(src) });
  }
  return into;
}

/** A stored harness bundle as a change: its context files, removals and model. Flags and env don't reach a single call. */
export async function bundleChange(bundle: HarnessBundle, blobs: BlobStore, into: HarnessChange = emptyChange()): Promise<HarnessChange> {
  for (const [path, ref] of Object.entries(bundle.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isContextPath(path)) continue;
    const text = await blobs.getText(ref);
    if (text !== undefined) into.files.push({ path, text });
  }
  for (const p of bundle.remove) if (isContextPath(p)) into.remove.push(p);
  if (bundle.model && into.set.model === undefined) into.set.model = bundle.model;
  return into;
}

/** Files an agent reads into its context: CLAUDE.md, AGENTS.md and the like, rules and skills. */
export function isContextPath(p: string): boolean {
  const s = p.replace(/\\/g, "/");
  return /(?:^|\/)(?:CLAUDE(?:\.local)?|AGENTS|GEMINI)\.md$/.test(s) || /(?:^|\/)\.claude\/rules\/.+\.md$/.test(s) || /(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(s);
}

/** One line for the change: `CLAUDE.md changed, model=claude-haiku-4-5`. */
export function changeLabel(c: HarnessChange): string {
  const parts = [...c.files.map((f) => `${f.path} changed`), ...c.remove.map((p) => `without ${p}`)];
  for (const [k, v] of Object.entries(c.set)) parts.push(k === "system" ? "system prompt changed" : `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.join(", ") || "recorded harness";
}

// ---------------------------------------------------------------- the request

/** How a context file fared in the request. */
export interface HarnessEdit {
  path: string;
  how: "replaced" | "added" | "removed" | "absent";
  /** Sections changed (a file can be in more than one message). */
  count?: number;
}

/** A text slot in a user message: read it, write it. */
interface Slot {
  get(): string;
  set(s: string): void;
}

/** The user messages' texts, in order, and how to put a new text block first in the first user message. */
function userSlots(api: Api, body: Record<string, unknown>): { slots: Slot[]; prepend(text: string): boolean } {
  const key = api === "responses" ? "input" : "messages";
  const list = body[key];
  const slots: Slot[] = [];
  let first: Record<string, unknown> | undefined;
  if (typeof list === "string") {
    slots.push({ get: () => body[key] as string, set: (s) => void (body[key] = s) });
    return { slots, prepend: (t) => ((body[key] = `${t}\n\n${body[key] as string}`), true) };
  }
  for (const m of Array.isArray(list) ? list : []) {
    if (!isObj(m) || m.role !== "user" || (m.type !== undefined && m.type !== "message")) continue;
    first ??= m;
    if (typeof m.content === "string") slots.push({ get: () => m.content as string, set: (s) => void (m.content = s) });
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (isObj(b) && typeof b.text === "string" && (b.type === "text" || b.type === "input_text")) slots.push({ get: () => b.text as string, set: (s) => void (b.text = s) });
      }
    }
  }
  return {
    slots,
    prepend(text) {
      if (!first) return false;
      if (typeof first.content === "string") first.content = `${text}\n\n${first.content}`;
      else if (Array.isArray(first.content)) first.content.unshift({ type: api === "responses" ? "input_text" : "text", text });
      else return false;
      return true;
    },
  };
}

/**
 * Whether `stored` (a path the agent printed) is the file `path` names: an
 * absolute path as is, a relative one in `cwd`, a `~/` one in a home directory
 * (any directory but `cwd`'s tree, since the request's home is not this one).
 */
function samePath(stored: string, path: string, cwd: string | undefined): boolean {
  const s = stored.replace(/\\/g, "/");
  const raw = path.replace(/\\/g, "/");
  const root = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (raw.startsWith("~/")) return s.endsWith(raw.slice(1)) && !(root && s.startsWith(`${root}/`));
  if (isAbsolute(raw)) return s === raw;
  const p = raw.replace(/^\.\//, "");
  return root ? s === `${root}/${p}` : s.endsWith(`/${p}`);
}

const CONTENTS = /Contents of ([^\n]+?)(?: \([^\n]*\))?:\n\n/g;
/** Where a "Contents of" section's text ends: the next section, the next Claude Code context heading, or the end of the reminder. */
const SECTION_END = /\n\nContents of [^\n]+:\n\n|\n+# (?:currentDate|gitStatus|claudeMd|important\w*)\b|\n*<\/system-reminder>/g;
const CODEX_AGENTS = /# AGENTS\.md instructions for ([^\n]+)\n\n<INSTRUCTIONS>\n([\s\S]*?)\n<\/INSTRUCTIONS>/g;

interface Section {
  start: number;
  /** Start of the text. */
  text: number;
  end: number;
}

function sections(s: string, path: string, cwd: string | undefined): Section[] {
  const out: Section[] = [];
  for (const m of s.matchAll(CONTENTS)) {
    if (!samePath(m[1]!, path, cwd)) continue;
    const text = m.index! + m[0].length;
    SECTION_END.lastIndex = text;
    const end = SECTION_END.exec(s)?.index ?? s.length;
    out.push({ start: m.index!, text, end });
  }
  if (out.length || !/(?:^|\/)AGENTS\.md$/.test(path)) return out;
  for (const m of s.matchAll(CODEX_AGENTS)) {
    if (!samePath(`${m[1]!.replace(/\/+$/, "")}/AGENTS.md`, path, cwd)) continue;
    const text = m.index! + m[0].indexOf("<INSTRUCTIONS>\n") + "<INSTRUCTIONS>\n".length;
    out.push({ start: m.index!, text, end: text + m[2]!.length });
  }
  return out;
}

/** A Codex request: it carries Codex's AGENTS.md block, or is a Responses call with no Claude Code context. */
function codexShaped(api: Api, slots: readonly Slot[]): boolean {
  const texts = slots.map((sl) => sl.get());
  if (texts.some((t) => /# AGENTS\.md instructions for /.test(t))) return true;
  return api === "responses" && !texts.some((t) => t.includes("Contents of "));
}

/** Puts `block` in a user message of its own before the first user message of a Responses `input` list. */
function insertCodexBlock(body: Record<string, unknown>, block: string): boolean {
  const list = body.input;
  if (!Array.isArray(list)) return false;
  const at = list.findIndex((m) => isObj(m) && m.role === "user" && (m.type === undefined || m.type === "message"));
  if (at < 0) return false;
  list.splice(at, 0, { type: "message", role: "user", content: [{ type: "input_text", text: block }] });
  return true;
}

const CLAUDE_MD_HEAD = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

/**
 * The request with the change's context files put where the agent had them,
 * and its removals taken out. The body is copied; `cwd` is the session's
 * directory (relative paths resolve against it).
 */
export function rewriteHarness(api: Api, body: Record<string, unknown>, change: Pick<HarnessChange, "files" | "remove">, cwd?: string): { body: Record<string, unknown>; edits: HarnessEdit[] } {
  const out = structuredClone(body);
  const { slots, prepend } = userSlots(api, out);
  const edits: HarnessEdit[] = [];
  const edit = (path: string, replace: (s: string, sec: Section) => string): number => {
    let count = 0;
    for (const slot of slots) {
      let s = slot.get();
      // Last first, so earlier offsets hold.
      for (const sec of sections(s, path, cwd).reverse()) {
        s = replace(s, sec);
        count++;
      }
      if (count) slot.set(s);
    }
    return count;
  };
  for (const f of change.files) {
    const text = f.text.replace(/\s+$/, "");
    const count = edit(f.path, (s, sec) => s.slice(0, sec.text) + text + s.slice(sec.end));
    if (count) {
      edits.push({ path: f.path, how: "replaced", ...(count > 1 ? { count } : {}) });
      continue;
    }
    const abs = f.path.startsWith("~/") || isAbsolute(f.path) || !cwd ? f.path : join(cwd, f.path).replace(/\\/g, "/");
    // Codex's own shape: an AGENTS.md block as a user message of its own, before the prompt.
    if (codexShaped(api, slots) && /(?:^|\/)AGENTS\.md$/.test(f.path)) {
      const block = `# AGENTS.md instructions for ${posix.dirname(abs)}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`;
      edits.push({ path: f.path, how: insertCodexBlock(out, block) || prepend(block) ? "added" : "absent" });
      continue;
    }
    const section = `Contents of ${abs} (project instructions, checked into the codebase):\n\n${text}`;
    // Next to the files the agent already loaded, else in a reminder of its own.
    const host = slots.find((sl) => sl.get().includes("Contents of "));
    if (host) {
      const s = host.get();
      const at = s.indexOf("Contents of ");
      host.set(`${s.slice(0, at)}${section}\n\n${s.slice(at)}`);
    } else if (!prepend(`<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n${CLAUDE_MD_HEAD}\n\n${section}\n</system-reminder>`)) {
      edits.push({ path: f.path, how: "absent" });
      continue;
    }
    edits.push({ path: f.path, how: "added" });
  }
  for (const p of change.remove) {
    const count = edit(p, (s, sec) => {
      // The whole section, and the blank line that separated it from the next.
      const tail = s.slice(sec.end).startsWith("\n\nContents of ") ? 2 : 0;
      // The last section: the blank line before it instead.
      const head = !tail && s.slice(0, sec.start).endsWith("\n\n") ? 2 : 0;
      return s.slice(0, sec.start - head) + s.slice(sec.end + tail);
    });
    edits.push({ path: p, how: count ? "removed" : "absent", ...(count > 1 ? { count } : {}) });
  }
  return { body: out, edits };
}

/**
 * The context files the request carries, with their text as the agent had it:
 * Claude Code's "Contents of" sections and Codex's AGENTS.md block. Paths in
 * `cwd` come back relative to it, others as the agent printed them.
 */
export function requestContextTexts(api: Api, body: Record<string, unknown>, cwd: string | undefined): ContextFile[] {
  const root = cwd ? `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/` : undefined;
  const rel = (p: string) => (root && p.startsWith(root) ? p.slice(root.length) : p);
  const out = new Map<string, string>();
  for (const slot of userSlots(api, structuredClone(body)).slots) {
    const s = slot.get();
    for (const m of s.matchAll(CONTENTS)) {
      const p = m[1]!.replace(/\\/g, "/");
      if (!isContextPath(p) || out.has(rel(p))) continue;
      const text = m.index! + m[0].length;
      SECTION_END.lastIndex = text;
      out.set(rel(p), s.slice(text, SECTION_END.exec(s)?.index ?? s.length));
    }
    for (const m of s.matchAll(CODEX_AGENTS)) {
      const p = `${m[1]!.replace(/\\/g, "/").replace(/\/+$/, "")}/AGENTS.md`;
      if (!out.has(rel(p))) out.set(rel(p), m[2]!);
    }
  }
  return [...out].map(([path, text]) => ({ path, text }));
}

/** Project context files the request carries ("Contents of <cwd>/<path>"), as paths relative to `cwd`. */
export function requestContextFiles(api: Api, body: Record<string, unknown>, cwd: string | undefined): string[] {
  if (!cwd) return [];
  return requestContextTexts(api, body, cwd)
    .map((f) => f.path)
    .filter((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p))
    .sort();
}

// ---------------------------------------------------------------- the call

export interface ForkPoint {
  step: ReplayStep;
  call: LoadedCall;
  /** How the call was found: its reply holds the step's tool call id, or it is the agent's last call before the step. */
  by: "tool-use" | "time";
}

/** Tool call ids in a reply. */
export function replyToolIds(api: Api, body: unknown): string[] {
  const b = isObj(body) ? body : {};
  const ids: string[] = [];
  if (api === "messages") for (const c of Array.isArray(b.content) ? b.content : []) if (isObj(c) && c.type === "tool_use" && typeof c.id === "string") ids.push(c.id);
  if (api === "responses") for (const i of Array.isArray(b.output) ? b.output : []) if (isObj(i)) for (const k of ["call_id", "id"]) if (typeof i[k] === "string") ids.push(i[k] as string);
  if (api === "chat") {
    const m = isObj((b.choices as unknown[] | undefined)?.[0]) ? ((b.choices as Record<string, unknown>[])[0]!.message as Record<string, unknown> | undefined) : undefined;
    for (const t of Array.isArray(m?.tool_calls) ? (m.tool_calls as unknown[]) : []) if (isObj(t) && typeof t.id === "string") ids.push(t.id);
  }
  return ids;
}

/** Calls the agent's own loop made: with tools (title and summary calls have none), not compactions. */
const loopCall = (e: AgentEvent) => (typeof e.payload.toolCount !== "number" || e.payload.toolCount > 0) && e.payload.compaction !== true;

/**
 * The stored model call that produced step `n`: the one whose reply holds the
 * step's tool call id, else the agent's last call before the step. For a
 * prompt step, the first call after it (the reply to that prompt).
 */
export async function forkPoint(src: { index: IndexStore; blobs: BlobStore }, sessionId: string, steps: readonly ReplayStep[], n: number): Promise<ForkPoint> {
  const step = steps[n - 1];
  if (!step) throw new ForkError(`step ${n} is past the last step (${steps.length})`, "bad_step");
  const events = await src.index.listEvents(sessionId);
  const calls = events.filter((e) => e.kind === "llm.call" && e.source === "proxy" && typeof e.payload.requestRef === "string").sort((a, b) => a.ts - b.ts);
  if (!calls.length) {
    throw new ForkError("This session has no model calls with stored requests. Forking needs the session captured through coding.sh proxy with capture mode full.", "no_calls");
  }
  const ev = events.find((e) => e.id === step.eventId);
  if (step.kind === "prompt") {
    const next = calls.find((c) => c.ts >= step.ts && loopCall(c));
    if (!next) throw new ForkError(`No stored model call answers the prompt at step ${n}`, "no_call");
    return { step, call: await loadCall(src.blobs, next), by: "time" };
  }
  const before = calls.filter((c) => c.ts <= step.ts).reverse();
  const toolUseId = ev?.kind === "tool.start" || ev?.kind === "tool.end" ? str(ev.payload.toolUseId) : undefined;
  if (toolUseId) {
    for (const c of before.slice(0, 12)) {
      const loaded = await loadCall(src.blobs, c);
      if (loaded.request && replyToolIds(loaded.request.api, loaded.response?.body).includes(toolUseId)) return { step, call: loaded, by: "tool-use" };
    }
  }
  const last = before.find(loopCall);
  if (!last) throw new ForkError(`No stored model call comes before step ${n}`, "no_call");
  return { step, call: await loadCall(src.blobs, last), by: "time" };
}

// ---------------------------------------------------------------- the fork

/** One line for an action: `Bash: npm test`, `Edit src/a.ts`, `text: "Done…"`. */
export function actionLabel(a: FirstAction | undefined, max = 90): string {
  if (!a || a.type === "none") return "nothing";
  if (a.type === "text") return `text: ${JSON.stringify(clip(a.text ?? "", max - 8))}`;
  const name = a.name ?? "tool";
  const cmd = commandOf(a.input);
  if (cmd !== undefined) return clip(`${name}: ${cmd.replace(/\s+/g, " ").trim()}`, max);
  const path = isObj(a.input) ? (str(a.input.file_path) ?? str(a.input.path) ?? str(a.input.pattern)) : undefined;
  if (path) return clip(`${name} ${path}`, max);
  return clip(`${name} ${a.input === undefined ? "" : JSON.stringify(a.input)}`.trim(), max);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export interface ForkTrial {
  action?: FirstAction;
  label: string;
  /** False when the forked action is the recorded one; undefined when both are text. */
  differs?: boolean;
  text?: string;
  model?: string;
  costUsd?: number;
  error?: string;
}

export interface ForkResult {
  sessionId: string;
  step: { n: number; kind: string; label: string };
  call: { id: string; model?: string; by: ForkPoint["by"]; messages?: number };
  change: string;
  edits: HarnessEdit[];
  recorded?: { action: FirstAction; label: string };
  trials: ForkTrial[];
  /** Trials whose first action differs from the recorded one. */
  differ: number;
}

export interface ForkStepOptions {
  index: IndexStore;
  blobs: BlobStore;
  sessionId: string;
  cwd?: string;
  steps: readonly ReplayStep[];
  step: number;
  change: HarnessChange;
  trials: number;
  upstreams: { anthropic: string; openai: string };
  env: NodeJS.ProcessEnv;
  prices: Prices;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** The point, its call ready to replay with the change applied, and the edits made. */
export async function prepareFork(o: Omit<ForkStepOptions, "trials" | "upstreams" | "env" | "prices" | "fetch" | "signal">): Promise<{ point: ForkPoint; rc: ReplayCase; edits: HarnessEdit[] }> {
  const point = await forkPoint(o, o.sessionId, o.steps, o.step);
  const rc = replayable(point.call);
  if (typeof rc === "string") throw new ForkError(`The call at step ${o.step} can't be sent again: ${rc}`, "not_replayable");
  const { body, edits } = rewriteHarness(rc.api, rc.call.request!.body, o.change, o.cwd);
  return { point, rc: { ...rc, call: { ...rc.call, request: { ...rc.call.request!, body } } }, edits };
}

/** Sends step N's call again with the change, `trials` times, and compares each first action with the recorded one. */
export async function forkStep(o: ForkStepOptions): Promise<ForkResult> {
  const { point, rc, edits } = await prepareFork(o);
  if (!hasReplayAuth(rc.provider, o.env)) {
    throw new ForkError(`Forking calls the ${rc.provider === "anthropic" ? "Anthropic" : "OpenAI"} API: set ${REPLAY_KEY_ENV[rc.provider]}${rc.provider === "anthropic" ? ` or ${REPLAY_OAUTH_ENV}` : ""}`, "missing_api_key");
  }
  const runs = await Promise.all(
    Array.from({ length: o.trials }, async (): Promise<ReplayOutput | Error> => {
      try {
        return await sendReplay(rc, o.change.set, { upstreams: o.upstreams, env: o.env, prices: o.prices, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.signal ? { signal: o.signal } : {}) });
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    }),
  );
  const trials: ForkTrial[] = runs.map((r) => {
    if (r instanceof Error) return { label: "error", error: r.message };
    const t: ForkTrial = { action: r.action, label: actionLabel(r.action) };
    if (rc.recorded) {
      const d = actionsDiffer(asAction(rc.recorded), asAction(r.action));
      if (d !== undefined) t.differs = d;
    }
    if (r.text) t.text = r.text;
    if (r.model) t.model = r.model;
    if (r.costUsd !== undefined) t.costUsd = r.costUsd;
    return t;
  });
  const e = point.call.event;
  const model = str(rc.call.request?.body.model) ?? e.model;
  return {
    sessionId: o.sessionId,
    step: { n: point.step.n, kind: point.step.kind, label: point.step.label },
    call: { id: e.id, ...(model ? { model } : {}), by: point.by, ...(typeof e.payload.messageCount === "number" ? { messages: e.payload.messageCount } : {}) },
    change: changeLabel(o.change),
    edits,
    ...(rc.recorded ? { recorded: { action: rc.recorded, label: actionLabel(rc.recorded) } } : {}),
    trials,
    differ: trials.filter((t) => t.differs === true).length,
  };
}

type ForkSession = { id: string; cwd?: string };
type ForkSteps = { steps: readonly ReplayStep[] };

/** The viewer's forks (`coding.sh ui`): what step N's fork starts from, and the fork with context files changed (`""` drops one). */
export function viewerForks(o: { index: IndexStore; blobs: BlobStore; env: NodeJS.ProcessEnv; prices: Prices; upstreams: { anthropic: string; openai: string } }) {
  const base = (s: ForkSession, replay: ForkSteps, step: number, change: HarnessChange) => ({ index: o.index, blobs: o.blobs, sessionId: s.id, ...(s.cwd ? { cwd: s.cwd } : {}), steps: replay.steps, step, change });
  return {
    async preview(s: ForkSession, replay: ForkSteps, step: number) {
      const { point, rc } = await prepareFork(base(s, replay, step, emptyChange()));
      const e = point.call.event;
      const model = str(rc.call.request?.body.model) ?? e.model;
      return {
        step: { n: point.step.n, kind: point.step.kind, label: point.step.label },
        call: { id: e.id, ...(model ? { model } : {}), by: point.by, ...(typeof e.payload.messageCount === "number" ? { messages: e.payload.messageCount } : {}) },
        files: requestContextTexts(rc.api, rc.call.request!.body, s.cwd),
        ...(rc.recorded ? { recorded: { action: rc.recorded, label: actionLabel(rc.recorded) } } : {}),
        canCall: hasReplayAuth(rc.provider, o.env),
        keyEnv: REPLAY_KEY_ENV[rc.provider],
      };
    },
    run(s: ForkSession, replay: ForkSteps, step: number, files: Record<string, string>, trials: number): Promise<ForkResult> {
      const change = emptyChange();
      for (const [path, text] of Object.entries(files)) {
        if (text) change.files.push({ path, text });
        else change.remove.push(path);
      }
      return forkStep({ ...base(s, replay, step, change), trials, upstreams: o.upstreams, env: o.env, prices: o.prices });
    },
  };
}

const asAction = (x: FirstAction): TurnAction => (x.type === "tool" ? { type: "tool", name: x.name ?? "?", input: x.input } : { type: "text" });
