#!/usr/bin/env node
// Waits for a session to appear on a coding.sh server (docs/PRODUCTION.md §6).
//
//   node examples/production/wait-session.mjs --url U --key READ_KEY --session demo/j1 [--timeout-ms 5000]
//
// Polls GET /api/sessions/<id> every 250 ms with the read key as a Bearer token.
// Prints one JSON line, {"elapsedMs":n,"stats":{…}}, and exits 0 once the session
// exists. On timeout it prints {"elapsedMs":n,"timeout":true,…} and exits 1. A
// rejected key (401/403) fails at once with exit 1. Bad arguments exit 2.
// --key may be omitted for a loopback server that runs without read keys.
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
function usage(msg) {
  console.error(`wait-session: ${msg}\nusage: wait-session.mjs --url U [--key K] --session ID [--timeout-ms N]`);
  process.exit(2);
}

const url = arg("--url")?.replace(/\/+$/, "");
const key = arg("--key");
const session = arg("--session");
const timeoutMs = Number(arg("--timeout-ms") ?? 5000);
const POLL_MS = 250;
if (!url) usage("--url is required");
if (!session) usage("--session is required");
if (!Number.isFinite(timeoutMs) || timeoutMs < 0) usage("--timeout-ms must be a non-negative number");

const headers = key ? { authorization: `Bearer ${key}` } : {};
const target = `${url}/api/sessions/${encodeURIComponent(session)}`;
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = "no response yet";
for (;;) {
  try {
    const res = await fetch(target, { headers, signal: AbortSignal.timeout(Math.max(POLL_MS, 2000)) });
    const text = await res.text();
    if (res.ok) {
      const body = JSON.parse(text);
      const s = body.session ?? body;
      console.log(JSON.stringify({ elapsedMs: elapsed(), stats: s.stats ?? null }));
      process.exit(0);
    }
    if (res.status === 401 || res.status === 403) {
      // The key never fixes itself; don't spin until the timeout. Never echo the key.
      console.log(JSON.stringify({ elapsedMs: elapsed(), error: `HTTP ${res.status}: the read key was rejected` }));
      process.exit(1);
    }
    last = `HTTP ${res.status}`;
  } catch (err) {
    last = err?.cause?.code ?? err?.name ?? String(err);
  }
  const remaining = timeoutMs - elapsed();
  if (remaining <= 0) break;
  await sleep(Math.min(POLL_MS, remaining));
}
console.log(JSON.stringify({ elapsedMs: elapsed(), timeout: true, last }));
process.exit(1);
