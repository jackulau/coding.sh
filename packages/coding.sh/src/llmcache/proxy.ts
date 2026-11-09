// Record/replay proxy for model calls (exp run --record / --replay).
//
// One local server on 127.0.0.1:0 serves every case-trial of a run. Each
// case-trial gets a job: a 128-bit token in the base URL, so concurrent jobs
// never see each other's calls. The task points its SDK at the job's
// ANTHROPIC_BASE_URL / OPENAI_BASE_URL.
//
// - Only POSTs to /v1/messages, /v1/chat/completions and /v1/responses are
//   cached. Anything else (count_tokens, models) is forwarded uncounted.
// - Replay: a call takes the first unconsumed recorded entry with the same
//   key (llmCallKey) whose ordinal is <= until. The first miss switches the
//   job to live for good: every later call goes upstream. Only 2xx entries are
//   replayed. A missing source recording means fully live, with a warning.
// - Every job records (a replay too, so it can be a source itself). Live
//   responses, SSE included, are teed to the client unchanged as they arrive.
// - Request headers are never stored. Bodies go through the redactor, and the
//   job's own credentials are scrubbed out of them, before they are written.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { createRedactor, type Redactor } from "../core/redact.ts";
import { hostOf, isLoopbackHost } from "../otel/receiver.ts";
import { forwardHeaders, joinUpstream } from "../proxy/server.ts";
import { apiOf, type KeyOptions, llmCallKey, modelOf, providerOf } from "./key.ts";
import { entryBytes, type LlmEntry, type LlmUsage, LLM_ENTRY_VERSION, readRecording, recordingPath, storedBody, writeRecording } from "./store.ts";

export type LlmCacheMode = "record" | "replay";

export interface LlmUpstreams {
  anthropic: string;
  openai: string;
}

export const DEFAULT_LLM_UPSTREAMS: LlmUpstreams = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" };

export interface StartLlmCacheOptions {
  mode: LlmCacheMode;
  /** replay: the experiment whose recordings are served. */
  source?: string;
  /** replay: only recorded calls with ordinal <= until are served (call until+1 onward runs live). */
  until?: number;
  upstream?: Partial<LlmUpstreams>;
  /** The llm cache dir (paths(env).llmCache). */
  dir: string;
  /** Key options shared by the run (tools/model exclusion). */
  key?: Pick<KeyOptions, "excludeTools" | "excludeModel">;
  /** Default 127.0.0.1. Only loopback addresses are accepted. */
  host?: string;
  /** Default: the "secrets" redactor. */
  redactor?: Redactor;
  onWarn?: (message: string) => void;
}

export interface LlmJobOptions {
  /** The experiment being run: where this job's recording goes. */
  expId: string;
  caseId: string;
  trial: number;
  /** Placeholder name → run value for the key (see KeyOptions.normalize). */
  normalize?: Record<string, string | undefined>;
}

/** What one case-trial's model calls did (CaseRun.llm). */
export interface LlmStats {
  /** Cached-path calls made. */
  calls: number;
  /** Served from the source recording. */
  hits: number;
  /** Sent upstream. */
  live: number;
  /** Ordinal of the first live call of a replay (absent when every call hit, or when recording). */
  firstLiveOrdinal?: number;
  /** replay: the source had no recording for this case-trial, so every call ran live. */
  missingSource?: true;
  /** replay: live calls that failed (non-2xx or network), so the run could not execute past the boundary. */
  upstreamErrors?: number;
}

export interface LlmJob {
  readonly token: string;
  /** Base URL for Anthropic SDKs (they append /v1/messages). */
  readonly anthropicBaseUrl: string;
  /** Base URL for OpenAI SDKs (ends in /v1). */
  readonly openaiBaseUrl: string;
  /** ANTHROPIC_BASE_URL and OPENAI_BASE_URL for a child process. */
  readonly env: Record<string, string>;
  stats(): LlmStats;
  /** Waits for in-flight calls, writes the recording, and returns the stats. */
  close(): Promise<LlmStats>;
}

