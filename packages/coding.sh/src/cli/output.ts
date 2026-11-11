// Output rules (https://vercel.com/design/cli):
// - stdout carries only the answer (bare ids, tables, one JSON document).
// - Everything else (progress, receipts, warnings, prompts, errors) is stderr.
// - --json: one document on stdout, stderr stays empty except a one-line JSON error.
// - Gutter: glyph (or space) at column 0, content at column 2; label/value rows
//   put the label in a 16-column field so values start at column 18.
// - Glyphs: ✓ done, ! warning, ✗ error, ? prompt. Plain mode keeps the glyphs
//   (they are text, not color) and drops color and spinners.
// - Color precedence: --no-color, NO_COLOR, FORCE_COLOR, then per-stream TTY.
import { cutToWidth, padToWidth, textWidth } from "../core/width.ts";
import { UsageError } from "./args.ts";

export const LABEL_WIDTH = 16;

export interface OutputOptions {
  json?: boolean;
  noColor?: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WriteStream | { write(s: string): unknown; isTTY?: boolean; columns?: number };
  stderr?: NodeJS.WriteStream | { write(s: string): unknown; isTTY?: boolean };
  stdin?: NodeJS.ReadStream | { isTTY?: boolean };
}

/** Operational failure (exit 1) with a machine reason and up to 2 recovery steps. */
export class CliError extends Error {
  readonly reason: string;
  readonly exitCode: number;
  readonly next: string[];
  readonly details: [string, string][];
  readonly data?: unknown;
  /** `next` is destructive, irreversible or paid: the user decides, not an agent (`askUser: true` in --json). */
  readonly askUser?: true;
  constructor(message: string, opts: { reason?: string; exitCode?: number; next?: string[]; details?: [string, string][]; data?: unknown; askUser?: boolean } = {}) {
    super(message);
    this.name = "CliError";
    this.reason = opts.reason ?? "error";
    this.exitCode = opts.exitCode ?? 1;
    this.next = (opts.next ?? []).slice(0, 2);
    this.details = opts.details ?? [];
    if (opts.data !== undefined) this.data = opts.data;
    if (opts.askUser) this.askUser = true;
  }
}

/** The line an error prints before a step that only the user may approve (askUser). */
export const ASK_USER = "The user must approve this first: ask them, and run it only once they agree.";

/** Ctrl-C at a prompt or during work: exit 130. */
export class Interrupted extends Error {
  constructor() {
    super("Canceled");
    this.name = "Interrupted";
  }
}

const CODES = { bold: [1, 22], faint: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], magenta: [35, 39], cyan: [36, 39] } as const;
export type Style = keyof typeof CODES;

export function colorEnabled(stream: { isTTY?: boolean } | undefined, env: NodeJS.ProcessEnv, noColor = false): boolean {
  if (noColor) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") return true;
  if (env.TERM === "dumb") return false;
  return stream?.isTTY === true;
}

// Strips C0/C1 control chars and bidi overrides from text we did not write (remote/agent text).
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
export function clean(s: string): string {
  return s.replace(UNSAFE, "");
}

export class Output {
  readonly json: boolean;
  readonly color: boolean;
  readonly errColor: boolean;
  /** Prompts allowed: stdin and stderr are TTYs, not --json, not CI. */
  readonly interactive: boolean;
  /** The help command for what is running (`coding.sh run --help`); errors with no next step point at it. */
  helpCommand?: string;
  readonly stdoutTTY: boolean;
  private readonly so: { write(s: string): unknown; isTTY?: boolean; columns?: number };
  private readonly se: { write(s: string): unknown; isTTY?: boolean };
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerText = "";

  constructor(opts: OutputOptions = {}) {
    const env = opts.env ?? process.env;
    this.so = opts.stdout ?? process.stdout;
    this.se = opts.stderr ?? process.stderr;
    const stdin = opts.stdin ?? process.stdin;
    this.json = opts.json ?? false;
    this.stdoutTTY = this.so.isTTY === true;
    this.color = !this.json && colorEnabled(this.so, env, opts.noColor);
    this.errColor = !this.json && colorEnabled(this.se, env, opts.noColor);
    const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false";
    this.interactive = !this.json && !ci && stdin.isTTY === true && this.se.isTTY === true;
  }

