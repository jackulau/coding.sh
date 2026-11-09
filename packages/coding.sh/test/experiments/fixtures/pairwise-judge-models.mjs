// Fake OpenAI-compatible pairwise judge whose answer depends on the model name
// (exp compare with several --pairwise judges, AB-13). Models starting with
// "wrong" pick the response that does not equal the <expected> block; every
// other model picks the one that does. No evidence either way is a tie.
// Prints its port on stdout.
import { createServer } from "node:http";

const inner = (text, tag) => {
  const m = text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? m[1].trim() : undefined;
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const j = JSON.parse(body);
    const user = j.messages.find((m) => m.role === "user").content;
    const expected = inner(user, "expected");
    const ok1 = inner(user, "response_1") === expected;
    const ok2 = inner(user, "response_2") === expected;
    const right = ok1 && !ok2 ? "1" : ok2 && !ok1 ? "2" : "tie";
    const winner = String(j.model).startsWith("wrong") ? (right === "1" ? "2" : right === "2" ? "1" : "tie") : right;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: JSON.stringify({ winner, reason: "fake" }) }, finish_reason: "stop" }] }));
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
