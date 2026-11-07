// observeFetch(fetch?): records LLM calls made over raw HTTP.
//
// Matches POSTs whose path ends in /chat/completions or /responses (OpenAI
// shape) or /messages (Anthropic shape), on any host: OpenAI, Anthropic, the
// Vercel AI Gateway (ai-gateway.vercel.sh), or any compatible server.
// The app gets the very same Response; the SDK reads a clone (a tee() of the
// body), so streaming bodies are observed as they arrive without being held.
// Calls made by a client wrapped with observe() are skipped here, so wrapping
// both never records a call twice.
import { track } from "./client.ts";
import { currentCtx, type LlmCall, recordLlm } from "./context.ts";
import { gatewayOf } from "./observe.ts";
import { requestInfo, resultFor, type Shape, streamAcc } from "./providers.ts";
import { errorMessage, isObj, nowMs, str } from "./util.ts";

const OBSERVED = Symbol.for("coding.sh.observed");

type Fetch = typeof fetch;

export function matchShape(url: string): Shape | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? "";
  }
  path = path.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/messages")) return "messages";
  return undefined;
}

function urlOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (isObj(input) || (typeof Request !== "undefined" && input instanceof Request)) return str((input as { url?: unknown }).url);
  return undefined;
}

function methodOf(input: unknown, init: RequestInit | undefined): string {
  return (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
}

const dec = new TextDecoder();

/** The request body as JSON, when it can be read without consuming what fetch will send. */
async function readBody(input: unknown, init: RequestInit | undefined): Promise<unknown> {
  const body = init?.body;
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) text = dec.decode(body);
  else if (body instanceof ArrayBuffer) text = dec.decode(new Uint8Array(body));
  else if (body == null && typeof Request !== "undefined" && input instanceof Request && input.body) text = await input.clone().text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Server-sent events → parsed JSON data payloads (non-JSON data such as [DONE] is skipped). */
async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parse = function* (block: string): Generator<unknown> {
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const d = data.join("\n");
    if (d === "[DONE]") return;
    try {
      yield JSON.parse(d);
    } catch {
      // not JSON: ignore
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        yield* parse(block);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield* parse(buf);
  } finally {
    reader.releaseLock();
  }
}

async function errorText(res: Response): Promise<string> {
  let detail = "";
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const e = j.error;
      detail = (isObj(e) ? str(e.message) : str(e)) ?? str(j.message) ?? "";
    } catch {
      detail = "";
    }
  } catch {
    detail = "";
  }
  return `HTTP ${res.status}${detail ? `: ${errorMessage(detail)}` : ""}`;
}

async function observeResponse(res: Response, shape: Shape, stream: boolean, call: Omit<LlmCall, "end" | "ok">, ctx: ReturnType<typeof currentCtx>): Promise<void> {
  if (!res.ok) {
    recordLlm({ ...call, end: nowMs(), ok: false, error: await errorText(res.clone()) }, ctx);
    return;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body) {
    recordLlm({ ...call, end: nowMs(), ok: true }, ctx);
    return;
  }
  const clone = res.clone();
  if (ct.includes("text/event-stream") || (stream && !ct.includes("json"))) {
    const acc = streamAcc(shape);
    let err: unknown;
    try {
      for await (const chunk of sseJson(clone.body!)) acc.push(chunk, nowMs());
    } catch (e) {
      err = e;
    }
    const r = acc.result();
    recordLlm(
      {
        ...call,
        ...r,
        ok: err === undefined && r.ok,
        error: err !== undefined ? errorMessage(err) : r.error,
        end: nowMs(),
        ttftMs: acc.firstTokenAt !== undefined ? acc.firstTokenAt - call.start : undefined,
      },
      ctx,
    );
    return;
  }
  let json: unknown;
  try {
    json = await clone.json();
  } catch (e) {
    recordLlm({ ...call, end: nowMs(), ok: false, error: errorMessage(e) }, ctx);
    return;
  }
  recordLlm({ ...call, ...resultFor(shape, json), end: nowMs() }, ctx);
}

/**
 * Returns a fetch that records LLM API calls. Pass the fetch to wrap
 * (default: the global fetch at the time of the call to observeFetch).
 */
export function observeFetch(f?: Fetch): Fetch {
  const inner = f ?? globalThis.fetch;
  if ((inner as unknown as Record<symbol, unknown>)[OBSERVED]) return inner;
  const observed = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const ctx = currentCtx();
    let shape: Shape | undefined;
    let url: string | undefined;
    try {
      url = urlOf(input);
      shape = !ctx?.inClientCall && url && methodOf(input, init) === "POST" ? matchShape(url) : undefined;
    } catch {
      shape = undefined;
    }
    if (!shape || !url) return inner(input, init);

    const start = nowMs();
    const provider = shape === "messages" ? "anthropic" : "openai";
    let call: Omit<LlmCall, "end" | "ok"> = { provider, start };
    let stream = false;
    try {
      const info = requestInfo(shape, await readBody(input, init));
      stream = info.stream;
      call = { provider, start, requestModel: info.requestModel, input: info.input, gateway: gatewayOf(url) };
    } catch {
      // unreadable body: record what the response says
    }
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (err) {
      recordLlm({ ...call, end: nowMs(), ok: false, error: errorMessage(err) }, ctx);
      throw err;
    }
    try {
      track(observeResponse(res, shape, stream, call, ctx));
    } catch {
      // clone() refused (body already used): no record
    }
    return res;
  } as Fetch;
  Object.defineProperty(observed, OBSERVED, { value: true });
  return observed;
}