  style(s: string, style: Style, stream: "out" | "err" = "out"): string {
    const on = stream === "out" ? this.color : this.errColor;
    if (!on) return s;
    const [a, b] = CODES[style];
    return `\u001b[${a}m${s}\u001b[${b}m`;
  }

  // ------------------------------------------------------------ stdout (the answer)

  /** One line of the answer. Ignored in --json mode (the document is the answer). */
  print(line = ""): void {
    if (this.json) return;
    this.so.write(line + "\n");
  }

  /** The single JSON document (pretty on a TTY, compact otherwise). */
  data(doc: unknown): void {
    if (!this.json) return;
    this.so.write((this.stdoutTTY ? JSON.stringify(doc, null, 2) : JSON.stringify(doc)) + "\n");
  }

  /**
   * Borderless table: TTY gets aligned columns; non-TTY gets a header row and tab-separated values.
   * Widths are terminal cells (a CJK character takes two). On a narrow terminal, in this order:
   * long text columns shrink (widest first, to 8 cells), then the free-text columns (`collapse`, by
   * default TITLE and MATCH) are left out, then the rightmost other columns, and only then do short
   * columns such as AGENT and STARTED shrink. An id column (`keep`, by default ID and SESSION)
   * never shrinks: a cut id cannot be pasted into the next command.
   * A terminal that reports no width (columns 0) counts as 120.
   */
  table(headers: readonly string[], rows: readonly (readonly string[])[], opts: { keep?: readonly string[]; collapse?: readonly string[] } = {}): void {
    if (this.json) return;
    if (!this.stdoutTTY) {
      this.so.write([headers, ...rows].map((r) => r.join("\t")).join("\n") + "\n");
      return;
    }
    const widths = headers.map((h, i) => Math.max(textWidth(h), ...rows.map((r) => textWidth(r[i] ?? ""))));
    const cols = this.so.columns || process.stdout.columns || 120;
    const upper = (xs: readonly string[]) => new Set(xs.map((h) => h.toUpperCase()));
    const keep = upper(opts.keep ?? ["ID", "SESSION"]);
    const collapse = upper(opts.collapse ?? ["TITLE", "MATCH"]);
    const fixed = headers.map((h) => keep.has(h.toUpperCase()));
    const shown = headers.map(() => true);
    const total = () => widths.reduce((a, w, i) => a + (shown[i] ? w + 2 : 0), 0) - 2;
    const SHORT = 12;
    const shrink = (ok: (j: number) => boolean) => {
      while (total() > cols) {
        let i = -1;
        for (let j = 0; j < widths.length; j++) if (shown[j] && !fixed[j] && ok(j) && widths[j]! > 8 && (i === -1 || widths[j]! > widths[i]!)) i = j;
        if (i === -1) return;
        widths[i] = widths[i]! - 1;
      }
    };
    shrink((j) => widths[j]! > SHORT);
    for (let j = 0; j < headers.length && total() > cols; j++) if (collapse.has(headers[j]!.toUpperCase()) && !fixed[j]) shown[j] = false;
    // Never the first column: the table must still say what each row is.
    for (let j = headers.length - 1; j > 0 && total() > cols; j--) if (shown[j] && !fixed[j] && shown.filter(Boolean).length > 2) shown[j] = false;
    shrink(() => true);
    const fit = (s: string, w: number) => padToWidth(cutToWidth(s, w), w);
    const last = shown.lastIndexOf(true);
    const line = (r: readonly string[], head = false) => {
      const text = r
        .map((c, i) => (!shown[i] ? undefined : i === last ? cutToWidth(c, widths[i]!) : fit(c, widths[i]!)))
        .filter((c) => c !== undefined)
        .join("  ");
      return head ? this.style(text, "bold") : text;
    };
    this.so.write([line(headers, true), ...rows.map((r) => line(r))].join("\n") + "\n");
  }

  // ------------------------------------------------------------ stderr (everything else)

  private err(line: string): void {
    if (this.json) return;
    this.stopSpinner();
    this.se.write(line + "\n");
  }

