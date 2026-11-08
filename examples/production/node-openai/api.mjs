// A production-style HTTP API with coding.sh attached: one trace per request, grouped into the
// caller's conversation, with a tool span and a model call. Node's built-in http, no framework.
//
//   CODING_SH_URL=https://obs.example.com CODING_SH_INGEST_KEY=csh_ik_... CODING_SH_SERVICE=support-api \
//   OPENAI_BASE_URL=http://127.0.0.1:9999/v1 OPENAI_API_KEY=mock node api.mjs --port 8080
//   curl -s localhost:8080/chat -d '{"conversation_id":"c-1","message":"where is order 42?"}'
//
// The same three calls work in Express, Fastify, Hono or a Next.js route handler. On serverless,
// call `waitUntil(flush())` (or `await flush()`) before the function returns.
import { createServer } from "node:http";
import OpenAI from "openai";
import { observe, shutdown, span, trace } from "@codingdotsh/sdk";

const openai = observe(new OpenAI());
const model = process.env.OPENAI_MODEL ?? "mock-gpt";
const portArg = process.argv.indexOf("--port");
const port = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT ?? 8080);

async function lookupOrder(text) {
  const id = /\d+/.exec(text)?.[0];
  return id ? { id, status: "shipped" } : null;
}

async function chat({ conversation_id, message, user_id }) {
  return trace(
    "POST /chat",
    async () => {
      const order = await span("tool", "lookup_order", () => lookupOrder(message), { input: { message } });
      const r = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: `You are a support agent. Order: ${JSON.stringify(order)}` },
          { role: "user", content: message },
        ],
      });
      return r.choices[0].message.content ?? "";
    },
    { sessionId: conversation_id, userId: user_id, input: message },
  );
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404).end();
    return;
  }
  try {
    let body = "";
    for await (const c of req) body += c;
    const input = JSON.parse(body || "{}");
    if (typeof input.message !== "string") throw new Error("message is required");
    const reply = await chat(input);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply }));
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

server.listen(port, () => console.log(`listening on :${server.address().port}`));

// Send what is queued before the process goes away (deploys, Ctrl-C).
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    shutdown().finally(() => process.exit(0));
  });
}
