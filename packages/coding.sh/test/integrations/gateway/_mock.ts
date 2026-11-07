// Local stand-in for the AI Gateway REST API (GET /v1/generation, /v1/credits).
// Tests never call the real gateway.
import { createServer, type Server } from "node:http";

export const TEST_KEY = "vck_test_" + "0".repeat(24);

export interface MockGateway {
  url: string;
  /** Generation id → `data` object (snake_case, as the API returns). */
  generations: Map<string, Record<string, unknown>>;
  requests: { path: string; auth: string | undefined }[];
  /** Respond 500 echoing the auth header (to prove errors are scrubbed). */
  failWith500: boolean;
  close(): Promise<void>;
}

export async function startMockGateway(): Promise<MockGateway> {
  const m: Omit<MockGateway, "url" | "close"> = { generations: new Map(), requests: [], failWith500: false };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const auth = req.headers.authorization;
    m.requests.push({ path: url.pathname + url.search, auth });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (auth !== `Bearer ${TEST_KEY}`) return send(401, { error: { message: "Invalid API key" } });
    if (m.failWith500) return send(500, { error: { message: `upstream exploded for ${auth}` } });
    if (url.pathname === "/v1/credits") return send(200, { balance: "95.50", total_used: "4.50" });
    if (url.pathname === "/v1/generation") {
      const g = m.generations.get(url.searchParams.get("id") ?? "");
      return g ? send(200, { data: g }) : send(404, { error: { message: "Usage event not found" } });
    }
    send(404, { error: { message: "not found" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return Object.assign(m, {
    url: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as MockGateway;
}

export const generationData = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  total_cost: 0.0123,
  upstream_inference_cost: null,
  usage: 0.0123,
  created_at: "2026-11-06T10:00:00.000Z",
  model: "anthropic/claude-sonnet-4.5",
  is_byok: false,
  provider_name: "bedrock",
  streamed: true,
  finish_reason: "stop",
  latency: 420,
  generation_time: 2100,
  native_tokens_prompt: 1000,
  native_tokens_completion: 200,
  native_tokens_reasoning: 0,
  native_tokens_cached: 800,
  native_tokens_cache_creation: 0,
  billable_web_search_calls: 0,
  // Fields coding.sh must not keep:
  prompt: "SECRET PROMPT TEXT",
  ...over,
});