  /** Completed primary result. */
  ok(msg: string): void {
    this.err(`${this.style("✓", "green", "err")} ${msg}`);
  }

  /** Consequence and fix. */
  warn(msg: string): void {
    this.err(`${this.style("!", "yellow", "err")} ${msg}`);
  }

  fail(msg: string): void {
    this.err(`${this.style("✗", "red", "err")} ${msg}`);
  }

  /** Plain stderr line (receipts, notes, headings). */
  note(msg = ""): void {
    this.err(msg ? `  ${msg}` : "");
  }

  /** Label/value row: label at column 2 in a 16-column field, value at column 18. */
  row(label: string, value: string, glyph: "ok" | "warn" | "fail" | "none" = "none"): void {
    const g = glyph === "ok" ? this.style("✓", "green", "err") : glyph === "warn" ? this.style("!", "yellow", "err") : glyph === "fail" ? this.style("✗", "red", "err") : " ";
    this.err(`${g} ${formatLabel(label)}${value}`);
  }

  /** Next step: benefit, colon, then the command on its own line. */
  next(benefit: string, command: string): void {
    this.err("");
    this.err(`  ${benefit}:`);
    this.err(`    ${this.style(command, "cyan", "err")}`);
  }

  // ------------------------------------------------------------ progress

  /** Spinner naming the phase. Only on an interactive, colored stderr; otherwise one plain line. */
  spin(text: string): { stop(): void; update(text: string): void } {
    if (this.json) return { stop() {}, update() {} };
    if (!this.errColor || this.se.isTTY !== true) {
      this.se.write(`  ${text}\n`);
      return { stop() {}, update() {} };
    }
    this.stopSpinner();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    this.spinnerText = text;
    const draw = () => this.se.write(`\r${frames[i++ % frames.length]} ${this.spinnerText}\u001b[K`);
    draw();
    this.spinnerTimer = setInterval(draw, 80);
    this.spinnerTimer.unref?.();
    return { stop: () => this.stopSpinner(), update: (t: string) => void (this.spinnerText = t) };
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.se.write("\r\u001b[K");
  }

  // ------------------------------------------------------------ prompts

  /**
   * `? <question> (y/N)` on stderr (`(Y/n)` with defaultYes). Only call when
   * `interactive`; Ctrl-C or Escape throws Interrupted. An empty answer takes
   * the default (No unless defaultYes).
   */
  async confirm(question: string, opts: { defaultYes?: boolean } = {}): Promise<boolean> {
    if (!this.interactive) return false;
    const a = await this.question(`${question} ${opts.defaultYes ? "(Y/n)" : "(y/N)"} `);
    return opts.defaultYes ? !/^n(o)?$/i.test(a.trim()) : /^y(es)?$/i.test(a.trim());
  }

  /**
   * `? <question> (<default>)` on stderr; returns the trimmed answer, or the
   * default when it is empty. Only call when `interactive`; Ctrl-C throws Interrupted.
   */
  async ask(question: string, opts: { default?: string } = {}): Promise<string> {
    if (!this.interactive) return opts.default ?? "";
    const a = (await this.question(`${question}${opts.default ? ` (${opts.default})` : ""} `)).trim();
    return a || (opts.default ?? "");
  }

