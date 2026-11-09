// MCP stdio transport (§10): one JSON message per line on stdin/stdout,
// stderr kept (first 8 KB) for the tap. Shutdown: close stdin, wait 2 s,
// SIGTERM, wait 2 s, SIGKILL.
import type { ChildProcess } from "node:child_process";
import { spawn } from "../../core/spawn.ts";
import { trackChild } from "../../core/children.ts";
import { isRequest, isResponse, LineSplitter, RPC, type RpcNotification, type RpcRequest, type RpcResponse } from "./jsonrpc.ts";

export interface Transport {
  readonly kind: "stdio" | "http";
  request(msg: RpcRequest, o?: { timeoutMs?: number }): Promise<RpcResponse>;
  notify(msg: RpcNotification): Promise<void>;
  close(): Promise<void>;
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

const STDERR_MAX = 8 * 1024;

export interface StdioOpts {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Delay between shutdown steps (default 2000 ms). */
  graceMs?: number;
  onNotification?: (m: RpcNotification) => void;
  /** Server → client requests (sampling, elicitation, roots…). Default: ping only. */
  onRequest?: (m: RpcRequest) => Promise<RpcResponse>;
}

export class StdioTransport implements Transport {
  readonly kind = "stdio" as const;
  readonly child: ChildProcess;
  stderrHead = "";
  private readonly pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private readonly graceMs: number;

  constructor(command: string[], opts: StdioOpts = {}) {
    const [file, ...args] = command;
    if (!file) throw new Error("MCP stdio command is empty");
    this.graceMs = opts.graceMs ?? 2000;
    this.child = spawn(file, args, { cwd: opts.cwd, env: (opts.env ?? process.env) as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    trackChild(this.child);
    this.exitPromise = new Promise((resolve) => {
      const done = (why: string) => {
        if (this.exited) return;
        this.exited = true;
        for (const p of this.pending.values()) p.reject(new Error(`MCP server ${why}${this.stderrHead ? `: ${this.stderrHead.slice(-500)}` : ""}`));
        this.pending.clear();
        resolve();
      };
      this.child.on("exit", (code, sig) => done(`exited (${sig ?? code})`));
      this.child.on("error", (e) => done(`failed to start: ${e.message}`));
    });
    const lines = new LineSplitter();
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) =>
      lines.push(chunk, (line) => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // stdout must carry protocol only; ignore noise
        }
        if (isResponse(msg)) {
          const key = String(msg.id);
          const p = this.pending.get(key);
          if (p) {
            this.pending.delete(key);
            p.resolve(msg);
          }
        } else if (isRequest(msg)) {
          // Server → client requests (ping, sampling, roots…): the client's handlers, else ping only.
          if (opts.onRequest) {
            const req = msg;
            void opts.onRequest(req).then(
              (r) => this.write(r),
              (e: unknown) => this.write({ jsonrpc: "2.0", id: req.id, error: { code: RPC.INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) } }),
            );
          } else {
            const reply = msg.method === "ping" ? { jsonrpc: "2.0", id: msg.id, result: {} } : { jsonrpc: "2.0", id: msg.id, error: { code: RPC.METHOD_NOT_FOUND, message: `client does not support ${msg.method}` } };
            this.write(reply);
          }
        } else if (msg && typeof msg === "object") {
          opts.onNotification?.(msg as RpcNotification);
        }
      }),
    );
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      if (this.stderrHead.length < STDERR_MAX) this.stderrHead = (this.stderrHead + chunk).slice(0, STDERR_MAX);
    });
    this.child.stdin!.on("error", () => {}); // EPIPE after the server exits
  }

  private write(m: unknown): void {
    if (this.exited || !this.child.stdin!.writable) return;
    this.child.stdin!.write(JSON.stringify(m) + "\n");
  }

  request(msg: RpcRequest, o: { timeoutMs?: number } = {}): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new Error("MCP server is not running"));
    return new Promise((resolve, reject) => {
      const key = String(msg.id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(key, {
        resolve: (r) => {
          if (timer) clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      if (o.timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(key);
          this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: msg.id, reason: "timeout" } });
          reject(new TimeoutError(msg.method, o.timeoutMs!));
        }, o.timeoutMs);
      }
      this.write(msg);
    });
  }

  async notify(msg: RpcNotification): Promise<void> {
    this.write(msg);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const waitExit = (ms: number) => Promise.race([this.exitPromise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    this.child.stdin!.end();
    if (await waitExit(this.graceMs)) return;
    this.child.kill("SIGTERM");
    if (await waitExit(this.graceMs)) return;
    this.child.kill("SIGKILL");
    await this.exitPromise;
  }
}
