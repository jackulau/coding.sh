// Shared by the hook checks in this folder (hook-entry.test.ts and hook-truncate-1.test.ts to
// hook-truncate-3.test.ts). It runs the hook's work (src/spool/hook-run.ts runHook) in-process on chosen
// stdin bytes, each batch of calls against a throwaway data dir, and checks each call against the contract
// in src/spool/hook.ts:
//
// - runHook resolves (the hook process exits 0 on it) and prints only what the flags ask for: nothing, or
//   one JSON document and "\n". It reads stdin to the end, also past the 64 MB it keeps.
// - The call writes the one spool line the contract describes, or none (CODING_SH_DISABLE, a Devin copy).
//   Ingest's reader (core/spool-read.ts) reads it back in call order, with the payload as the hook got it:
//   the JSON it parses to, or the text, without a leading BOM, and redacted by the rules. The payload sits
//   in the line when the line fits in 1023 bytes, and in a side file under spool/<agent>/raw when it does
//   not or when the hook got more than 1023 bytes. Every side file is named by a line.
// - The hook runs the rules only on a payload spool/gate.ts says may hold a secret. The spec runs them on
//   every payload, and a payload they change that the gate lets through is a problem of its own. A change
//   that only cuts a part too deep for the rules to walk (kind too-deep) is not a secret: when the gate lets
//   that payload through, the hook keeps it as it is.
// - A paused call (CODING_SH_DISABLE) appends the payload's session id to spool/disabled-sessions.
// - spool/errors.log holds exactly the failures a case expects, in order: an invalid --reply, stdin cut at
//   64 MB, a failed read.
// - Files appear only under the spool dir (the line, a side file, the ingest wake marker,
//   disabled-sessions, errors.log).
//
// The spec restates the contract. From the code under test it takes the redaction rules
// (src/spool/redact.ts, checked on their own in redact-prop.test.ts), the agent dir name (safeAgentId) and
// the fields the env gives (spool/host.ts, spool/spawned.ts, integrations/gateway/ids.ts). It asks
// spool/gate.ts only whether the hook may keep a payload as it is. That the hook opens no connection and
// starts no process but the background ingest is checked statically, in hook-imports.test.ts; that it
// touches no .git dir, in test/capture/hook.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactionTally } from "../../src/core/redact.ts";
import { listSpoolFiles, readSpoolFile, resolveRawFile } from "../../src/core/spool-read.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { gatewayFromEnv } from "../../src/integrations/gateway/ids.ts";
import { needsRedaction } from "../../src/spool/gate.ts";
import { MAX_STDIN_BYTES, runHook, type HookIO } from "../../src/spool/hook-run.ts";
import { hostOf } from "../../src/spool/host.ts";
import { redactPayload, spoolRedactor } from "../../src/spool/redact.ts";
import { spawnedByFromEnv } from "../../src/spool/spawned.ts";
import { MAX_INLINE_LINE_BYTES, safeAgentId } from "../../src/spool/write.ts";
import { preview, stdinText } from "./_common.ts";

export const FIXTURES = fileURLToPath(new URL("../fixtures/adapters/", import.meta.url));
export const PID = 4242;
export const PPID = 4241;
/** The working directory the fake process reports: the line's cwd when the payload names none. */
export const CWD = "/work/hook-cwd";

/** One payload a spool fixture carries, as the bytes an agent pipes to the hook. */
export interface Payload {
  fixture: string;
  lineNo: number;
  agent: string;
  event: string;
  bytes: Buffer;
}

/** Every payload in the spool fixtures (test/fixtures/adapters/**\/*.spool.jsonl), in file and line order. */
export function fixturePayloads(): Payload[] {
  const files = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".spool.jsonl"))
    .sort();
  const out: Payload[] = [];
  for (const fixture of files) {
    readFileSync(join(FIXTURES, fixture), "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (!text.trim()) return;
        const line = JSON.parse(text) as SpoolLine;
        const bytes = Buffer.from(typeof line.raw === "string" ? line.raw : JSON.stringify(line.raw ?? null));
        out.push({ fixture, lineNo: i + 1, agent: line.agent, event: line.event, bytes });
      });
  }
  return out;
}