export interface LlmCache {
  readonly url: string;
  readonly port: number;
  readonly mode: LlmCacheMode;
  job(o: LlmJobOptions): Promise<LlmJob>;
  /** Closes every open job (writing their recordings) and the server. */
  close(): Promise<void>;
}

const jsonError = (status: number, message: string): string => JSON.stringify({ type: "error", error: { type: status >= 500 ? "api_error" : "invalid_request_error", message } });

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Token counts from any of the three APIs' usage objects (later fields win). */
function mergeUsage(into: LlmUsage, u: unknown): void {
  if (!u || typeof u !== "object") return;
  const o = u as Record<string, unknown>;
  const details = (k: string) => (o[k] && typeof o[k] === "object" ? (o[k] as Record<string, unknown>) : {});
  const set = (k: keyof LlmUsage, v: number | undefined) => {
    if (v !== undefined) into[k] = v;
  };
  set("inputTokens", num(o.input_tokens) ?? num(o.prompt_tokens));
  set("outputTokens", num(o.output_tokens) ?? num(o.completion_tokens));
  set("cacheReadTokens", num(o.cache_read_input_tokens) ?? num(details("prompt_tokens_details").cached_tokens) ?? num(details("input_tokens_details").cached_tokens));
  set("cacheWriteTokens", num(o.cache_creation_input_tokens));
}

function usageFrom(o: unknown, into: LlmUsage): void {
  if (!o || typeof o !== "object") return;
  const r = o as Record<string, unknown>;
  mergeUsage(into, r.usage);
  if (r.message && typeof r.message === "object") mergeUsage(into, (r.message as Record<string, unknown>).usage);
  if (r.response && typeof r.response === "object") mergeUsage(into, (r.response as Record<string, unknown>).usage);
}

/** Usage of a response body (JSON, or the data lines of an SSE stream). */
export function usageOf(body: string, sse: boolean): LlmUsage | undefined {
  const u: LlmUsage = {};
  try {
    if (!sse) usageFrom(JSON.parse(body), u);
    else {
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]" || !d.includes("usage")) continue;
        try {
          usageFrom(JSON.parse(d), u);
        } catch {
          // not JSON: skip
        }
      }
    }
  } catch {
    return undefined;
  }
  return Object.keys(u).length ? u : undefined;
}

const TOKEN_PATH = /^\/llm\/([0-9a-f]{32})(\/[^?]*)?(\?.*)?$/;

class JobState {
  readonly entries: LlmEntry[] = [];
  readonly consumed = new Set<number>();
  readonly secrets = new Set<string>();
  readonly inflight = new Set<Promise<void>>();
  ordinal = 0;
  hits = 0;
  live = 0;
  upstreamErrors = 0;
  firstLiveOrdinal: number | undefined;
  isLive: boolean;
  closed = false;
  readonly opts: LlmJobOptions;
  readonly source: readonly LlmEntry[] | undefined;
  readonly replay: boolean;
  constructor(opts: LlmJobOptions, source: readonly LlmEntry[] | undefined, replay: boolean) {
    this.opts = opts;
    this.source = source;
    this.replay = replay;
    this.isLive = !replay || source === undefined;
  }
  stats(): LlmStats {
    const s: LlmStats = { calls: this.ordinal, hits: this.hits, live: this.live };
    if (this.firstLiveOrdinal !== undefined) s.firstLiveOrdinal = this.firstLiveOrdinal;
    if (this.replay && this.source === undefined) s.missingSource = true;
    if (this.upstreamErrors) s.upstreamErrors = this.upstreamErrors;
    return s;
  }
  /** The credentials this job's requests carried, so they never reach a recording. */
  noteSecrets(req: IncomingMessage): void {
    for (const h of ["x-api-key", "authorization", "api-key", "proxy-authorization"]) {
      const v = req.headers[h];
      for (const s of Array.isArray(v) ? v : v ? [v] : []) {
        const bare = s.replace(/^(Bearer|Basic)\s+/i, "").trim();
        if (bare.length >= 8) this.secrets.add(bare);
        if (s.length >= 8) this.secrets.add(s);
      }
    }
  }
}

