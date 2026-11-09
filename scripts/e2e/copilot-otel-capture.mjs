#!/usr/bin/env node
// A real GitHub Copilot CLI run with OpenTelemetry on, to see the trace context its
// hooks get: every hook's stdin (and its TRACEPARENT/TRACESTATE env, if any) is
// written as a spool line, and the OTLP export goes to a local receiver that keeps
// each request. Pinned Copilot CLI from npm under a throwaway HOME, BYOK against the
// local stub model, offline. Output (paths scrubbed to /work/demo and /home/user):
//   <out>/hooks.spool.jsonl   one spool line per hook run (coding.sh's spool format)
//   <out>/otlp/<n>.json|.bin  each OTLP request body (JSON, or protobuf as sent)
//
//   node scripts/e2e/copilot-otel-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when hook lines were written.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { MODEL, startStub } from "./stub-model.mjs";

const PKG = "@github/copilot@1.0.107";
const EVENTS = ["sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "errorOccurred"];

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-copilot-otel-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
const copilotHome = join(home, ".copilot");
const spool = join(root, "hooks.spool.jsonl");
mkdirSync(project, { recursive: true });

// The hook: one spool line per run, with stdin parsed and the trace env kept.
const recorder = join(root, "rec.mjs");
writeFileSync(
  recorder,
  `import { appendFileSync, readFileSync } from "node:fs";
let raw = readFileSync(0, "utf8");
try { raw = JSON.parse(raw); } catch {}
const env = {};
for (const k of ["TRACEPARENT", "TRACESTATE", "traceparent", "tracestate"]) if (process.env[k]) env[k] = process.env[k];
const line = { v: 0, agent: "copilot-cli", event: process.argv[2], ts: Date.now(), pid: process.pid, ppid: process.ppid, cwd: process.cwd(), raw, ...(Object.keys(env).length ? { env } : {}) };
appendFileSync(${JSON.stringify(spool)}, JSON.stringify(line) + "\\n");
`,
);
const hooks = {};
for (const ev of EVENTS) hooks[ev] = [{ type: "command", bash: `node ${recorder} ${ev}`, timeoutSec: 10 }];
mkdirSync(join(copilotHome, "hooks"), { recursive: true });
writeFileSync(join(copilotHome, "hooks", "rec.json"), JSON.stringify({ version: 1, hooks }, null, 2));

// OTLP/HTTP receiver: keeps every request body.
const otlpDir = join(outDir, "otlp");
mkdirSync(otlpDir, { recursive: true });
let otlpN = 0;
const otlp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const json = /json/.test(req.headers["content-type"] ?? "");
    const signal = req.url.split("/").pop();
    writeFileSync(join(otlpDir, `${String(otlpN++).padStart(3, "0")}-${signal}.${json ? "json" : "bin"}`), json ? scrub(body.toString("utf8")) : body);
    res.writeHead(200, { "content-type": json ? "application/json" : "application/x-protobuf" });
    res.end(json ? "{}" : "");
  });
});
await new Promise((ok) => otlp.listen(0, "127.0.0.1", ok));
const otlpUrl = `http://127.0.0.1:${otlp.address().port}`;

const stub = await startStub({
  decide: (body) => {
    const done = (body.messages ?? []).some((m) => m.role === "tool");
    return done ? { text: "Done. I listed the files." } : { tool: { name: "bash", args: { command: "ls", description: "List files" } } };
  },
});
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|COPILOT|GITHUB|GH_|OTEL_|npm_config_|NPM_CONFIG_)/i.test(k)) env[k] = v;
Object.assign(env, {
  HOME: home,
  COPILOT_HOME: copilotHome,
  PATH: [join(prefix, "bin"), env.PATH].join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  COPILOT_PROVIDER_BASE_URL: `${stub.url}/v1`,
  COPILOT_PROVIDER_API_KEY: "stub",
  COPILOT_MODEL: MODEL,
  COPILOT_OFFLINE: "true",
  COPILOT_AUTO_UPDATE: "false",
  COPILOT_OTEL_ENABLED: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl,
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_BSP_SCHEDULE_DELAY: "100",
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;

function scrub(s) {
  return s.split(project).join("/work/demo").split(home).join("/home/user").split(root).join("/tmp/capture");
}

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`copilot ${execFileSync("copilot", ["--version"], { env, cwd: project }).toString().trim()}`);
  await new Promise((done, fail) => {
    const argv = ["-p", "list the files here", "--allow-all", "--no-ask-user", "--output-format=json", "--model", MODEL];
    const child = spawn("copilot", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", fail);
    child.on("exit", () => (clearTimeout(timer), done()));
  });
  // Give a batching exporter a moment to flush.
  await new Promise((ok) => setTimeout(ok, 2000));
  const lines = existsSync(spool) ? readFileSync(spool, "utf8") : "";
  writeFileSync(join(outDir, "hooks.spool.jsonl"), scrub(lines));
  const n = lines.split("\n").filter(Boolean).length;
  console.error(`${n} hook line(s), ${otlpN} OTLP request(s) in ${outDir}; ${stub.requests.length} model requests`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = n ? 0 : 1;
} finally {
  await stub.close();
  await new Promise((ok) => otlp.close(ok));
  if (!keep) rmSync(root, { recursive: true, force: true });
}
