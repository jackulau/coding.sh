// Fake OpenAI-compatible pairwise judge (POST /chat/completions, no streaming).
// It picks the response that equals the <expected> block. When both or neither
// match, it has no evidence and picks the first response shown: a judge with
// pure position bias on undecided pairs. Prints its port on stdout.
import { createServer } from "node:http";

const inner = (text, tag) => {
  const m = text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? m[1].trim() : undefined;
};

let calls = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    calls++;
    const user = JSON.parse(body).messages.find((m) => m.role === "user").content;
    const expected = inner(user, "expected");
    const r1 = inner(user, "response_1");
    const r2 = inner(user, "response_2");
    const ok1 = r1 === expected;
    const ok2 = r2 === expected;
    const winner = ok1 && !ok2 ? "1" : ok2 && !ok1 ? "2" : "1";
    const reason = ok1 !== ok2 ? `response ${winner} matches the expected answer` : "no clear difference; picked the first";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "fake-judge", choices: [{ message: { content: JSON.stringify({ winner, reason }) }, finish_reason: "stop" }] }));
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
process.on("SIGTERM", () => {
  process.stderr.write(`calls ${calls}\n`);
  server.close(() => process.exit(0));
});
