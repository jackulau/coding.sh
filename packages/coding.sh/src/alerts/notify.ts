// Sends one alert notification: a signed JSON POST to a webhook, or the same JSON
// on a command's stdin. Each delivery tries 3 times, waiting 1 s, then 2 s.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { redactUrl } from "../sinks/post.ts";
import type { AlertState, AlertTarget } from "./store.ts";

export const SIGNATURE_HEADER = "X-Coding-Sh-Signature";
/** When the POST was sent, in unix seconds. */
export const TIMESTAMP_HEADER = "X-Coding-Sh-Timestamp";
/** `sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`: with the timestamp, a receiver can refuse a replay. */
export const SIGNATURE_V2_HEADER = "X-Coding-Sh-Signature-V2";
export const DELIVERY_TRIES = 3;
const BACKOFF_MS = 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;

export interface AlertPayload {
  alert: string;
  state: AlertState;
  previous: AlertState;
  value: number | null;
  threshold: number;
  /** Only for an alert that fires below its threshold (--under). */
  direction?: "under";
  window: string;
  by?: { agent: string };
  /** ISO time of the check. */
  at: string;
  /** Sent by `coding.sh alert test`. */
  test?: true;
}

/** `sha256=<hex HMAC-SHA256 of the body>`, keyed with the alert's secret. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * The signing headers of one POST, made when it is sent. X-Coding-Sh-Signature
 * signs the body alone, as it always has, so it verifies a copy sent again at
 * any time; X-Coding-Sh-Signature-V2 signs `<timestamp>.<body>`, and a receiver
 * refuses a timestamp more than 5 minutes from its own clock.
 */
export function signatureHeaders(secret: string, body: string, nowMs = Date.now()): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  return { [SIGNATURE_HEADER]: signBody(secret, body), [TIMESTAMP_HEADER]: ts, [SIGNATURE_V2_HEADER]: signBody(secret, `${ts}.${body}`) };
}

/** What `alert add` and `monitor add --http` print under the secret they show once. */
export const SIGNING_NOTES: readonly string[] = [
  `Each POST carries ${SIGNATURE_V2_HEADER}: sha256=<HMAC-SHA256 of "<timestamp>.<body>", keyed with this secret>, with the timestamp in ${TIMESTAMP_HEADER} (unix seconds).`,
  `Refuse a timestamp more than 5 minutes from your clock. ${SIGNATURE_HEADER} signs the body alone and does not stop a replay.`,
];

export interface DeliverOptions {
  secret?: string;
  fetch?: typeof fetch;
  /** First wait between tries; doubles each time (default 1 s). */
  backoffMs?: number;
  timeoutMs?: number;
  /** Stops waiting and trying (serve shutting down). */
  signal?: AbortSignal;
}

export interface Delivery {
  ok: boolean;
  attempts: number;
  error?: string;
}

/** The target, for messages: a webhook URL without credentials or query. */
export function targetText(t: AlertTarget): string {
  return t.kind === "webhook" ? `webhook ${redactUrl(t.url)}` : `command ${t.command}`;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

async function postOnce(url: string, body: string, o: DeliverOptions): Promise<string | undefined> {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "coding.sh" };
  if (o.secret) Object.assign(headers, signatureHeaders(o.secret, body));
  const timeout = AbortSignal.timeout(o.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  try {
    const res = await (o.fetch ?? globalThis.fetch)(url, { method: "POST", headers, body, redirect: "manual", signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout });
    const text = await res.text().catch(() => "");
    if (res.status >= 200 && res.status < 300) return undefined;
    return `POST ${redactUrl(url)} → ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" ? `timed out after ${o.timeoutMs ?? WEBHOOK_TIMEOUT_MS}ms` : ((e.cause as Error | undefined)?.message ?? e.message);
    return `POST ${redactUrl(url)} failed: ${reason}`;
  }
}

/**
 * A failed command's stderr on one line of at most 200 characters: all of it when it fits, else
 * its first and last lines. cmd ("'x' is not recognized as an internal or external command,")
 * and PowerShell put the message first; a Python traceback puts it last.
 */
export function stderrLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const all = lines.join(" ");
  if (all.length <= 200 || lines.length < 2) return all.slice(0, 200);
  return `${lines[0]!.slice(0, 98)} … ${lines.at(-1)!.slice(0, 98)}`;
}

/** How much of a failed command's stderr is kept for its error: this much of its start, and of its end. */
const STDERR_KEEP = 2000;

function runOnce(command: string, body: string, o: DeliverOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    let head = "";
    let tail = "";
    let settled = false;
    const finish = (err: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err);
    };
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      return resolve(`command failed to start: ${(e as Error).message}`);
    }
    const ms = o.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill();
      finish(`command timed out after ${ms}ms`);
    }, ms);
    child.stderr!.on("data", (d: Buffer) => {
      if (head.length < STDERR_KEEP) head += d.toString();
      else tail = (tail + d.toString()).slice(-STDERR_KEEP);
    });
    child.on("error", (e) => finish(`command failed to start: ${e.message}`));
    child.on("close", (code) => {
      const line = stderrLine(tail ? `${head}\n${tail}` : head);
      finish(code === 0 ? undefined : `command exited ${code ?? "on a signal"}${line ? `: ${line}` : ""}`);
    });
    // A command that exits without reading stdin closes the pipe: that is not a failed delivery.
    child.stdin!.on("error", () => {});
    child.stdin!.end(body);
  });
}

/** Sends the payload to the target, up to 3 tries with backoff. Never throws. */
export async function deliver(target: AlertTarget, payload: AlertPayload, o: DeliverOptions = {}): Promise<Delivery> {
  const body = JSON.stringify(payload);
  let error: string | undefined;
  let attempts = 0;
  for (let i = 0; i < DELIVERY_TRIES; i++) {
    if (i > 0) {
      if (o.signal?.aborted) break;
      await wait((o.backoffMs ?? BACKOFF_MS) * 2 ** (i - 1), o.signal);
      if (o.signal?.aborted) break;
    }
    attempts++;
    error = target.kind === "webhook" ? await postOnce(target.url, body, o) : await runOnce(target.command, body, o);
    if (error === undefined) return { ok: true, attempts };
  }
  return { ok: false, attempts, error: error ?? "stopped" };
}
