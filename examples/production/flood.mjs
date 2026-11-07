#!/usr/bin/env node
// Load generator for the backpressure and crash journeys (docs/PRODUCTION.md §6, J5/J7).
//
//   node examples/production/flood.mjs --url U --key INGEST_KEY --events N --batch B \
//     --sessions S [--seed X] [--concurrency C] [--retry] [--deadline-ms MS]
//
// Sends N `notification` events to POST /v1/ingest in batches of B from C
// concurrent workers. Event ids are derived from the seed (the same seed always
// sends the same ids, so a re-run is deduplicated by the server) and session ids
// cycle through s-0 … s-<S-1>.
//
// Without --retry every batch is sent once; a 429 (or any non-200) is counted and
// the batch is dropped. With --retry every non-200 and every network error is
// retried, waiting Retry-After seconds (1 s when absent) plus jitter, until the
// batch is acked or --deadline-ms (default 600000) passes. A rejected key
// (401/403) is never retried: the key won't fix itself, so every worker stops at
// once and the summary carries `error`.
//
// Prints one JSON line: {sent, acked, inserted, rejected, throttled, retryAfterSeen,
// other, requests, elapsedMs} (plus `error` when the key was rejected). `acked` counts events the server accepted in a 200
// (committed), `retryAfterSeen` summarizes the Retry-After of every 429.
// Exit 0, except: 1 with --retry when not every event was acked, 1 when the server
// never answered, 1 when the key was rejected, 2 on bad arguments. The key is never printed.
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
function usage(msg) {
  console.error(
    `flood: ${msg}\nusage: flood.mjs --url U --key K --events N --batch B --sessions S [--seed X] [--concurrency C] [--retry] [--deadline-ms MS]`,
  );
  process.exit(2);
}
function posInt(name, fallback) {
  const raw = arg(name) ?? fallback;
  if (raw === undefined) usage(`${name} is required`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) usage(`${name} must be a positive integer`);
  return n;
}

const url = arg("--url")?.replace(/\/+$/, "");
if (!url) usage("--url is required");
const key = arg("--key");
const total = posInt("--events");
const batchSize = posInt("--batch");
const sessions = posInt("--sessions");
const concurrency = posInt("--concurrency", "4");
const deadlineMs = posInt("--deadline-ms", "600000");
const seed = arg("--seed") ?? "0";
const retry = argv.includes("--retry");
if (batchSize > 10_000) usage("--batch must be at most 10000 (the server's per-request limit)");

const t0 = Date.now();
const batches = []; // request bodies
const counts = []; // events per batch
for (let start = 0; start < total; start += batchSize) {
  const events = [];
  for (let k = start; k < Math.min(total, start + batchSize); k++) {
    events.push({
      v: 0,
      id: createHash("sha256").update(`flood:${seed}:${k}`).digest("hex").slice(0, 32),
      sessionId: `s-${k % sessions}`,
      kind: "notification",
      ts: t0 + k,
      payload: { text: `flood ${seed} #${k}` },
    });
  }
  batches.push(JSON.stringify({ v: 0, service: "flood", events }));
  counts.push(events.length);
}

const headers = { "content-type": "application/json" };
if (key) headers.authorization = `Bearer ${key}`;

const stats = { sent: 0, acked: 0, inserted: 0, rejected: 0, throttled: 0, requests: 0, answered: 0 };
const retryAfter = [];
const other = {};
const bump = (k) => (other[k] = (other[k] ?? 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let authError = null; // set on the first 401/403; stops every worker

async function send(i) {
  stats.sent += counts[i];
  for (;;) {
    if (authError) return;
    stats.requests++;
    let waitS = 1;
    try {
      const res = await fetch(`${url}/v1/ingest`, { method: "POST", headers, body: batches[i], signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      stats.answered++;
      if (res.status === 200) {
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {}
        stats.acked += typeof body.accepted === "number" ? body.accepted : counts[i];
        stats.inserted += typeof body.inserted === "number" ? body.inserted : 0;
        stats.rejected += Array.isArray(body.rejected) ? body.rejected.length : 0;
        return;
      }
      if (res.status === 401 || res.status === 403) {
        bump(String(res.status));
        authError ??= `HTTP ${res.status}: the ingest key was rejected (does the server have CODING_SH_INGEST_KEYS with this key?)`;
        return;
      }
      const ra = res.headers.get("retry-after");
      if (res.status === 429) {
        stats.throttled++;
        retryAfter.push(ra);
      } else bump(String(res.status));
      if (ra && /^\d+$/.test(ra)) waitS = Math.max(1, Number(ra));
    } catch (err) {
      bump(err?.name === "TimeoutError" ? "timeout" : "network");
    }
    if (!retry) return;
    // Wait at least Retry-After; jitter upward so throttled workers don't return in lockstep.
    const waitMs = waitS * 1000 * (1 + Math.random() * 0.5);
    if (Date.now() - t0 + waitMs > deadlineMs) return;
    await sleep(waitMs);
  }
}

let next = 0;
async function worker() {
  while (next < batches.length && !authError) await send(next++);
}
await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

const ints = retryAfter.map((v) => (v !== null && /^\d+$/.test(v) ? Number(v) : NaN));
const out = {
  sent: stats.sent,
  acked: stats.acked,
  inserted: stats.inserted,
  rejected: stats.rejected,
  throttled: stats.throttled,
  retryAfterSeen: retryAfter.length
    ? { n: retryAfter.length, allIntGe1: ints.every((n) => Number.isInteger(n) && n >= 1), min: Math.min(...ints), max: Math.max(...ints) }
    : null,
  other,
  requests: stats.requests,
  elapsedMs: Date.now() - t0,
};
if (authError) out.error = authError;
console.log(JSON.stringify(out));
if (authError || stats.answered === 0) process.exit(1);
if (retry && stats.acked < total) process.exit(1);