/** A HookIO that pipes `stdin` and keeps what the hook prints in `out`. `over` replaces any part. */
export interface FakeIO extends HookIO {
  out: string;
  /** Bytes of stdin not read yet. */
  left(): number;
}
export function fakeIO(env: NodeJS.ProcessEnv, stdin: Buffer, over: Partial<HookIO> = {}): FakeIO {
  let pos = 0;
  const io: FakeIO = {
    env,
    out: "",
    pid: PID,
    ppid: PPID,
    cwd: () => CWD,
    read(buf) {
      const n = Math.min(buf.length, stdin.length - pos);
      stdin.copy(buf, 0, pos, pos + n);
      pos += n;
      return n;
    },
    isCharDevice: () => false,
    write(text) {
      io.out += text;
    },
    left: () => stdin.length - pos,
    ...over,
  };
  return io;
}

const parseOr = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The first `"<key>": "<string>"` in the first 64 KB of a payload too large to parse. */
function sniff(key: string, text: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text.slice(0, 65536));
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return undefined;
  }
}

/** The hook's arguments as src/spool/hook.ts documents them. */
export function parseArgv(argv: readonly string[]) {
  let reply: string | undefined;
  let pids: [number, number] | undefined;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--reply") reply = argv[++i] ?? "";
    else if (a.startsWith("--reply=")) reply = a.slice("--reply=".length);
    else if (a.startsWith("--sh-pids=")) {
      const m = /^([1-9]\d{0,9}),([1-9]\d{0,9})$/.exec(a.slice("--sh-pids=".length));
      if (m) pids = [Number(m[1]), Number(m[2])];
    } else if (!a.startsWith("--")) pos.push(a);
  }
  return { agent: pos[0] || "unknown", event: pos[1] || "unknown", echo: argv.includes("--echo-continue"), reply, pids };
}

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** What the call prints: the --reply document compacted, else {"continue":true} for --echo-continue, else nothing. */
export function expectedStdout(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const { echo, reply } = parseArgv(argv);
  if (reply !== undefined && isJson(reply)) return JSON.stringify(JSON.parse(reply)) + "\n";
  // An invalid --reply prints no reply of its own: --echo-continue still answers.
  return echo || env.CODING_SH_ECHO_CONTINUE === "1" ? '{"continue":true}\n' : "";
}

const disabled = (env: NodeJS.ProcessEnv): boolean => env.CODING_SH_DISABLE === "1" || env.CODING_SH_DISABLE === "true";