  private async question(prompt: string): Promise<string> {
    this.stopSpinner();
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.on("SIGINT", () => {
          process.stderr.write("\n");
          reject(new Interrupted());
        });
        rl.on("close", () => reject(new Interrupted()));
        rl.question(`${this.style("?", "cyan", "err")} ${prompt}`, resolve);
      });
    } finally {
      rl.removeAllListeners("close");
      rl.close();
    }
  }

  // ------------------------------------------------------------ errors

  /** A usage error's `next`: always [what it is, the command]; a close suggestion first, else the help to read. */
  private usageNext(e: UsageError): string[] {
    if (e.suggestion) return [e.askUser ? "With their approval:" : "Did you mean:", e.suggestion];
    if (e.reason === "unknown_command") return ["See the commands:", this.helpCommand ?? "coding.sh --help"];
    return [e.reason === "unknown_option" ? "See the options:" : "See the usage:", this.helpCommand ?? "coding.sh --help"];
  }

  /** `next` of a failure in --json: two lines, [what it is, the command], never empty. */
  private nextSteps(next: readonly string[] | undefined): string[] {
    if (!next?.length) return ["See what this command takes:", this.helpCommand ?? "coding.sh --help"];
    return next.length === 1 ? ["Next:", next[0]!] : next.slice(0, 2);
  }

  /** Prints an error (human: headline + details + recovery; --json: one line on stderr). */
  error(e: unknown, debug = false): number {
    this.stopSpinner();
    if (e instanceof UsageError) {
      if (this.json) {
        this.se.write(JSON.stringify({ status: "error", reason: e.reason, message: e.message, ...(e.askUser ? { askUser: true } : {}), next: this.usageNext(e) }) + "\n");
      } else {
        this.se.write(`${this.style("✗", "red", "err")} ${e.message}\n`);
        if (e.askUser) {
          this.se.write(`    ${ASK_USER}\n`);
          if (e.suggestion) this.se.write(`    With their approval: ${this.style(e.suggestion, "cyan", "err")}\n`);
        } else if (e.suggestion) this.se.write(`    Did you mean ${this.style(e.suggestion, "cyan", "err")}?\n`);
      }
      return 2;
    }
    if (e instanceof Interrupted) {
      if (this.json) this.se.write(JSON.stringify({ status: "error", reason: "canceled", message: "Canceled" }) + "\n");
      else this.se.write(`${this.style("✗", "red", "err")} Canceled\n`);
      return 130;
    }
    const ce = e instanceof CliError ? e : undefined;
    const message = ce ? ce.message : e instanceof Error ? `Failed to complete: ${e.message}` : `Failed to complete: ${String(e)}`;
    if (this.json) {
      const doc: Record<string, unknown> = { status: "error", reason: ce?.reason ?? "internal_error", message, ...(ce?.askUser ? { askUser: true } : {}), next: this.nextSteps(ce?.next) };
      if (ce?.data !== undefined) doc.data = ce.data;
      this.se.write(JSON.stringify(doc) + "\n");
    } else {
      this.se.write(`${this.style("✗", "red", "err")} ${message}\n`);
      for (const [k, v] of ce?.details ?? []) this.se.write(`  ${formatLabel(k)}${v}\n`);
      if (ce?.askUser) this.se.write(`    ${ASK_USER}\n`);
      for (const n of ce?.next ?? []) this.se.write(`    ${n}\n`);
      if (debug && e instanceof Error && e.stack) this.se.write(e.stack + "\n");
    }
    return ce?.exitCode ?? 1;
  }
}

export function formatLabel(label: string): string {
  return label.length >= LABEL_WIDTH ? label.slice(0, LABEL_WIDTH - 2) + "… " : label.padEnd(LABEL_WIDTH);
}

// ------------------------------------------------------------ formatting helpers

/** Plural: `1 session`, `3 sessions`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local wall-clock time: "Nov 6 14:02"; "Nov 6 2025" outside the current year. */
export function localTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() !== new Date(now).getFullYear()) return `${day} ${d.getFullYear()}`;
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * When something happened, for tables and rows: "12s ago", "3m ago", "5h ago"
 * under a day, then the local time ("Nov 6 14:02"). --json output keeps the
 * full ISO timestamp; this is for people, piped or not.
 */
export function ago(ts: number | undefined, opts: { now?: number } = {}): string {
  if (ts === undefined || !Number.isFinite(ts)) return "-";
  const now = opts.now ?? Date.now();
  const d = now - ts;
  if (d < 1e3) return "just now"; // includes small clock skew (a timestamp slightly in the future)
  if (d < 60e3) return `${Math.floor(d / 1e3)}s ago`;
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`;
  return localTime(ts, now);
}

/**
 * 850ms, 4.2s, 42s, 3m07s, 2h05m. Rounds the whole value to the unit shown
 * before splitting it, so a carry moves up a unit (119.6s is 2m00s, not 1m60s).
 */
export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-";
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  const m = Math.round(ms / 60e3);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function tokens(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 10e3 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** Decimal units. */
export function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

export function usd(n: number | undefined): string {
  return n === undefined ? "-" : `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
