// Serve's logs: one line per event on stderr (stdout carries only the ready
// line), JSON by default when not on a TTY. Store URLs go through redactUrl and
// strings through the secret redactor, so keys and passwords never reach logs.
import { createRedactor } from "../core/redact.ts";
import { redactUrl } from "../sinks/post.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const redactor = createRedactor();

/** A store URL safe to print (no password, no query secrets). */
export const safeUrl = (url: string): string => redactUrl(url);

export function createLogger(o: { format: "json" | "text"; write?: (line: string) => void; now?: () => number } = { format: "json" }): Logger {
  const write = o.write ?? ((line: string) => process.stderr.write(line + "\n"));
  const now = o.now ?? Date.now;
  const clean = (v: unknown): unknown => (typeof v === "string" ? redactor.string(v) : v);
  const log = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    const f: LogFields = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = clean(v);
    try {
      if (o.format === "json") write(JSON.stringify({ ts: new Date(now()).toISOString(), level, msg: clean(msg), ...f }));
      else {
        const extra = Object.entries(f).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
        write(`${level === "info" ? "" : `${level}: `}${clean(msg)}${extra ? `  ${extra}` : ""}`);
      }
    } catch {
      // logging never fails the server
    }
  };
  return { log, info: (m, f) => log("info", m, f), warn: (m, f) => log("warn", m, f), error: (m, f) => log("error", m, f) };
}