/** A Claude Code transcript path (src/spool/devin.ts): a payload naming one is Claude Code's, not Devin's. */
const CLAUDE_TRANSCRIPT = /[\\/]projects[\\/][^\\/]+[\\/][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;
/** Redaction kinds that are limits of the rules, not secrets: a subtree too deep for them to walk. */
const RULE_LIMITS = new Set(["too-deep"]);

/** The line the call writes, as ingest reads it back (no ts; the payload after a trip through JSON text), and its agent dir. */
export interface ExpectedLine {
  dir: string;
  line: Record<string, unknown>;
  /**
   * The hook got more than 1023 bytes (or cut stdin at 64 MB) and left them unparsed: the line names a
   * side file, however short redaction makes the payload.
   */
  long?: boolean;
  /** The side file's exact text, in place of `line.raw`: a payload the hook left unparsed, when redaction left it alone. */
  rawText?: string;
  /** The secret kinds the rules find in a payload spool/gate.ts lets through without them. */
  gateMiss?: string[];
}

/**
 * The line the contract says the call writes, or undefined for none. A Devin project in the env has no
 * coding.sh hook for Devin, so a Devin call is relabeled and never dropped.
 */
export function expectedLine(argv: readonly string[], stdin: Buffer, env: NodeJS.ProcessEnv, truncated = false): ExpectedLine | undefined {
  if (disabled(env)) return undefined;
  const a = parseArgv(argv);
  const text = stdinText(stdin);
  const inlineable = !truncated && Buffer.byteLength(text) <= MAX_INLINE_LINE_BYTES;
  let payload: unknown = text === "" ? "" : parseOr(text);
  // The hook parses only a payload that fits inline; a larger one it takes as text.
  const hookRaw = inlineable ? payload : text;
  const payloadCwd = typeof hookRaw === "object" && hookRaw !== null ? (hookRaw as { cwd?: unknown }).cwd : inlineable ? undefined : sniff("cwd", text);
  const cwd = typeof payloadCwd === "string" && payloadCwd ? payloadCwd : CWD;
  let agent = a.agent;
  if (agent === "claude-code" && env.DEVIN_PROJECT_DIR) {
    const transcript = isPlainObject(hookRaw) ? hookRaw.transcript_path : sniff("transcript_path", text);
    if (!(typeof transcript === "string" && transcript && CLAUDE_TRANSCRIPT.test(transcript))) agent = "devin";
  }
  const tally = redactionTally();
  const clean = redactPayload(spoolRedactor(env), payload, tally);
  const kinds = Object.keys(tally.kinds);
  const secrets = kinds.filter((k) => !RULE_LIMITS.has(k));
  const gate = needsRedaction(text, env);
  let redactions: Record<string, number> | undefined;
  if (kinds.length && (gate || secrets.length)) [payload, redactions] = [clean, { ...tally.kinds }];
  let raw: unknown;
  let rawText: string | undefined;
  // A payload the hook left unparsed goes to the side file as the hook read it, unless redaction changed it.
  if (!inlineable && !redactions) rawText = text;
  else raw = JSON.parse(JSON.stringify(payload));
  const [pid, ppid] = a.pids ?? [PID, PPID];
  const line: Record<string, unknown> = { v: 0, agent, event: a.event, pid, ppid, cwd, raw };
  if (env.CODING_SH_RUN_ID) line.runId = env.CODING_SH_RUN_ID;
  const host = hostOf(env);
  if (host) line.host = host;
  const gateway = gatewayFromEnv(env);
  if (gateway) line.gateway = gateway;
  if (agent === "claude-code" && env.CLAUDE_CODE_ENTRYPOINT) line.entrypoint = env.CLAUDE_CODE_ENTRYPOINT.slice(0, 64);
  const spawnedBy = spawnedByFromEnv(env);
  if (spawnedBy) line.spawnedBy = spawnedBy;
  if (redactions) line.redactions = redactions;
  const out: ExpectedLine = { dir: safeAgentId(agent), line };
  if (!inlineable) out.long = true;
  if (rawText !== undefined) out.rawText = rawText;
  if (!gate && secrets.length) out.gateMiss = secrets;
  return out;
}

const SESSION_KEYS = ["session_id", "conversation_id", "sessionId", "conversationId"] as const;
/** A payload of up to this size is parsed for its session id; a larger one is searched (src/spool/hook-run.ts). */
const MAX_PARSE_BYTES = 1024 * 1024;

/**
 * The session id a paused call keeps in spool/disabled-sessions, or undefined for none: the first of the
 * session keys the parsed payload has, or for a payload too large to parse or not JSON, the first one its
 * first 64 KB name, when it is a plain id.
 */
export function expectedDisabledId(stdin: Buffer, truncated = false): string | undefined {
  const text = stdinText(stdin);
  let parsed: { raw: unknown } | undefined;
  if (!truncated && Buffer.byteLength(text) <= MAX_PARSE_BYTES && isJson(text)) parsed = { raw: JSON.parse(text) };
  let id: unknown;
  if (!parsed) id = /"(?:session_id|conversation_id|sessionId|conversationId)"\s*:\s*"([^"\\]{1,128})"/.exec(text.slice(0, 65536))?.[1];
  else if (typeof parsed.raw === "object" && parsed.raw !== null) {
    const raw = parsed.raw as Record<string, unknown>;
    id = SESSION_KEYS.map((k) => raw[k]).find((v) => v !== undefined);
  }
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : undefined;
}

const LINE_KEYS = ["v", "agent", "event", "pid", "ppid", "cwd", "raw", "runId", "host", "gateway", "entrypoint", "spawnedBy", "redactions"] as const;
/** A line's fields in one order, for comparing a read-back line with an expected one. */
const comparable = (line: Record<string, unknown>): string => JSON.stringify(LINE_KEYS.map((k) => (line[k] === undefined ? "<absent>" : line[k])));

