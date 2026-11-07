// observe(client): records every model call an OpenAI or Anthropic client makes.
//
// The client is patched in place (its resource methods get an own-property
// wrapper) and returned. What the app sees is unchanged:
// - the same APIPromise comes back (withResponse / asResponse keep working);
//   the SDK only hooks the promise's own parse step, so nothing is read from
//   the response unless the app reads it, and asResponse() bodies stay unread;
// - streams are the same Stream objects; only their iterator is observed;
// - errors are rethrown as they are.
// One change, by contract: an OpenAI chat stream without stream_options gets
// stream_options.include_usage, and the usage-only chunk that adds is
// swallowed here, so the app's loop sees exactly the chunks it would have.
//
// Anthropic's messages.stream() calls messages.create({ stream: true }) on the
// same resource, so it is recorded through create (once).
import { currentCtx, type LlmCall, recordLlm, runInCtx } from "./context.ts";
import type { HeaderGetter } from "./gateway.ts";
import { requestInfo, resultFor, type Shape, streamAcc } from "./providers.ts";
import { errorMessage, isObj, nowMs } from "./util.ts";

const OBSERVED = Symbol.for("coding.sh.observed");

type AnyFn = (...args: unknown[]) => unknown;
type Obj = Record<PropertyKey, unknown>;

const isFn = (v: unknown): v is AnyFn => typeof v === "function";
const asObj = (v: unknown): Obj | undefined => (v !== null && (typeof v === "object" || typeof v === "function") ? (v as Obj) : undefined);

