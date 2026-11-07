#!/usr/bin/env node
// Tool-eval reference helper: calls one tool on the MCP server named by
// $MCP_SERVER_COMMAND (JSON-quoted argv) and prints the result, or one field.
//   node call.mjs <tool> '<json args>' [path.to.field]
import { spawn } from "node:child_process";

const [tool, rawArgs = "{}", path] = process.argv.slice(2);
const cmd = (process.env.MCP_SERVER_COMMAND ?? "").match(/"(?:[^"\\]|\\.)*"/g)?.map((s) => JSON.parse(s));
if (!tool || !cmd?.length) {
  process.stderr.write("usage: MCP_SERVER_COMMAND=... call.mjs <tool> '<json>' [path]\n");
  process.exit(2);
}
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
let buf = "";
const done = (code, out) => {
  if (out !== undefined) process.stdout.write(out + "\n");
  child.stdin.end();
  process.exitCode = code;
};
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(rawArgs) } });
    } else if (m.id === 2) {
      if (m.error) return done(1, `rpc error ${m.error.code}: ${m.error.message}`);
      if (m.result.isError) return done(1, m.result.content?.[0]?.text);
      let v = m.result.structuredContent;
      for (const k of path ? path.split(".") : []) v = v?.[/^\d+$/.test(k) ? Number(k) : k];
      return done(0, typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v));
    }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "call.mjs", version: "0" } } });