/** One call to check, with what it should print and write. */
export interface Call {
  label: string;
  argv: string[];
  stdout: string;
  expected: ExpectedLine | undefined;
  /** The start of each errors.log entry the call writes, in order. */
  errors: string[];
  /** The id a paused call appends to spool/disabled-sessions. */
  disabledId?: string;
  /** When the call ran, for its line's ts. */
  t0: number;
  t1: number;
}

/** What a case says about one call, where the spec cannot work it out from the arguments and stdin. */
export interface CallOptions {
  /** Replaces parts of the fake stdin and stdout. The call is not checked for reading stdin to the end. */
  io?: Partial<HookIO>;
  /** The hook keeps only the first MAX_STDIN_BYTES of stdin, and logs that it cut it. */
  truncated?: boolean;
  /** The line the call writes, or null for none. Default: expectedLine(). */
  expected?: ExpectedLine | null;
  /** What it prints. Default: expectedStdout(). */
  stdout?: string;
  /** The start of each errors.log entry it writes. Default: the cut stdin and an invalid --reply. */
  errors?: string[];
}

/** A stored line as ingest's reader returns it, with the side file it names read. */
interface Stored {
  line: SpoolLine;
  /** The line's bytes in the spool file, without its "\n". */
  bytes: number;
  /** The side file the line names, resolved, and its text. */
  rawPath?: string;
  rawText?: string;
}

/** A throwaway data dir and home for a batch of hook calls. */
export class HookHome {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spool: string;
  readonly calls: Call[] = [];
  readonly problems: string[] = [];

  /** `extra`: more variables for the hook, or a function of the root that returns them. */
  constructor(extra: NodeJS.ProcessEnv | ((root: string) => NodeJS.ProcessEnv) = {}) {
    this.root = mkdtempSync(join(tmpdir(), "csh-hookv-"));
    mkdirSync(join(this.root, "home"));
    const more = typeof extra === "function" ? extra(this.root) : extra;
    this.env = { HOME: join(this.root, "home"), CODING_SH_HOME: join(this.root, "csh"), ...more };
    this.spool = join(this.root, "csh", "spool");
  }

  /** Runs one call and records what it should have done. Returns what it printed. */
  async call(label: string, argv: string[], stdin: Buffer, opts: CallOptions = {}): Promise<string> {
    const io = fakeIO(this.env, stdin, opts.io);
    const t0 = Date.now();
    try {
      await runHook(argv, io);
    } catch (e) {
      this.problems.push(`${label}: runHook rejected: ${(e as Error)?.stack ?? e}`);
    }
    const t1 = Date.now();
    const stdout = opts.stdout ?? expectedStdout(argv, this.env);
    if (io.out !== stdout) this.problems.push(`${label}: printed ${JSON.stringify(io.out)}, expected ${JSON.stringify(stdout)}`);
    if (io.out) {
      try {
        JSON.parse(io.out);
      } catch {
        this.problems.push(`${label}: printed text that is not JSON: ${JSON.stringify(io.out)}`);
      }
    }
    if (!opts.io?.read && !opts.io?.isCharDevice && io.left() > 0) this.problems.push(`${label}: left ${io.left()} bytes of stdin unread`);
    const kept = opts.truncated ? stdin.subarray(0, MAX_STDIN_BYTES) : stdin;
    const expected = opts.expected === null ? undefined : (opts.expected ?? expectedLine(argv, kept, this.env, opts.truncated));
    if (expected?.gateMiss) this.problems.push(`${label}: spool/gate.ts lets through a payload the redaction rules change (${expected.gateMiss.join(", ")})`);
    let errors = opts.errors;
    if (!errors) {
      errors = [];
      if (opts.truncated && expected) errors.push(`stdin truncated at ${MAX_STDIN_BYTES} bytes`);
      const { reply } = parseArgv(argv);
      if (reply !== undefined && !isJson(reply)) errors.push("--reply is not valid JSON: ");
    }
    const call: Call = { label, argv, stdout, expected, errors, t0, t1 };
    if (disabled(this.env)) {
      const id = expectedDisabledId(kept, opts.truncated);
      if (id) call.disabledId = id;
    }
    this.calls.push(call);
    return io.out;
  }

