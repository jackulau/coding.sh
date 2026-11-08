// J1 / J4 (docs/PRODUCTION.md §7): a small Node app using the OpenAI SDK, observed by coding.sh.
//
//   CODING_SH_URL=http://127.0.0.1:4318 CODING_SH_INGEST_KEY=csh_ik_... \
//   OPENAI_BASE_URL=http://127.0.0.1:9999/v1 OPENAI_API_KEY=mock node app.mjs
//
// It runs one turn in session "j1": a plain call, a tool span, a streaming call and a plain call.
// Without CODING_SH_URL the SDK does nothing, and stdout is the same either way.
import OpenAI from "openai";
import { observe, span, trace } from "@codingdotsh/sdk";

// The line that attaches coding.sh. Everything else is the app as it was.
const openai = observe(new OpenAI());
const model = process.env.OPENAI_MODEL ?? "mock-gpt";
const session = process.env.SESSION_ID ?? "j1";

async function lookupOrder(id) {
  return { id, status: "shipped" };
}

await trace(
  "checkout",
  async () => {
    const first = await openai.chat.completions.create({ model, messages: [{ role: "user", content: "Where is order 42?" }] });
    console.log(first.choices[0].message.content);

    const order = await span("tool", "lookup_order", () => lookupOrder("42"), { input: { id: "42" } });
    console.log(`order ${order.id}: ${order.status}`);

    const stream = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: `Order ${order.id} is ${order.status}. Summarize.` }],
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
    console.log(text);

    const last = await openai.chat.completions.create({ model, messages: [{ role: "user", content: "Thanks!" }] });
    console.log(last.choices[0].message.content);
  },
  { sessionId: session, input: "Where is order 42?" },
);
// No flush needed: the SDK flushes on beforeExit. (Apps that call process.exit use `await shutdown()`.)