function defineOwn(target: Obj, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

/**
 * Wraps an OpenAI or Anthropic client so its model calls are recorded.
 * Unknown objects are returned untouched; wrapping twice is a no-op.
 */
export function observe<T>(client: T): T {
  const c = asObj(client);
  if (!c) return client;
  try {
    if (c[OBSERVED]) return client;
    const baseUrl = typeof c.baseURL === "string" ? c.baseURL : undefined;
    let wrapped = false;
    const completions = asObj(asObj(c.chat)?.completions);
    if (completions && isFn(completions.create)) wrapped = wrap(completions, "chat", "openai", baseUrl) || wrapped;
    const responses = asObj(c.responses);
    if (responses && isFn(responses.create)) wrapped = wrap(responses, "responses", "openai", baseUrl) || wrapped;
    const messages = asObj(c.messages);
    if (!completions && messages && isFn(messages.create)) wrapped = wrap(messages, "messages", "anthropic", baseUrl) || wrapped;
    if (wrapped) defineOwn(c, OBSERVED, true);
  } catch {
    // an exotic client shape: leave it alone
  }
  return client;
}

function wrap(resource: Obj, shape: Shape, provider: string, url: string | undefined): boolean {
  const orig = resource.create as AnyFn & { [OBSERVED]?: boolean };
  if (orig[OBSERVED]) return true;
  const wrapped = function (this: unknown, params: unknown, ...rest: unknown[]): unknown {
    const ctx = currentCtx();
    const start = nowMs();
    let call: Omit<LlmCall, "end" | "ok"> = { provider, start, url };
    let callParams = params;
    let swallow = false;
    try {
      const info = requestInfo(shape, params);
      call = { provider, start, url, requestModel: info.requestModel, input: info.input };
      if (shape === "chat" && info.stream && isObj(params) && params.stream_options == null) {
        callParams = { ...params, stream_options: { include_usage: true } };
        swallow = true;
      }
    } catch {
      // keep the caller's params
    }
    let p: unknown;
    try {
      p = runInCtx({ inClientCall: true }, () => orig.call(this, callParams, ...rest));
    } catch (err) {
      recordLlm({ ...call, end: nowMs(), ok: false, error: errorMessage(err) }, ctx);
      throw err;
    }
    // Response headers (gateway request ids), set before the value or error arrives.
    let headers: HeaderGetter | undefined;
    return observeResult(
      p,
      (value) => {
        if (isObj(callParams) && callParams.stream === true) observeStream(value, shape, swallow, { ...call, headers }, ctx);
        else recordLlm({ ...call, headers, ...resultFor(shape, value), end: nowMs() }, ctx);
      },
      (err) => recordLlm({ ...call, headers, end: nowMs(), ok: false, error: errorMessage(err) }, ctx),
      (h) => {
        headers = h;
      },
    );
  };
  defineOwn(wrapped as unknown as Obj, OBSERVED, true);
  defineOwn(resource, "create", wrapped);
  return true;
}

const quietly =
  <A extends unknown[]>(fn: (...a: A) => void) =>
  (...a: A): void => {
    try {
      fn(...a);
    } catch {
      // observation only
    }
  };

/**
 * Calls onValue/onError once the app consumes the result, and returns the
 * result itself. Observation attaches lazily, when the app first awaits it.
 * onHeaders gets the HTTP response headers first, when the result exposes them.
 */
export function observeResult<T>(p: T, onValue: (v: unknown) => void, onError: (e: unknown) => void, onHeaders?: (h: HeaderGetter) => void): T {
  const o = asObj(p);
  if (!o || !isFn(o.then)) {
    quietly(onValue)(p);
    return p;
  }
  let attached = false;
  const attach = (r: PromiseLike<unknown>) => {
    if (attached) return;
    attached = true;
    r.then(quietly(onValue), quietly(onError));
  };
  try {
    // Stainless clients (openai, @anthropic-ai/sdk): APIPromise routes then/catch/finally/withResponse
    // through its memoized parse(); hooking it never reads a body the app didn't ask for.
    if (isFn(o.parse) && isFn(o.asResponse)) {
      const parse = o.parse;
      defineOwn(o, "parse", function (this: unknown) {
        if (!attached && onHeaders) watchHeaders(o, onHeaders);
        const r = parse.call(this) as PromiseLike<unknown>;
        attach(r);
        return r;
      });
      return p;
    }
    const then = o.then;
    defineOwn(o, "then", function (this: unknown, a?: unknown, b?: unknown) {
      attach({ then: (x?: unknown, y?: unknown) => then.call(this, x, y) } as PromiseLike<unknown>);
      return then.call(this, a, b);
    });
  } catch {
    // not patchable: no record, the app is unaffected
  }
  return p;
}

/**
 * Reads the headers off a Stainless APIPromise's responsePromise (not
 * asResponse(), which can end the client's own tracing span early). Registered
 * before parse(), so the headers land before the parsed value does. Never
 * reads the body.
 */
function watchHeaders(o: Obj, onHeaders: (h: HeaderGetter) => void): void {
  const rp = asObj(o.responsePromise);
  if (!rp || !isFn(rp.then)) return;
  (rp as unknown as PromiseLike<unknown>).then(
    quietly((props: unknown) => {
      const h = asObj(asObj(asObj(props)?.response)?.headers);
      if (h && isFn(h.get)) onHeaders(h as unknown as HeaderGetter);
    }),
    () => {},
  );
}

/** Observes a provider Stream's iteration (the Stream object itself is returned as is). */
function observeStream(stream: unknown, shape: Shape, swallow: boolean, call: Omit<LlmCall, "end" | "ok">, ctx: ReturnType<typeof currentCtx>): void {
  const s = asObj(stream);
  if (!s) return;
  const acc = streamAcc(shape, swallow);
  let finished = false;
  const finish = (err?: unknown) => {
    if (finished) return;
    finished = true;
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
  };
  const observeIterator = (it: AsyncIterator<unknown>): AsyncIterator<unknown> & AsyncIterable<unknown> => ({
    async next(...args: [] | [unknown]) {
      for (;;) {
        let r: IteratorResult<unknown>;
        try {
          r = await it.next(...args);
        } catch (err) {
          finish(err);
          throw err;
        }
        if (r.done) {
          finish();
          return r;
        }
        let hide = false;
        try {
          hide = acc.push(r.value, nowMs());
        } catch {
          hide = false;
        }
        if (!hide) return r;
      }
    },
    async return(value?: unknown) {
      finish();
      return it.return ? it.return(value) : { done: true, value };
    },
    async throw(err?: unknown) {
      finish(err);
      if (it.throw) return it.throw(err);
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
  // Stainless Stream: [Symbol.asyncIterator], tee() and toReadableStream() all call this.iterator().
  if (isFn(s.iterator) && Object.prototype.hasOwnProperty.call(s, "iterator")) {
    const orig = s.iterator;
    s.iterator = function (this: unknown) {
      return observeIterator(orig.call(this) as AsyncIterator<unknown>);
    };
    return;
  }
  const iter = s[Symbol.asyncIterator];
  if (isFn(iter)) {
    defineOwn(s, Symbol.asyncIterator, function (this: unknown) {
      return observeIterator(iter.call(this) as AsyncIterator<unknown>);
    });
  }
}