  /** Every line in the spool, by agent dir, in the order ingest reads them. */
  async stored(): Promise<Map<string, Stored[]>> {
    const out = new Map<string, Stored[]>();
    for (const f of await listSpoolFiles(this.spool)) {
      const list = out.get(f.agent) ?? [];
      out.set(f.agent, list);
      const onError = (e: { message: string; offset: number }) => this.problems.push(`${f.source}@${e.offset}: ingest's reader: ${e.message}`);
      for await (const rec of readSpoolFile(this.spool, f.path, 0, { onError, resolveRaw: false })) {
        const s: Stored = { line: rec.line, bytes: rec.nextOffset - rec.offset - 1 };
        if (rec.line.rawFile) {
          try {
            s.rawPath = resolveRawFile(this.spool, f.path, rec.line.rawFile);
            s.rawText = readFileSync(s.rawPath, "utf8");
          } catch (e) {
            this.problems.push(`${f.source}@${rec.offset}: ${(e as Error).message}`);
          }
        }
        list.push(s);
      }
    }
    return out;
  }

  /** Every file under the root, relative to it with "/". */
  files(): string[] {
    return readdirSync(this.root, { recursive: true, withFileTypes: true })
      .filter((d) => !d.isDirectory())
      .map((d) => relative(this.root, join(d.parentPath, d.name)).split(sep).join("/"));
  }

  /** The `error` and stack of each spool/errors.log entry, in order. */
  private logged(problems: string[]): { error: string; stack?: string }[] {
    const file = join(this.spool, "errors.log");
    if (!existsSync(file)) return [];
    const out: { error: string; stack?: string }[] = [];
    for (const text of readFileSync(file, "utf8").split("\n")) {
      if (!text) continue;
      try {
        const e = JSON.parse(text) as { error?: unknown; stack?: unknown };
        out.push({ error: String(e.error), stack: typeof e.stack === "string" ? e.stack : undefined });
      } catch {
        problems.push(`errors.log holds a line that is not JSON: ${text.slice(0, 200)}`);
      }
    }
    return out;
  }

