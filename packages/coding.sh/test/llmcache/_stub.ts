// A fake model API for the llm cache tests: Anthropic /v1/messages (JSON or
// SSE), OpenAI /v1/chat/completions, count_tokens, and a 500 on demand. Every
// reply carries a global counter, so a live call never repeats an earlier
// reply: identical outputs on replay prove the cache served them.
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** Not vendor-shaped, so no secret scanner trips on it; the proxy must still keep it out of recordings. */
export const API_KEY = ["cs", "test", "key", "0123456789abcdef"].join("-");

export interface Stub {
  url: string;
  /** Requests received, by path (count_tokens included). */
  hits: Map<string, number>;
  /** Requests to the cached paths. */
  calls(): number;
  /** Header sets received (to check credentials are forwarded). */
  headers: http.IncomingHttpHeaders[];
  close(): Promise<void>;
}

const lastUserText = (body: { messages?: { role: string; content: unknown }[] }): string => {
  const m = [...(body.messages ?? [])].reverse().find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content as { text?: string }[]).map((b) => b.text ?? "").join("");
};

export async function startStub(opts: { delayMs?: number } = {}): Promise<Stub> {
  let n = 0;
  const hits = new Map<string, number>();
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      headers.push(req.headers);
      const send = () => {
        if (path === "/v1/messages/count_tokens") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 42 }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { stream?: boolean; messages?: { role: string; content: unknown }[] };
        const said = lastUserText(body);
        if (said.includes("please-500")) {
          res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: `boom ${++n}` } }));
          return;
        }
        const reply = `reply ${++n} to ${said}${said.includes("echo-key") ? ` key=${req.headers["x-api-key"]}` : ""}`;
        if (path === "/v1/chat/completions") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `chat_${n}`, choices: [{ message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
          return;
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          const events = [
            ["message_start", { type: "message_start", message: { id: `msg_${n}`, usage: { input_tokens: 11, output_tokens: 1 } } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(0, 5) } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(5) } }],
            ["message_delta", { type: "message_delta", usage: { output_tokens: 7 } }],
            ["message_stop", { type: "message_stop" }],
          ] as const;
          let i = 0;
          const tick = () => {
            if (i >= events.length) return void res.end();
            const [ev, data] = events[i++]!;
            res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
            setTimeout(tick, 2);
          };
          tick();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text: reply }], usage: { input_tokens: 11, output_tokens: 7 } }));
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    headers,
    calls: () => (hits.get("/v1/messages") ?? 0) + (hits.get("/v1/chat/completions") ?? 0) + (hits.get("/v1/responses") ?? 0),
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export interface ScriptOpts {
  system?: string;
  /** The user text of call 2 (default "second"). */
  second?: string;
  /** Put cache_control on this message index of each call (default: the last). */
  cacheAt?: "last" | "first" | "none";
  stream?: boolean;
  /** Fire calls 2 and 3 at once, in this order (they do not depend on each other's replies). */
  parallel?: "forward" | "reversed";
}

const user = (text: string, cache: boolean) => ({ role: "user", content: cache ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : text });

async function call(base: string, body: unknown): Promise<{ status: number; text: string; bytes: Buffer }> {
  const res = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: bytes.toString("utf8"), bytes };
}

/** A 3-call agent: each call carries the conversation so far; returns the three raw replies. */
export async function threeCalls(base: string, o: ScriptOpts = {}): Promise<{ status: number; text: string; bytes: Buffer }[]> {
  const sys = o.system ?? "You are a test agent. Today is 2026-11-08.";
  const at = o.cacheAt ?? "last";
  const mk = (msgs: { role: string; text: string }[]) => ({
    model: "claude-test",
    max_tokens: 64,
    system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
    metadata: { user_id: `session-${Math.random()}` },
    ...(o.stream ? { stream: true } : {}),
    messages: msgs.map((m, i) => (m.role === "user" ? user(m.text, (at === "last" && i === msgs.length - 1) || (at === "first" && i === 0)) : { role: "assistant", content: m.text })),
  });
  const r1 = await call(base, mk([{ role: "user", text: "first" }]));
  const conv = [{ role: "user", text: "first" }, { role: "assistant", text: "ok" }];
  const second = [...conv, { role: "user", text: o.second ?? "second" }];
  const third = [...second, { role: "assistant", text: "ok" }, { role: "user", text: "third" }];
  if (o.parallel) {
    const [b2, b3] = [mk(second), mk(third)];
    if (o.parallel === "reversed") {
      const p3 = call(base, b3);
      await new Promise((r) => setTimeout(r, 20));
      const p2 = call(base, b2);
      const [x3, x2] = await Promise.all([p3, p2]);
      return [r1, x2, x3];
    }
    const p2 = call(base, b2);
    await new Promise((r) => setTimeout(r, 20));
    const p3 = call(base, b3);
    const [x2, x3] = await Promise.all([p2, p3]);
    return [r1, x2, x3];
  }
  const r2 = await call(base, mk(second));
  const r3 = await call(base, mk(third));
  return [r1, r2, r3];
}

export const tmp = (p = "cs-llmcache-"): string => mkdtempSync(join(tmpdir(), p));

/** Every recording file under dir, gunzipped. */
export function recordingTexts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".gz")) out.push(gunzipSync(readFileSync(p)).toString("utf8"));
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}