export async function startLlmCache(o: StartLlmCacheOptions): Promise<LlmCache> {
  const host = o.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error(`refusing to listen on ${host}: the llm cache forwards credentials; bind a loopback address`);
  if (o.mode === "replay" && !o.source) throw new Error("llm cache: replay needs a source experiment");
  if (o.until !== undefined && !(Number.isInteger(o.until) && o.until >= 0)) throw new RangeError(`until must be a non-negative integer (got ${o.until})`);
  const up: LlmUpstreams = { ...DEFAULT_LLM_UPSTREAMS, ...o.upstream };
  const redactor = o.redactor ?? createRedactor();
  const jobs = new Map<string, JobState>();
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  const until = o.until ?? Number.POSITIVE_INFINITY;

  /** A recorded body with secrets replaced. */
  const scrub = (job: JobState, e: Pick<LlmEntry, "body" | "bodyEncoding">): Pick<LlmEntry, "body" | "bodyEncoding" | "redacted"> => {
    if (e.bodyEncoding === "base64") {
      // Binary bodies are not redacted by rule, but never keep a credential.
      const text = Buffer.from(e.body, "base64").toString("latin1");
      return [...job.secrets].some((s) => text.includes(s)) ? { body: "", redacted: true } : e;
    }
    const out = scrubText(job, e.body);
    return out === e.body ? { body: e.body } : { body: out, redacted: true };
  };

  /** Text as a recording holds it: the redactor's rules, then the job's own credentials. */
  const scrubText = (job: JobState, text: string): string => {
    let out = redactor.string(text);
    for (const s of [...job.secrets].sort((a, b) => b.length - a.length)) if (out.includes(s)) out = out.split(s).join("[redacted:api-key]");
    return out;
  };

  const record = (job: JobState, e: Omit<LlmEntry, "v" | "body" | "bodyEncoding" | "redacted">, raw: Pick<LlmEntry, "body" | "bodyEncoding">) => {
    job.entries.push({ v: LLM_ENTRY_VERSION, ...e, ...scrub(job, raw) });
  };

  const providerFor = (rest: string, req: IncomingMessage): "anthropic" | "openai" =>
    /^\/v1\/(messages|complete)(\/|$)/.test(rest) || req.headers["anthropic-version"] !== undefined || req.headers["x-api-key"] !== undefined ? "anthropic" : "openai";

  /** Sends one request upstream; streams the response to the client and hands back the bytes. */
  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    body: Buffer | undefined,
    onDone: (r: { status?: number; contentType?: string; chunks: Buffer[]; error?: string; startedAt: number; endedAt: number }) => void,
  ) => {
    const startedAt = Date.now();
    const headers = forwardHeaders(req, target);
    if (body) {
      for (const k of Object.keys(headers)) if (/^(content-length|accept-encoding)$/i.test(k)) delete headers[k];
      headers["content-length"] = String(body.length);
      // Plain bytes, so what is recorded is what the client parses.
      headers["accept-encoding"] = "identity";
    }
    const mod = target.protocol === "https:" ? https : http;
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (r: { status?: number; contentType?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      onDone({ ...r, chunks, startedAt, endedAt: Date.now() });
    };
    const upReq = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: req.method ?? "GET",
        headers,
        agent: target.protocol === "https:" ? agents.https : agents.http,
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502;
        const contentType = typeof upRes.headers["content-type"] === "string" ? upRes.headers["content-type"] : undefined;
        const out: string[] = [];
        const raw = upRes.rawHeaders;
        for (let i = 0; i + 1 < raw.length; i += 2) if (!/^(connection|keep-alive|transfer-encoding)$/i.test(raw[i]!)) out.push(raw[i]!, raw[i + 1]!);
        res.writeHead(status, upRes.statusMessage ?? "", out);
        res.flushHeaders();
        upRes.on("data", (c: Buffer) => {
          // Client first; the copy is kept after.
          if (!res.write(c)) {
            upRes.pause();
            res.once("drain", () => upRes.resume());
          }
          if (body) chunks.push(c);
        });
        upRes.on("end", () => {
          res.end();
          done({ status, ...(contentType ? { contentType } : {}) });
        });
        upRes.on("aborted", () => {
          res.destroy();
          done({ status, error: "upstream closed the response early" });
        });
        upRes.on("error", (err) => {
          res.destroy();
          done({ status, error: err.message });
        });
      },
    );
    upReq.setNoDelay(true);
    upReq.on("error", (err) => {
      const msg = `${(err as NodeJS.ErrnoException).code ?? "error"}: ${err.message}`;
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end(jsonError(502, `coding.sh llm cache: upstream ${target.origin} unreachable (${msg})`));
      else res.destroy();
      done({ error: msg });
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        upReq.destroy();
        done({ error: "client closed the connection" });
      }
    });
    if (body) upReq.end(body);
    else req.pipe(upReq);
  };

  const handleCached = (job: JobState, req: IncomingMessage, res: ServerResponse, rest: string, query: string, body: Buffer): Promise<void> => {
    const api = apiOf(req.method ?? "", rest)!;
    const provider = providerOf(api);
    const ordinal = ++job.ordinal;
    const text = body.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = body;
    }
    // The key is taken from the request as a recording would hold it. A replayed reply is the
    // redacted one, so the agent's next request quotes "[redacted:…]" where the recorded run
    // quoted the raw text; keyed on the raw bytes, that request would miss and go live.
    let keyed = parsed;
    const scrubbed = scrubText(job, text);
    if (scrubbed !== text) {
      try {
        keyed = JSON.parse(scrubbed);
      } catch {
        // A redaction that breaks the JSON: key on the request as sent.
      }
    }
    const key = llmCallKey(api, keyed, { ...o.key, ...(job.opts.normalize ? { normalize: job.opts.normalize } : {}) });
    const model = modelOf(parsed);
    const base = { ordinal, provider, path: rest, key, ...(model ? { model } : {}) };
    if (!job.isLive && job.source) {
      const i = job.source.findIndex((e, j) => !job.consumed.has(j) && e.key === key && e.ordinal <= until && e.status >= 200 && e.status < 300);
      if (i >= 0) {
        job.consumed.add(i);
        job.hits++;
        const hit = job.source[i]!;
        const bytes = entryBytes(hit);
        const t0 = Date.now();
        res.writeHead(hit.status, { "Content-Type": hit.contentType ?? "application/json", "Content-Length": String(bytes.length), "x-coding-sh-llm-cache": "hit" });
        res.end(bytes);
        record(
          job,
          { ...base, status: hit.status, ...(hit.contentType ? { contentType: hit.contentType } : {}), startedAt: t0, latencyMs: hit.latencyMs, ...(hit.usage ? { usage: hit.usage } : {}), replayed: true },
          { body: hit.body, ...(hit.bodyEncoding ? { bodyEncoding: hit.bodyEncoding } : {}) },
        );
        return Promise.resolve();
      }
      // The first miss: this call and every later one run live.
      job.isLive = true;
    }
    job.live++;
    if (job.replay) job.firstLiveOrdinal ??= ordinal;
    let target: URL;
    try {
      target = joinUpstream(up[provider], `${rest}${query}`);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(jsonError(400, `coding.sh llm cache: bad path: ${(err as Error).message}`));
      if (job.replay) job.upstreamErrors++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      forward(req, res, target, body, (r) => {
        try {
          const ok = r.error === undefined && r.status !== undefined && r.status >= 200 && r.status < 300;
          if (!ok && job.replay) job.upstreamErrors++;
          if (r.error === undefined && r.status !== undefined) {
            const buf = Buffer.concat(r.chunks);
            const sse = /text\/event-stream/i.test(r.contentType ?? "");
            const usage = ok ? usageOf(buf.toString("utf8"), sse) : undefined;
            record(job, { ...base, status: r.status, ...(r.contentType ? { contentType: r.contentType } : {}), startedAt: r.startedAt, latencyMs: r.endedAt - r.startedAt, ...(usage ? { usage } : {}) }, storedBody(buf));
          }
        } finally {
          resolve();
        }
      });
    });
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (!isLoopbackHost(hostOf(req.headers.host ?? ""))) {
      req.resume();
      res.writeHead(403, { "Content-Type": "application/json" }).end(jsonError(403, "coding.sh llm cache: Host header is not a loopback address"));
      return;
    }
    const m = TOKEN_PATH.exec(req.url ?? "/");
    const job = m ? jobs.get(m[1]!) : undefined;
    if (!m || !job || job.closed) {
      req.resume();
      res.writeHead(404, { "Content-Type": "application/json" }).end(jsonError(404, "coding.sh llm cache: no open job for this URL"));
      return;
    }
    job.noteSecrets(req);
    const rest = m[2] || "/";
    const query = m[3] ?? "";
    let target: URL;
    if (!apiOf(req.method ?? "", rest)) {
      try {
        target = joinUpstream(up[providerFor(rest, req)], `${rest}${query}`);
      } catch (err) {
        req.resume();
        res.writeHead(400, { "Content-Type": "application/json" }).end(jsonError(400, `coding.sh llm cache: bad path: ${(err as Error).message}`));
        return;
      }
      const p = new Promise<void>((resolve) => forward(req, res, target, undefined, () => resolve()));
      job.inflight.add(p);
      void p.finally(() => job.inflight.delete(p));
      return;
    }
    const chunks: Buffer[] = [];
    const p = new Promise<void>((resolve) => {
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("error", () => resolve());
      req.on("end", () => {
        handleCached(job, req, res, rest, query, Buffer.concat(chunks)).then(resolve, (err: unknown) => {
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(jsonError(500, `coding.sh llm cache: ${(err as Error).message}`));
          resolve();
        });
      });
    });
    job.inflight.add(p);
    void p.finally(() => job.inflight.delete(p));
  };

  const server = http.createServer({ noDelay: true }, handler);
  server.on("upgrade", (_req, socket: Socket) => socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  server.on("clientError", (_err, socket: Socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  const closeJob = async (token: string, job: JobState): Promise<LlmStats> => {
    if (!job.closed) {
      while (job.inflight.size) await Promise.all([...job.inflight]);
      job.closed = true;
      jobs.delete(token);
      const file = recordingPath(o.dir, job.opts.expId, job.opts.caseId, job.opts.trial);
      try {
        await writeRecording(file, job.entries);
      } catch (e) {
        o.onWarn?.(`llm cache: couldn't write ${file}: ${(e as Error).message}`);
      }
    }
    return job.stats();
  };

  return {
    url,
    port,
    mode: o.mode,
    async job(jo) {
      // Throws early on a bad id or trial, before any call is made.
      recordingPath(o.dir, jo.expId, jo.caseId, jo.trial);
      let source: LlmEntry[] | undefined;
      if (o.mode === "replay") {
        source = await readRecording(recordingPath(o.dir, o.source!, jo.caseId, jo.trial));
        if (!source) o.onWarn?.(`llm cache: ${o.source} has no recording for case ${jo.caseId} trial ${jo.trial}; running it live`);
      }
      const token = randomBytes(16).toString("hex");
      const state = new JobState(jo, source, o.mode === "replay");
      jobs.set(token, state);
      const base = `${url}/llm/${token}`;
      return {
        token,
        anthropicBaseUrl: base,
        openaiBaseUrl: `${base}/v1`,
        env: { ANTHROPIC_BASE_URL: base, OPENAI_BASE_URL: `${base}/v1` },
        stats: () => state.stats(),
        close: () => closeJob(token, state),
      };
    },
    async close() {
      for (const [token, job] of [...jobs]) await closeJob(token, job);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      agents.http.destroy();
      agents.https.destroy();
    },
  };
}