  /**
   * Checks every call so far against what the spool and the data dir hold, and returns the problems found
   * (empty when none). `allow` lists other files a case made itself, relative to the root.
   */
  async check(opts: { allow?: (file: string) => boolean } = {}): Promise<string[]> {
    const problems = [...this.problems];
    const stored = await this.stored();
    const want = new Map<string, Call[]>();
    for (const c of this.calls) if (c.expected) want.set(c.expected.dir, [...(want.get(c.expected.dir) ?? []), c]);
    const rawFiles = new Set<string>();
    for (const dir of new Set([...want.keys(), ...stored.keys()])) {
      const calls = want.get(dir) ?? [];
      const lines = stored.get(dir) ?? [];
      if (calls.length !== lines.length) problems.push(`spool/${dir}: ${lines.length} lines, expected ${calls.length} (${calls.slice(lines.length, lines.length + 1).map((c) => c.label).join("") || "an extra line"})`);
      for (let i = 0; i < Math.min(calls.length, lines.length); i++) {
        const c = calls[i]!;
        const s = lines[i]!;
        const problem = checkStored(c, s, dir, this.spool);
        if (problem) problems.push(`${c.label}: ${problem}`);
        if (s.rawPath) rawFiles.add(s.rawPath);
      }
    }
    const errors = this.calls.flatMap((c) => c.errors.map((error) => ({ label: c.label, error })));
    const logged = this.logged(problems);
    for (let i = 0; i < Math.max(errors.length, logged.length); i++) {
      const w = errors[i];
      const g = logged[i];
      if (!g) problems.push(`${w!.label}: errors.log lacks an entry starting ${JSON.stringify(w!.error)}`);
      else if (!w) problems.push(`errors.log has an entry no call expects: ${JSON.stringify(g.error).slice(0, 300)}\n${g.stack ?? ""}`);
      else if (!g.error.startsWith(w.error)) problems.push(`${w.label}: errors.log has ${JSON.stringify(g.error).slice(0, 300)}, expected an entry starting ${JSON.stringify(w.error)}\n${g.stack ?? ""}`);
      else continue;
      break;
    }
    const ids = this.calls.flatMap((c) => (c.disabledId ? [`${c.disabledId}\n`] : []));
    const sessionsFile = join(this.spool, "disabled-sessions");
    const sessions = existsSync(sessionsFile) ? readFileSync(sessionsFile, "utf8") : undefined;
    if (sessions !== (ids.length ? ids.join("") : undefined)) problems.push(`spool/disabled-sessions holds ${JSON.stringify(sessions)}, expected ${JSON.stringify(ids.join("") || undefined)}`);
    for (const file of this.files()) {
      const ok =
        /^csh\/spool\/[^/]+\/(\d{4}-\d{2}-\d{2}(\.\d+|\.p\d+)?\.jsonl|raw\/[^/]+\.json)$/.test(file) ||
        ["csh/spool/.ingest.pending", "csh/spool/disabled-sessions", "csh/spool/errors.log"].includes(file) ||
        opts.allow?.(file);
      if (!ok) problems.push(`the hook left ${file}`);
      if (/^csh\/spool\/[^/]+\/raw\//.test(file) && !rawFiles.has(resolve(this.root, file))) problems.push(`side file ${file} is named by no line`);
    }
    return problems;
  }

  /** Removes the root. Calls so far are forgotten. */
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The first offset where two strings differ, for a failure message. */
function firstDiff(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Why a stored line is not the call's, or undefined when it is. */
function checkStored(c: Call, s: Stored, dir: string, spool: string): string | undefined {
  const line: Record<string, unknown> = { ...s.line };
  const extra = Object.keys(line).filter((k) => k !== "ts" && k !== "rawFile" && !(LINE_KEYS as readonly string[]).includes(k));
  if (extra.length) return `the line has fields the contract does not: ${extra.join(", ")}`;
  if (typeof line.ts !== "number" || line.ts < c.t0 || line.ts > c.t1) return `ts ${line.ts} is outside the call (${c.t0}..${c.t1})`;
  const expected = c.expected!;
  const got = { ...line };
  if (line.rawFile !== undefined) {
    if ("raw" in line) return "the line holds both raw and rawFile";
    if (s.rawPath === undefined || s.rawText === undefined) return `rawFile ${line.rawFile} cannot be read`;
    if (dirname(s.rawPath) !== resolve(spool, dir, "raw")) return `rawFile ${line.rawFile} is outside spool/${dir}/raw`;
    if (expected.rawText !== undefined) {
      if (s.rawText !== expected.rawText) return `the side file differs from the payload at offset ${firstDiff(s.rawText, expected.rawText)} (${s.rawText.length} and ${expected.rawText.length} characters)`;
      got.raw = undefined;
    } else {
      got.raw = parseOr(s.rawText);
      const inline = Buffer.byteLength(JSON.stringify({ ...line, rawFile: undefined, raw: got.raw }));
      if (!expected.long && inline <= MAX_INLINE_LINE_BYTES) return `the payload went to a side file, but the line fits inline (${inline} bytes)`;
    }
  } else if (expected.long) return `a payload of more than ${MAX_INLINE_LINE_BYTES} bytes is inline, where the hook never parsed it (the line ${"raw" in line ? "holds" : "lacks"} raw)`;
  else if (s.bytes > MAX_INLINE_LINE_BYTES) return `an inline line of ${s.bytes} bytes, over ${MAX_INLINE_LINE_BYTES}`;
  got.raw = got.raw === undefined ? undefined : JSON.parse(JSON.stringify(got.raw));
  const want = expected.line;
  if (comparable(got) === comparable(want)) return undefined;
  try {
    const { ts: _ts, rawFile: _rf, ...rest } = got;
    assert.deepStrictEqual(rest, want);
  } catch (e) {
    return (e as Error).message.slice(0, 1500);
  }
  return `the fields differ in order only: ${comparable(got).slice(0, 300)}`;
}

/** Length of the common prefix of two buffers. */
function commonPrefix(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * At bound 0 a payload of n bytes is cut to its first k bytes for k = 0, 1, n/2, n - 1, n, 1023 and 1024
 * (where the hook stops parsing), and every SAMPLE-th k.
 */
const SAMPLE = 13;

/** The prefix lengths past `shared` of a payload of n bytes that `bound` checks, ascending. */
function prefixCuts(n: number, shared: number, bound: number): number[] {
  const ks: number[] = [];
  for (let k = shared + 1; k <= n; k++) {
    if (bound >= 1 || k <= 1 || k === n >> 1 || k >= n - 1 || k === MAX_INLINE_LINE_BYTES || k === MAX_INLINE_LINE_BYTES + 1 || k % SAMPLE === 0) ks.push(k);
  }
  return ks;
}

/**
 * The truncation check, on the fixtures of one shard: each payload cut to its first k bytes, for the k a
 * `bound` (CODING_SH_MODEL_BOUND) gives. At bound 0 those are the ones SAMPLE names; at 1 or more, every
 * k from 0 to n; at a bound b of 2 or more, each run of 1 to b - 1 bytes deleted at every offset as well.
 * Cuts no longer than the prefix an earlier payload of the same agent and event shares are skipped: at
 * bound 1 or more that payload ran each of them, and at bound 0 it ran the ones SAMPLE names for its own
 * length. Fixture files go to `shards` shards, balanced by the time their calls take at bound 1 (largest
 * first, each to the shard with the least so far): a prefix too long to inline writes a side file, which
 * takes about twice as long as a call that does not.
 */
export async function checkTruncations(shard: number, shards: number, bound: number): Promise<{ calls: number; payloads: number }> {
  const all = fixturePayloads();
  const sizes = new Map<string, number>();
  const cost = (n: number) => Math.min(n, MAX_INLINE_LINE_BYTES) + 1 + 2 * Math.max(0, n - MAX_INLINE_LINE_BYTES);
  for (const p of all) sizes.set(p.fixture, (sizes.get(p.fixture) ?? 0) + cost(p.bytes.length));
  const load = new Array<number>(shards).fill(0);
  const shardOf = new Map<string, number>();
  for (const [fixture, size] of [...sizes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const i = load.indexOf(Math.min(...load));
    shardOf.set(fixture, i);
    load[i]! += size;
  }
  const mine = all.filter((p) => shardOf.get(p.fixture) === shard);
  assert.ok(mine.length > 0, `shard ${shard + 1} of ${shards} has no fixtures`);
  const seen = new Map<string, Buffer[]>();
  const failures: string[] = [];
  let calls = 0;
  for (const p of mine) {
    const key = `${p.agent}\0${p.event}`;
    const earlier = seen.get(key) ?? [];
    seen.set(key, [...earlier, p.bytes]);
    // Prefixes 0..shared were run with an earlier payload of this agent and event.
    const shared = earlier.length ? Math.max(...earlier.map((b) => commonPrefix(b, p.bytes))) : -1;
    const inputs: [string, Buffer][] = [];
    for (const k of prefixCuts(p.bytes.length, shared, bound)) inputs.push([`first ${k} bytes`, p.bytes.subarray(0, k)]);
    for (let len = 1; len < bound; len++) {
      for (let at = 0; at + len <= p.bytes.length; at++) inputs.push([`${len} bytes deleted at ${at}`, Buffer.concat([p.bytes.subarray(0, at), p.bytes.subarray(at + len)])]);
    }
    if (!inputs.length) continue;
    const home = new HookHome();
    try {
      const argv = [p.agent, p.event];
      for (const [what, stdin] of inputs) await home.call(`${p.fixture}:${p.lineNo} ${what} ${preview(stdin)}`, argv, stdin);
      calls += inputs.length;
      const problems = await home.check();
      if (problems.length) failures.push(...problems.slice(0, 3));
    } finally {
      home.dispose();
    }
    if (failures.length >= 10) break;
  }
  assert.deepEqual(failures, [], `hook calls broke the contract:\n${failures.join("\n")}`);
  return { calls, payloads: mine.length };
}
